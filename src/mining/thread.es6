#! /usr/bin/env node
/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
/* eslint-disable */
import type { Logger } from 'winston'
const process = require('process')
const { getExpFactorDiff, getNewPreExpDifficulty, getNewBlockCount, mine } = require('./primitives')
const { BlockchainHeaders, BlockchainHeader, BcBlock } = require('../protos/core_pb')
const ts = require('../utils/time').default // ES6 default export
const cluster = require('cluster')
const logging = require('../logger')
const fs = require('fs')

const globalLog: Logger = logging.getLogger(__filename)
// setup logging of unhandled rejections
process.on('unhandledRejection', (err) => {
  // $FlowFixMe
  globalLog.error(`Rejected promise, trace:\n${err.stack}`)
})


const activeWorkers = []
const queuedWorkers = []
const available = []

if (cluster.isMaster) {
  process.on('uncaughtError', (err) => {
    // $FlowFixMe
    globalLog.error(`Rejected promise, trace:\n${err.stack}`)
    for(let w in cluster.workers) {
       w.kill()
    }
    process.exit(3)
  })
  globalLog.info('--> pool controller reporting ' + process.pid)
  const cycleWorker = () => {
    const w = cluster.fork()
    w.on('message', (msg) => {
      const self = activeWorkers.pop()
      queuedWorkers.push(self)
      process.send({ pid: process.pid, type: 'solution', data: msg})
    })
    return w
  }
  process.on('message', (data) => {
    if(data.type === 'heartbeat'){
      globalLog.info('controller : ' + process.pid + ' heartbeat message recieved ')
      data.activeWorkers = activeWorkers.map((w) => {
        return w.pid
      })
      // includes the heartbeat and the id to let them know we are in
      process.send(data)
    } else if(data.type === 'reset') {
      globalLog.info('controller : ' + process.pid + ' reset message recieved ')
      for(let w in activeWorkers){
        w.kill()
      }
    } else if(data.type === 'work') {
      globalLog.info('controller ' + process.pid + ' reassigned worker to active queue ')
      if(queuedWorkers.length > 0){
        const w = queuedWorkers.pop()
        activeWorkers.push(w)
        w.send(data.data)
      } else {
        const w = cycleWorker()
        activeWorkers.push(w)
        w.send(data.data)
      }
    } else {
      console.log(data)
    }
  })

  cluster.on('exit', () => {
    globalLog.info('worker reassigned to passive queue')
    queuedWorkers.push(cycleWorker())
    globalLog.info('worker queue ' + queuedWorkers.length)
  })

  cycleWorker()

} else {
  /**
   * Miner woker entrypoin
   */
  const main = () => {
    process.title = 'bc-miner-worker'
    globalLog.debug('miner worker ' + process.pid + ' recieved work')

    process.on('message', ({currentTimestamp, offset, work, minerKey, merkleRoot, difficulty, difficultyData}) => {

      ts.offsetOverride(offset)
      // Deserialize buffers from parent process, buffer will be serialized as object of this shape { <idx>: byte } - so use Object.values on it
      const deserialize = (buffer: { [string]: number }, clazz: BcBlock|BlockchainHeader|BlockchainHeaders) => clazz.deserializeBinary(new Uint8Array(Object.values(buffer).map(n => parseInt(n, 10))))

			let marker = merkleRoot

			if(marker.constructor !== merkleRoot.constructor){
				marker = merkleRoot.toString()
			}
			globalLog.info('-----------------------------> ' + marker)
      // function with all difficultyData closed in scope and
      // send it to mine with all arguments except of timestamp and use it
      // each 1s tick with new timestamp
      const difficultyCalculator = function () {
        // Proto buffers are serialized - let's deserialize them
        const { lastPreviousBlock, newBlockHeaders } = difficultyData
        const lastPreviousBlockProto = deserialize(lastPreviousBlock, BcBlock)
        const newBlockHeadersProto = deserialize(newBlockHeaders, BlockchainHeaders)

        // return function with scope closing all deserialized difficulty data
        return function (timestamp: number) {
          const newBlockCount = getNewBlockCount(lastPreviousBlockProto.getBlockchainHeaders(), newBlockHeadersProto)

          // globalLog.info(`stale states: ${JSON.stringify(newBlockCount, null, 2)}`)

          const preExpDiff = getNewPreExpDifficulty(
            timestamp,
            lastPreviousBlockProto,
            newBlockCount
          )
          return getExpFactorDiff(preExpDiff, lastPreviousBlockProto.getHeight()).toString()
        }
      }

      try {
        const solution = mine(
          currentTimestamp,
          work,
          minerKey,
          merkleRoot,
          difficulty,
          difficultyCalculator()
        )

        // send solution and exit
        fs.readFile('.workermutex', 'utf8', (err, data) => {
          if(data !== merkleRoot){
            fs.writeFile('.workermutex', merkleRoot, (err) => {
              globalLog.info(`solution found: ${JSON.stringify(solution, null, 2)}`)
              process.send(solution)
            })
          } else {
            process.exit()
          }
        })
      } catch (e) {
        globalLog.warn(`Mining failed with reason: ${e.message}, stack ${e.stack}`)
        process.exit(1)
      }
    })
    const variableTimeout = 150000 + Math.floor(Math.random() * 10000)
    setTimeout(() => { process.exit() }, variableTimeout)
  }

  main()
}
