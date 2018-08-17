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
import type {
    Logger
} from 'winston'
const process = require('process')
const {
    getExpFactorDiff,
    getNewPreExpDifficulty,
    getNewBlockCount,
    mine
} = require('./primitives')
const {
    BlockchainHeaders,
    BlockchainHeader,
    BcBlock
} = require('../protos/core_pb')
const ts = require('../utils/time').default // ES6 default export
const cluster = require('cluster')
const logging = require('../logger')
const fs = require('fs')
const { mean, max } = require('ramda')
const BN = require('bn.js')
const ps = require('ps-node')
const fkill = require('fkill')
const minerRecycleInterval = 660000 + Math.floor(Math.random() * 10) * 10000
const globalLog: Logger = logging.getLogger(__filename)
// setup logging of unhandled rejections
//
//

const purgeWorkers = () => {
		return fkill('bc-miner-worker', { force: true })
}
process.on('uncaughtError', (err) => {
    // $FlowFixMe
    globalLog.error(`error, trace:\n${err.stack}`)
})
process.on('unhandledRejection', (err) => {
    // $FlowFixMe
    globalLog.error(`rejected promise, trace:\n${err.stack}`)
})

const settings = {
    maxWorkers: 2
}

const sendWorker = (worker, msg) => {
    return new Promise((resolve, reject) => {
        try {
            return worker.send(msg, resolve)
        } catch (err) {
            return reject(err)
        }
    })
}


if (cluster.isMaster) {

		const stats = []

		setInterval(() => {
				if(Object.keys(cluster.workers).length > 0){
					fkill('bc-miner-worker', { force: true })
					.then(() => {
						globalLog.info('global pool rebase success')
					})
					.catch((err) => {
						globalLog.debug(err.message)
					})
				}
		}, minerRecycleInterval)

    process.once("SIGTERM", () => {
        process.exit(0)
    })
    process.once("SIGINT", () => {
        process.exit(0)
    })
    process.once("exit", () => {
        globalLog.info('worker exited')
    })

    const active = []
    const record = {}
		/* eslint-disable */
		setInterval(() => {
			if(stats.length >= 5) {
				 const distancePerSecond = mean(stats) * 1000
         const workerLimit = settings.maxWorkers - 2
				 const distancePerRadianSecond = new BN(distancePerSecond).div(new BN(6.283)).toNumber()
				 const coreCountAdjustment = new BN(distancePerRadianSecond).mul(new BN(workerLimit)).toNumber()
				 const formattedMetric = Math.round(coreCountAdjustment * 100) / 100000

         if(formattedMetric !== undefined && formattedMetric > 0){
				   console.log('\r\n  ' + formattedMetric + ' kRAD/s -> radian distance collisions performance metric -> proof of distance miner\n\r')
         }
			} else if(stats.length > 0) {
			   console.log('\r\n  ' + 'sampling radian distance performance <- ' + stats.length + '/5\n\r')
			}
		}, 13500)
		/* eslint-enable */

  process.on('message', (data) => {
    const createThread = function () {
      const worker = cluster.fork()
      active.unshift(worker.id)
      return worker
    }

    const applyEvents = (worker) => {
      worker.once('message', (data) => {
        stats.unshift(new BN(data.data.iterations).div(new BN(data.data.timeDiff)).toNumber())
        if (stats.length > 10) { stats.pop() }
        process.send({
          type: 'solution',
          data: data.data,
          workId: data.workId
        }, () => {
          fkill('bc-miner-worker', { force: true }).then(() => {
            globalLog.info('pool rebase success')
          }).catch((err) => {
            globalLog.debug(err)
          })
          active.length = 0
        })
      })
      return worker
    }
    if (data.type === 'config') {
      settings.maxWorkers = data.maxWorkers || settings.maxWorkers
    } else if (data.type === 'work') {
      // expressed in Radians (cycles/second) / 2 * PI
      (async () => {
        if (active.length < (settings.maxWorkers - 1)) {
          const deploy = settings.maxWorkers - Object.keys(cluster.workers).length
          for (let i = 0; i < deploy; i++) {
            const worker = applyEvents(createThread())
            await sendWorker(worker, data.data)
          }
        } else {
          const ida = active.pop()
          if (cluster.workers[ida] !== undefined) {
            cluster.workers[ida].kill('SIGKILL')
          }
          let workerA = createThread()
          workerA = applyEvents(workerA)
          await sendWorker(workerA, data.data)
        }
      })()
        .catch((err) => {
          globalLog.error(err.message + ' ' + err.stack)
        })
    }
  })
  globalLog.info('pool controller ready ' + process.pid)
} else {
  /**
     * Miner woker entrypoin
     */
  const main = () => {
    process.title = 'bc-miner-worker'

    globalLog.info('worker ' + process.pid + ' ready')
    const variableTimeout = 120000 + Math.floor(Math.random() * 10000)
    setTimeout(() => {
      process.exit()
    }, variableTimeout)

    process.on('message', ({
      currentTimestamp,
      offset,
      work,
      minerKey,
      merkleRoot,
      difficulty,
      difficultyData,
      workId
    }) => {
      globalLog.debug('thread pool <- ' + process.pid + ' ' + workId + '                 ')

      ts.offsetOverride(offset)
      // Deserialize buffers from parent process, buffer will be serialized as object of this shape { <idx>: byte } - so use Object.values on it
      const deserialize = (buffer: {
                [string]: number
            }, clazz: BcBlock | BlockchainHeader | BlockchainHeaders) => clazz.deserializeBinary(new Uint8Array(Object.values(buffer).map(n => parseInt(n, 10))))

      // function with all difficultyData closed in scope and
      // send it to mine with all arguments except of timestamp and use it
      // each 1s tick with new timestamp
      const difficultyCalculator = function () {
        // Proto buffers are serialized - let's deserialize them
        const {
          lastPreviousBlock,
          newBlockHeaders
        } = difficultyData
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

        process.send({
          data: solution,
          workId: workId
        }, () => {
          globalLog.info(`solution found: ${JSON.stringify(solution, null, 0)}`)
          process.exit()
        })
      } catch (e) {
        globalLog.warn(`mining eailed with reason: ${e.message}, stack ${e.stack}`)
        process.exit(3)
      }
    })
  }

  main()
}
