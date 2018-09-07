/*
 * Copyright (c) 2017-present, Block Collider developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/* eslint-disable */
import type { Logger } from 'winston'
import type { PubSub } from '../engine/pubsub'
import type { RocksDb } from '../persistence'

const os = require('os')
const fs = require('fs')
const { fork, ChildProcess } = require('child_process')
const { writeFileSync } = require('fs')
const { resolve } = require('path')
const { inspect } = require('util')
const { config } = require('../config')
const { EventEmitter } = require('events')

const BN = require('bn.js')
const debug = require('debug')('bcnode:mining:officer')
const crypto = require('crypto')
const { repeat, mean, all, equals, flatten, fromPairs, last, range, values, max } = require('ramda')

const { prepareWork, prepareNewBlock, getUniqueBlocks } = require('./primitives')
const { getLogger } = require('../logger')
const { Block, BcBlock, BlockchainHeaders } = require('../protos/core_pb')
const { isDebugEnabled, ensureDebugPath } = require('../debug')
const { validateRoveredSequences, isValidBlock } = require('../bc/validation')
const { getBlockchainsBlocksCount } = require('../bc/helper')
const ts = require('../utils/time').default // ES6 default export

const MINER_WORKER_PATH = resolve(__filename, '..', '..', 'mining', 'thread.js')
const MIN_HEALTH_NET = process.env.MIN_HEALTH_NET === 'true'
const BC_MAX_WORKERS = process.env.BC_MAX_WORKERS

type UnfinishedBlockData = {
  lastPreviousBlock: ?BcBlock,
  block: ?Block,
  currentBlocks: ?{ [blokchain: string]: Block },
  iterations: ?number,
  timeDiff: ?number
}

const keyOrMethodToChain = (keyOrMethod: string) => keyOrMethod.replace(/^get|set/, '').replace(/List$/, '').toLowerCase()
// const chainToSet = (chain: string) => `set${chain[0].toUpperCase() + chain.slice(1)}List` // UNUSED
const chainToGet = (chain: string) => `get${chain[0].toUpperCase() + chain.slice(1)}List`

export class WorkerPool {
  _logger: Logger
  _session: string
  _minerKey: string
  _pubsub: PubSub
  _persistence: RocksDb
  _timers: Object
  _timerResults: Object
  _emitter: EventEmitter
  _workers: Object
  _maxWorkers: number
  _startupCheck: boolean
  _outbox: Object
  _pool: Object
  _heartbeat: Object

  _collectedBlocks: { [blockchain: string]: number }

  constructor (pubsub: PubSub, persistence: RocksDb, opts: { minerKey: string }) {
    let maxWorkers = os.cpus().length
		if(opts !== undefined && opts.maxWorkers !== undefined){
			maxWorkers = opts.maxWorkers
		}
    if(maxWorkers > 10) {
      maxWorkers = 10
    }
    if(BC_MAX_WORKERS !== undefined) {
      maxWorkers = Number(BC_MAX_WORKERS)
    }
    this._logger = getLogger(__filename)
    this._session = crypto.randomBytes(32).toString('hex')
    this._minerKey = opts.minerKey
    this._pubsub = pubsub
    this._persistence = persistence
    this._poolGuardPath = opts.poolguard || config.persistence.path + '/worker_pool_guard.json'
    this._maxWorkers = max(1, maxWorkers - 1)
    this._emitter = new EventEmitter()
    this._pool = {}
    this._startupCheck = false
    this._heartbeat = {}
    this._outbox = new EventEmitter()
    this._workers = {}
    fs.writeFileSync('.workermutex', "0")
  }

  get emitter (): EventEmitter {
    return this._emitter
  }

  get persistence (): RocksDb {
    return this._persistence
  }

  get pool (): Object {
    return this._pool
  }

  get pubsub (): PubSub {
    return this._pubsub
  }

  /*
   * Boot workers
   */
  async allRise (): Promise<*> {

    const pool: ChildProcess = fork(MINER_WORKER_PATH)
    pool.on('message', this._handlePoolMessage.bind(this))
    pool.on('error', this._handlePoolError.bind(this))
    pool.on('exit', this._handlePoolExit.bind(this))
    pool.send({ type: 'config', maxWorkers: this._maxWorkers })
    this._pool = pool

    this.emitter.emit('ready')
    return Promise.resolve(true)
  }

  allDismissed (): Promise<*> {
    return Promise.all(Object.keys(this._workers).map((w) => {
				return this.dismissWorker(this._workers[w])
		}))
  }

  _closeWaywardWorkers (staleWorkersObject: Object): Promise<*> {
     return Promise.all(
       Object.keys(staleWorkersObject).reduce((procs, pid) => {
          return new Promise((resolve, reject) => {
           ps.lookup({
             pid: pid,
             psargs: '-l'
           }, (err, results)  => {
              if(err) { reject(err) } else {
                 if(results.length < 1) {
                    return resolve(true)
                 } else {
                     const res = results[0]
                     ps.kil(res.pid, { signal: 'SIGKILL', timeout: 5, psargs: '-l'}, (err) => {
                        if(err) { reject(err) } else {
                          resolve(true)
                        }
                     })
                 }
              }
           })
          })
          return proces
       }, []))
  }
  _sendMessage (msg: Object): boolean {

    try {
      //if(this._workers[pid] !== undefined && this._workers[pid].connected){
        this._pool.send(msg);
      //}
    } catch (err) {
      this._logger.error(err);
      this._pool = this._scheduleNewPool()
      this._pool.once('online', () => {
        this._pool.send(msg);
      })
    }
		return true

	}

  updateWorkers (msg: Object): void {
	  this._sendMessage(msg)
  }

  async dismissWorker (worker: Object): boolean {
    if (worker === undefined) {
      return Promise.resolve(true)
    }
    const pid = worker.pid
    worker = this._workers[worker.pid]

    if (!worker) {
      return true
    }

    if (worker.connected) {
      try {
        worker.disconnect()
      } catch (err) {
        this._logger.info(`unable to disconnect workerProcess, reason: ${err.message}`)
      }
    }

    try {
      worker.removeAllListeners()
    } catch (err) {
      this._logger.info(`unable to remove workerProcess listeners, reason: ${err.message}`)
    }

    // $FlowFixMe
    if (worker !== undefined && worker.killed !== true) {
      try {
        worker.kill()
      } catch (err) {
        this._logger.info(`Unable to kill workerProcess, reason: ${err.message}`)
      }
    }

    if(this._workers[worker.pid]){
        delete this._workers[worker.pid]
    }

    return true

  }

  async _healthCheck (): boolean {
    try {
     let healthy = true
     Object.keys(this._workers).map((key) => {
       if(this._workers[key] === undefined) {
         healthy = false
       }
     })
     return healthy
    } catch(err) {
      this._logger.error(err)
    }
  }

  _messageId (pid: number) {
    return pid + '@' + crypto.randomBytes(16).toString('hex')
	}

  _scheduleNewPool () {
    const pool: ChildProcess = fork(MINER_WORKER_PATH)
    pool.on('message', this._handlePoolMessage.bind(this))
    pool.on('error', this._handlePoolError.bind(this))
    pool.on('exit', this._handlePoolExit.bind(this))
    this._pool = pool
    return pool
  }

  _handlePoolMessage (msg: Object) {

    /* eslint-disable */
    /*
     * { type: 'soloution',
     *   data: {
     *    distance: '',
     *    nonce: '',
     *    timestamp: ''
     *   },
     *   workId: '000000'
     * }
     *
     */
    if(msg === undefined) {
      // strange unrequested feedback from worker
      // definately throw and likely exit
      this._logger.warn('unable to parse message from worker pool')
    } else if (msg.type === 'solution') {
      // handle block
      if(msg.data !== undefined && msg.workId !== undefined){
				msg.data.workId = msg.workId
				this.emitter.emit('mined', msg.data)
			}
    }
  }

  _handlePoolError (msg: Object) {
		this._logger.error(msg)
    return true
  }

  _handlePoolExit (exitCode: Object) {
		// worker ahs exited
    const pool: ChildProcess = fork(MINER_WORKER_PATH)
    pool.on('message', this._handlePoolMessage.bind(this))
    pool.on('error', this._handlePoolError.bind(this))
    pool.on('exit', this._handlePoolExit.bind(this))
    this._pool = pool
    return true
  }

  sortBlocks (list: Object[]): Object[] {
    return list.sort((a, b) => {
      if (a.getHeight() < b.getHeight()) {
        return 1
      }
      if (a.getHeight() > b.getHeight()) {
        return -1
      }
      return 0
    })
  }
}
