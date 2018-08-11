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
const available = []

if (cluster.isMaster) {
  globalLog.info('worker online: ' + process.pid)
  const cycleWorker = () => {
    let prevWorker = false
    if(activeWorkers.length > 0){
       prevWorker = activeWorkers.pop()
       prevWorker.kill()
    }
    const w = cluster.fork()
    activeWorkers.push(w)
    w.on('message', (msg) => {
      process.send({ pid: process.pid, type: 'solution', data: msg})
    })
		fs.writeFileSync('.mutex_claim', 'override:'+process.pid)
    return w
  }
  process.on('message', (data) => {
    data.pid = process.pid
    if(data.type === 'heartbeat'){
      globalLog.info('controller : ' + process.pid + ' heartbeat message recieved ')
      data.activeWorkers = activeWorkers.map((w) => {
        return w.pid
      })
      // includes the heartbeat and the id to let them know we are in
      process.send(data)
    } else if(data.type === 'reset') {
      globalLog.info('controller : ' + process.pid + ' reset message recieved ')
      cycleWorker()
      data.pid = process.pid
      available.push(1)
      process.send(data)
    } else if(data.type === 'work') {
      globalLog.info('controller : ' + process.pid + ' work message recieved ')
      if(available.length > 0){
        available.pop()
        activeWorkers[0].send(data.data)
      } else {
        const worker = cycleWorker()
        worker.send(data.data)
      }
      // send back the id to let the controller know we got it
      process.send({ id: data.id })
    } else {
      console.log(data)
    }
  })

  cluster.on('exit', () => {
    globalLog.info('worker killed, respawning')
    cycleWorker()
  })

  cycleWorker()
  available.push(1)

  setTimeout(() => {
    process.exit()
  }, 55000)

} else {
  /**
   * Miner woker entrypoin
   */
  const main = () => {
    process.title = 'bc-miner-worker'
    globalLog.debug('miner recieved updated work')

    process.on('message', ({currentTimestamp, offset, work, minerKey, merkleRoot, difficulty, difficultyData}) => {

      ts.offsetOverride(offset)
      // Deserialize buffers from parent process, buffer will be serialized as object of this shape { <idx>: byte } - so use Object.values on it
      const deserialize = (buffer: { [string]: number }, clazz: BcBlock|BlockchainHeader|BlockchainHeaders) => clazz.deserializeBinary(new Uint8Array(Object.values(buffer).map(n => parseInt(n, 10))))

			let marker = merkleRoot

			if(marker.constructor !== merkleRoot.constructor){
				marker = merkleRoot.toString()
			}
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

        globalLog.info(`solution found: ${JSON.stringify(solution, null, 2)}`)

				fs.readFileSync('.mutex_claim', 'utf8', (err, data) {
					if(err) {
        		globalLog.info(err.message)
					} else {
						if(marker !== data){
        		  globalLog.info('no claim')
							process.send(solution)
						}
					}
				  process.exit(0)
				})
      } catch (e) {
        globalLog.warn(`Mining failed with reason: ${e.message}, stack ${e.stack}`)
        process.exit(1)
      }
    })
  }

  main()
}
