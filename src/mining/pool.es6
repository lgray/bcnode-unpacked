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
const LOW_HEALTH_NET = process.env.LOW_HEALTH_NET === 'true'

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
  _knownRovers: string[]
  _emitter: EventEmitter
  _workers: Object
  _maxWorkers: number
  _initialized: boolean
  _startupCheck: boolean
  _outbox: Object
  _heartbeat: Object

  _collectedBlocks: { [blockchain: string]: number }

  constructor (pubsub: PubSub, persistence: RocksDb, opts: { minerKey: string, rovers: string[] }) {
    let maxWorkers = os.cpus().length
		if(opts.maxWorkers !== undefined){
			maxWorkers = opts.maxWorkers
		}
    this._initialized = false
    this._logger = getLogger(__filename)
    this._session = crypto.randomBytes(32).toString('hex')
    this._minerKey = opts.minerKey
    this._pubsub = pubsub
    this._persistence = persistence
    this._knownRovers = opts.rovers
    this._poolGuardPath = opts.poolguard || config.persistence.path + '/worker_pool_guard.json'
    this._maxWorkers = max(1, maxWorkers - 1)
    this._emitter = new EventEmitter()
    this._startupCheck = false
    this._heartbeat = {}
    this._outbox = new EventEmitter()
    this._workers = {}
  }

  get persistence (): RocksDb {
    return this._persistence
  }

  get pubsub (): PubSub {
    return this._pubsub
  }

  async init (): boolean {
		this._initialized = true
    this._logger.info('work pool initialized with session ' + this._session)
		return true
  }

  /*
   * Boot workers
   */
  async allRise (): boolean {
    if (this._initialized === false) { throw new Error('pool must initialize before calling rise') }
    if (Object.keys(this._workers).length > 0) {
			this._logger.warn('unable to launch new worker pool if workers already exist')
			return false
		 }

    const workers = []
    for (let i = 0; i < this._maxWorkers; i++){
      const worker: ChildProcess = fork(MINER_WORKER_PATH)
      workers.push(worker)
	  }

    workers.forEach((worker) => {
      worker.on('message', this._handleWorkerMessage.bind(this))
      worker.on('error', this._handleWorkerError.bind(this))
      worker.on('exit', this._handleWorkerExit.bind(this))
      this._logger.info('launch -> ' + worker.pid)
			this._workers[worker.pid] = worker
    })

    this._emitter.emit('ready')
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
                     console.log('test: '+res)
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
  _sendMessage (pid: number, msg: Object): boolean {

    try {
      //if(this._workers[pid] !== undefined && this._workers[pid].connected){
        this._workers[pid].send(msg);
      //}
    } catch (err) {
      this.dismissWorker(this._workers[pid])
      this._logger.info(Object.keys(this._workers));
    }
		return true

	}

  _sendMessageAsync (pid: number, msg: Object): Promise<*> {

    const id = this._messageId(pid)

    try {
      this._workers[pid].send(msg)
    } catch (err) {
			this._logger.info(err.message)
			delete this._workers[pid]
    }

    const deferredPromise = new Promise((resolve, reject) => {
      this._emitter.once(id, (data) => {
        if(data !== undefined && data !== false){
          return resolve(data)
        }
       return resolve(false)
      })
    })

    this._outbox[id] = Math.floor(Date.now() * 0.001)

    return deferredPromise

  }

  updateWorkers (msg: Object): void {
		Object.keys(this._workers).forEach((pid) => {
			 this._sendMessage(pid, msg)
		})
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

  _scheduleNewWorker () {
    const worker: ChildProcess = fork(MINER_WORKER_PATH)
    worker.on('message', this._handleWorkerMessage.bind(this))
    worker.on('error', this._handleWorkerError.bind(this))
    worker.on('exit', this._handleWorkerExit.bind(this))
    this._workers[worker.pid] = worker
    return true
  }

  _handleWorkerMessage (msg: Object) {
    if(msg === undefined || msg.id === undefined) {
      // strange unrequested feedback from worker
      // definately throw and likely exit
    } else if (msg.type === 'solution') {
      // handle block
			this._emitter.emit('mined', msg.data)

    } else if (msg.type === 'heartbeat') {

      if(this._heartbeat[msg.pid] === undefined) {
				this._heartbeat[msg.pid] = Math.floor(Date.now() * 0.001)
			}

		  if(this._startupCheck === false){

				if(Object.keys(this._heartbeat).length > 0){
					this._startupCheck = true
          this._emitter.emit('ready')
			  }

			}

    } else if (this._outbox[msg.id] !== undefined) {
      this._logger.info('worker responded for ' + msg.id)
      delete this._outbox[msg.id]
      this._emitter.emit(msg.id, msg)
    } else {
      // message has no friends
    }
  }

  _handleWorkerError (msg: Object) {
		this._logger.error(msg)
  }

  _handleWorkerExit (exitCode: Object) {
		// worker ahs exited
    const worker: ChildProcess = fork(MINER_WORKER_PATH)
    worker.on('message', this._handleWorkerMessage.bind(this))
    worker.on('error', this._handleWorkerError.bind(this))
    worker.on('exit', this._handleWorkerExit.bind(this))
    this._workers[worker.pid] = worker
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
