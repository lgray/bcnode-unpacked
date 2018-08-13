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
process.once("SIGTERM", () => {
	process.exit(0)
})
process.once("SIGINT", () => {
	process.exit(0)
})
process.once("exit", () => {
	process.exit(0)
})

cluster.activeWorkers = []
cluster.queuedWorkers = []
cluster.previousHash = ""

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
  globalLog.info('pool controller ready ' + process.pid)


  cluster.on('exit', () => {
    globalLog.info('exit ' + process.pid + ' recieved work')
    cluster.fork().on('message', (msg) => {
        process.send({ type: 'solution', data: msg })
    })
  })

  process.on('message', (data) => {

    if(data.type === 'reset') {
      globalLog.info('pool controller <- ' + process.pid + ' <- reset message ' + Object.keys(cluster.workers).length)

      for(let w in cluster.workers){
        cluster.workers[w].kill()
      }
    } else if(data.type === 'work') {
      globalLog.info('pool controller ' + process.pid + ' <- work ')

      if(cluster.workers.length > 0){
        for(let w in cluster.workers){
            cluster.workers[w].send(data.data)
        }
      } else {
        const worker = cluster.fork()
        worker.once('online', () => {
            worker.send(data.data)
        })
        worker.on('message', (data) => {
            process.send({ type: 'solution', data: data, hash: data})
        })
      }

    } else {
      console.log(data)
    }

  })


} else {
  /**
   * Miner woker entrypoin
   */
  const main = () => {
    process.title = 'bc-miner-worker'

    globalLog.info('worker ' + process.pid + ' ready')
    const variableTimeout = 150000 + Math.floor(Math.random() * 10000)
    setTimeout(() => { process.exit() }, variableTimeout)

    process.on('message', ({currentTimestamp, offset, work, minerKey, merkleRoot, difficulty, difficultyData}) => {

    globalLog.info('miner worker ' + process.pid + ' recieved work')

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
        process.nextTick(() => {
          fs.readFile('.workermutex', 'utf8', (err, data) => {
            if(data !== undefined && data !== merkleRoot){

              fs.writeFile('.workermutex', merkleRoot, (err) => {
                globalLog.info(`solution found: ${JSON.stringify(solution, null, 2)}`)
                process.send(solution)
              })
            }
          })
        })
      } catch (e) {
        globalLog.warn(`Mining failed with reason: ${e.message}, stack ${e.stack}`)
        process.exit(3)
      }
    })
  }

  main()
}
