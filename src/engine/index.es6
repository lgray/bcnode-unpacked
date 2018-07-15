/*
 * Copyright (c) 2017-present, Block Collider developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Logger } from 'winston'
import type { BcBlock } from '../protos/core_pb'

const { PROTOCOL_PREFIX } = require('../p2p/protocol/version')
const debug = require('debug')('bcnode:engine')
const pull = require('pull-stream')
const { EventEmitter } = require('events')
const { queue } = require('async')
const { resolve } = require('path')
const { writeFileSync } = require('fs')
const { max } = require('ramda')
const LRUCache = require('lru-cache')
const BN = require('bn.js')
const semver = require('semver')
const request = require('request')

const { config } = require('../config')
const { ensureDebugPath } = require('../debug')
const { Multiverse } = require('../bc/multiverse')
const { getLogger } = require('../logger')
const { Monitor } = require('../monitor')
const { Node } = require('../p2p')
const { RoverManager } = require('../rover/manager')
const rovers = require('../rover/manager').rovers
const { Server } = require('../server/index')
const PersistenceRocksDb = require('../persistence').RocksDb
const { PubSub } = require('./pubsub')
const { RpcServer } = require('../rpc/index')
const { getGenesisBlock } = require('../bc/genesis')
const { BlockPool } = require('../bc/blockpool')
const { Block } = require('../protos/core_pb')
const { errToString } = require('../helper/error')
const { getVersion } = require('../helper/version')
const { MiningOfficer } = require('../mining/officer')
const ts = require('../utils/time').default // ES6 default export

const DATA_DIR = process.env.BC_DATA_DIR || config.persistence.path
const MONITOR_ENABLED = process.env.BC_MONITOR === 'true'
const PERSIST_ROVER_DATA = process.env.PERSIST_ROVER_DATA === 'true'

export class Engine {
  _logger: Logger
  _monitor: Monitor
  _knownBlocksCache: LRUCache<string, BcBlock>
  _rawBlocks: LRUCache<number, Block>
  _node: Node
  _persistence: PersistenceRocksDb
  _pubsub: PubSub
  _rovers: RoverManager
  _rpc: RpcServer
  _server: Server
  _emitter: EventEmitter
  _minerKey: string // TODO only needed because of server touches that - should be passed using constructor?
  _knownRovers: string[]
  _verses: Multiverse[]
  _rawBlock: Block[]
  _subscribers: Object
  _peerIsSyncing: boolean
  _peerIsResyncing: boolean
  _storageQueue: any
  _miningOfficer: MiningOfficer

  constructor (opts: { rovers: string[], minerKey: string}) {
    this._logger = getLogger(__filename)
    this._knownRovers = opts.rovers
    this._minerKey = opts.minerKey // TODO only needed because of server touches that - should be passed using constructor?
    this._rawBlock = []
    this._monitor = new Monitor(this, {})
    this._persistence = new PersistenceRocksDb(DATA_DIR)
    this._pubsub = new PubSub()
    this._node = new Node(this)
    this._rovers = new RoverManager()
    this._emitter = new EventEmitter()
    this._rpc = new RpcServer(this)
    this._server = new Server(this, this._rpc)
    this._subscribers = {}
    this._verses = []
    this._storageQueue = queue((fn, cb) => {
      return fn.then((res) => { cb(null, res) }).catch((err) => { cb(err) })
    })
    process.on('uncaughtError', function (err) {
      this._logger.error(err)
    })

    this._knownBlocksCache = LRUCache({
      max: config.engine.knownBlocksCache.max
    })

    this._rawBlocks = LRUCache({
      max: config.engine.rawBlocksCache.max
    })

    this._peerIsSyncing = false
    this._peerIsResyncing = false
    this._miningOfficer = new MiningOfficer(this._pubsub, this._persistence, opts)

    // Start NTP sync
    ts.start()
  }

  // TODO only needed because of server touches that - should be passed using constructor?
  get minerKey (): string {
    return this._minerKey
  }

  /**
   * Get multiverse
   * @returns {Multiverse|*}
   */
  get multiverse (): Multiverse {
    return this.node.multiverse
  }

  set multiverse (multiverse: Multiverse) {
    this.node.multiverse = multiverse
  }

  /**
   * Get blockpool
   * @returns {BlockPool|*}
   */
  get blockpool (): BlockPool {
    return this.node.blockpool
  }

  /**
   * Get pubsub wrapper instance
   * @returns {PubSub}
   */
  get pubsub (): PubSub {
    return this._pubsub
  }

  /**
   * Initialize engine internals
   *
   * - Open database
   * - Store name of available rovers
   */
  async init () {
    const self = this
    const roverNames = Object.keys(rovers)
    const { npm, git: { long } } = getVersion()
    const newGenesisBlock = getGenesisBlock()
    const versionData = {
      version: npm,
      commit: long,
      db_version: 1
    }
    const engineQueue = queue((fn, cb) => {
      return fn.then((res) => { cb(null, res) }).catch((err) => { cb(err) })
    })
    const DB_LOCATION = resolve(`${__dirname}/../../${this.persistence._db.location}`)
    const DELETE_MESSAGE = `Your DB version is old, please delete data folder '${DB_LOCATION}' and run bcnode again`
    // TODO get from CLI / config
    try {
      await this._persistence.open()
      try {
        let version = await this.persistence.get('appversion')
        if (semver.lt(version.version, '0.7.0')) {
          this._logger.warn(DELETE_MESSAGE)
          process.exit(8)
        }
      } catch (_) {
        // silently continue - the version is not present so
        // a) very old db
        // b) user just remove database so let's store it
      }
      let res = await this.persistence.put('rovers', roverNames)
      if (res) {
        this._logger.info('Stored rovers to persistence')
      }
      res = await this.persistence.put('appversion', versionData)
      if (res) {
        this._logger.info('Stored appversion to persistence')
      }
      try {
        await this.persistence.get('bc.block.1')
        const latestBlock = await this.persistence.get('bc.block.latest')
        this._logger.info('highest block height on disk ' + latestBlock.getHeight())
        this.multiverse.addNextBlock(latestBlock)
      } catch (_) { // genesis block not found
        try {
          await this.persistence.put('bc.block.1', newGenesisBlock)
          await this.persistence.put('bc.block.latest', newGenesisBlock)
          await this.persistence.put('bc.block.checkpoint', newGenesisBlock)
          await this.persistence.put('bc.depth', 2)
          this.multiverse.addNextBlock(newGenesisBlock)
          this._logger.info('Genesis block saved to disk ' + newGenesisBlock.getHash())
        } catch (e) {
          this._logger.error(`Error while creating genesis block ${e.message}`)
          this.requestExit()
          process.exit(1)
        }
      }
    } catch (e) {
      this._logger.warn(`Could not store rovers to persistence, reason ${e.message}`)
    }

    if (MONITOR_ENABLED) {
      this._monitor.start()
    }

    this._logger.info('Engine initialized')

    self.pubsub.subscribe('state.block.height', '<engine>', (msg) => {
      self.storeHeight(msg).then((res) => {
        if (res === true) {
          self._logger.info('wrote block ' + msg.data.getHeight())
        }
      }).catch((err) => {
        self._logger.error(errToString(err))
      })
    })

    self.pubsub.subscribe('update.checkpoint.start', '<engine>', (msg) => {
      self._peerIsResyncing = true
    })

    self.pubsub.subscribe('state.resync.failed', '<engine>', (msg) => {
      self._logger.info('pausing mining to reestablish multiverse')
      self._peerIsResyncing = true
      engineQueue.push(self.blockpool.purge(msg.data), (err) => {
        if (err) {
          this._logger.error(`Queued task failed, reason: ${err.message}`)
        }
      })
    })

    self.pubsub.subscribe('state.checkpoint.end', '<engine>', (msg) => {
      self._peerIsResyncing = false
    })

    this.pubsub.subscribe('update.block.latest', '<engine>', (msg) => {
      this.updateLatestAndStore(msg)
        .then((res) => {
          if (msg.mined === undefined) {
            this.miningOfficer.rebaseMiner()
              .then((state) => {
                this._logger.info(`latest block ${msg.data.getHeight()} has been updated`)
              })
              .catch((err) => {
                this._logger.error(`Error occurred during updateLatestAndStore(), reason: ${err.message}`)
              })
          }
        })
        .catch((err) => {
          this._logger.error(`Error occurred during updateLatestAndStore(), reason: ${err.message}`)
        })
    })

    this.pubsub.subscribe('miner.block.new', '<engine>', ({ unfinishedBlock, solution }) => {
      this._processMinedBlock(unfinishedBlock, solution).then((res) => {
        if (res === true) {
          this._broadcastMinedBlock(unfinishedBlock, solution)
            .then((res) => {
              this._logger.info('Broadcasted mined block', res)
            })
            .catch((err) => {
              this._logger.error(`Unable to broadcast mined block, reason: ${err.message}`)
            })
        }
      })
        .catch((err) => {
          this._logger.warn(err)
        })
    })
  }

  /**
   * Store a block in persistence unless its Genesis Block
   * @returns Promise
      ehs._logger.info('pmb' + 4)
   */
  async storeHeight (msg: Object) {
    const block = msg.data
    // Block is genesis block
    if (block.getHeight() < 2) {
      return
    }
    if (msg.force !== undefined && msg.force === true) {
      try {
        await this.persistence.put('bc.block.' + block.getHeight(), block)
        return Promise.resolve(block)
      } catch (err) {
        this._logger.warn('unable to store block ' + block.getHeight() + ' - ' + block.getHash())
        return Promise.reject(err)
      }
    } else {
      try {
        const prev = await this.persistence.get('bc.block.' + (block.getHeight() - 1))
        if (prev.getHash() === block.getPreviousHash() &&
          new BN(prev.getTotalDistance()).lt(new BN(block.getTotalDistance()) === true)) {
          await this.persistence.put('bc.block.' + block.getHeight(), block)
          return Promise.resolve(true)
        } else {
          return Promise.reject(new Error('block state did not match'))
        }
      } catch (err) {
        await this.persistence.put('bc.block.' + block.getHeight(), block)
        this._logger.warn(' stored orphan ' + block.getHeight() + ' - ' + block.getHash())
        return Promise.resolve(true)
      }
    }
  }

  /**
   * Store a block in persistence unless its Genesis Block
   * @returns Promise
   */
  async updateLatestAndStore (msg: Object) {
    const block = msg.data
    try {
      await this.persistence.get('bc.block.checkpoint')
    } catch (err) {
      this._logger.error(errToString(err))
      this._logger.info('setting checkpoint at height: ' + block.getHeight())
      await this.persistence.put('bc.block.checkpoint', block)
    }
    try {
      const previousLatest = await this.persistence.get('bc.block.latest')

      if (previousLatest.getHash() === block.getPreviousHash()) {
        await this.persistence.put('bc.block.latest', block)
        await this.persistence.put('bc.block.' + block.getHeight(), block)
        await this.persistence.putChildHeaders(block)
      } else if (msg.force === true) {
        await this.persistence.put('bc.block.latest', block)
        await this.persistence.put('bc.block.' + block.getHeight(), block)
        await this.persistence.putChildHeaders(block)
      } else {
        this._logger.error('failed to set block ' + block.getHeight() + ' ' + block.getHash() + ' as latest block, wrong previous hash')
      }

      if (msg.multiverse !== undefined) {
        while (msg.multiverse.length > 0) {
          const b = msg.multiverse.pop()
          if (b.getHeight() > 1) {
            await this.persistence.put('bc.block.' + b.getHeight(), b)
            await this.persistence.forcePutChildHeaders(b)
          }
        }
        return Promise.resolve(true)
      }
      return Promise.resolve(true)
    } catch (err) {
      this._logger.error(errToString(err))
      this._logger.warn('no previous block found')
      if (block !== undefined && msg.force === true) {
        await this.persistence.put('bc.block.latest', block)
        await this.persistence.put('bc.block.' + block.getHeight(), block)
        await this.persistence.putChildHeaders(block)
      }
      if (msg.multiverse !== undefined) {
        // assert the valid state of the entire sequence of each rovered chain
        const multiverseIsValid = this.miningOfficer.validateRoveredSequences(msg.multiverse)
        if (!multiverseIsValid) return Promise.resolve(false)
        while (msg.multiverse.length > 0) {
          const b = msg.multiverse.pop()
          if (b.getHeight() > 1) {
            await this.persistence.put('bc.block.' + b.getHeight(), b)
            await this.persistence.putChildHeaders(b)
          }
        }
        return Promise.resolve(true)
      }
      return Promise.resolve(true)
    }
  }

  /**
   * Get node
   * @return {Node}
   */
  get node (): Node {
    return this._node
  }

  /**
   * Get rawBlock
   * @return {Object}
   */
  get rawBlock (): ?Block {
    return this._rawBlock
  }

  /**
   * Set rawBlock
   * @param block
   */
  set rawBlock (block: Block) {
    this._rawBlock = block
  }

  /**
   * Get persistence
   * @return {Persistence}
   */
  get persistence (): PersistenceRocksDb {
    return this._persistence
  }

  /**
   * Get rovers manager
   * @returns RoverManager
   */
  get rovers (): RoverManager {
    return this._rovers
  }

  /**
   * Get instance of RpcServer
   * @returns RpcServer
   */
  get rpc (): RpcServer {
    return this._rpc
  }

  /**
   * Get instance of Server (Express on steroids)
   * @returns Server
   */
  get server (): Server {
    return this._server
  }

  get miningOfficer (): MiningOfficer {
    return this._miningOfficer
  }

  /**
   * Start Server
   */
  startNode () {
    this._logger.info('Starting P2P node')
    this.node.start()

    this._emitter.on('peerConnected', ({ peer }) => {
      if (this._server) {
        this._server._wsBroadcastPeerConnected(peer)
      }
    })

    this._emitter.on('peerDisconnected', ({ peer }) => {
      if (this._server) {
        this._server._wsBroadcastPeerDisonnected(peer)
      }
    })
  }

  /**
   * Start rovers
   * @param rovers - list (string; comma-delimited) of rover names to start
   */
  startRovers (rovers: string[]) {
    this._logger.info(`Starting rovers '${rovers.join(',')}'`)

    rovers.forEach(name => {
      if (name) {
        this._rovers.startRover(name)
      }
    })

    this._emitter.on('collectBlock', ({ block }) => {
      // Persist block if needed
      if (PERSIST_ROVER_DATA === true) {
        this._writeRoverData(block)
      }

      // FIXME: @schnorr, is this typo? Should not it be this._rawBlocks.push(block) ?
      // this._rawBlock.push(block)

      process.nextTick(() => {
        let promise = null

        if (config.bc.council.enabled) {
          promise = new Promise((resolve, reject) => {
            request(config.bc.council.url, (error, response, body) => {
              if (error) {
                return reject(error)
              }

              return resolve(body)
            })
          })
        } else {
          promise = Promise.resolve(true)
        }

        promise.then(council => {
          this.miningOfficer.newRoveredBlock(rovers, block)
            .then((pid: number|false) => {
              if (pid !== false) {
                this._logger.info(`collectBlock handler: successfuly send to mining worker (PID: ${pid})`)
              }
            })
            .catch(err => {
              this._logger.error(`Could not send to mining worker, reason: ${errToString(err)}`)
            })
        }).catch(_ => {
          this._logger.info('“Save Waves and NEO!” - After Block Collider miners completely brought down the Waves network 22 minutes into mining the team has paused the launch of genesis until we setup protections for centralized chains. Your NRG is safe.')
          process.exit(64)
        })
      })
    })
  }

  /**
   * Takes a range of blocks and validates them against within the contents of a parent and child
   * TODO: Move this to a better location
   * @param blocks BcBlock[]
   */
  async syncSetBlocksInline (blocks: BcBlock[]): Promise<Error|bool[]> {
    const valid = await this.multiverse.validateBlockSequenceInline(blocks)
    if (valid === false) {
      return Promise.reject(new Error('sequence of blocks is not working'))
    }
    const tasks = blocks.map((item) => this.persistence.put(`pending.bc.block.${item.getHeight()}`, item))
    return Promise.all(tasks)
  }

  /**
   * Determine if a sync request should be made to get the block
   * TODO: Move this to P2P / better location
   * @param conn Connection the block was received from
   * @param newBlock Block itself
   */
  async syncFromDepth (conn: Object, newBlock: BcBlock): Promise<bool|Error> {
    // disabled until
    try {
      this._logger.info('sync from depth start')
      const depthData = await this.persistence.get('bc.depth')
      const depth = parseInt(depthData, 10) // coerce for Flow
      const checkpoint = await this.persistence.get('bc.block.checkpoint')
      // where the bottom of the chain is
      // if the last height was not a genesis block and the depth was 2 then sync only to the height
      if (depth === 2) {
        // ignore and return u
        this._logger.info('depth is 2: sync from depth end')
        return Promise.resolve(true)
      } else if (depth <= checkpoint.getHeight()) {
        // test to see if the depth hash references the checkpoint hash
        const assertBlock = await this.persistence.get('bc.block.' + (checkpoint.getHeight() - 1))
        if (checkpoint.getPreviousHash() !== assertBlock.getHash()) {
          await this.persistence.put('bc.block.checkpoint', getGenesisBlock)
          await this.persistence.put('bc.depth', depth)
          return this.syncFromDepth(conn, newBlock)
        } else {
          return this.persistence.putPending('bc')
        }
        // return Promise.resolve(true)
      } else {
        const upperBound = max(depth, checkpoint.getHeight() + 1) // so we dont get the genesis block
        const lowerBound = max(depth - 2000, checkpoint.getHeight())
        return conn.getPeerInfo((err, peerInfo) => {
          if (err) {
            return Promise.reject(err)
          }
          return (async () => {
            const peerLockKey = 'bc.peer.' + peerInfo.id.toB58String()
            let peerLock = 1 // assume peer is busy
            try {
              peerLock = await this.persistence.get(peerLockKey)
            } catch (err) {
              // the lock does not exist
              peerLock = 0
            }
            if (peerLock === 1) {
              // dont send request because the peer is busy
              return Promise.resolve(true)
            } else {
              // request a range from the peer
              await this.persistence.put(peerLockKey, 1)
              // lock the depth for if another block comes while running this
              await this.persistence.put('bc.depth', depth)
              const query = {
                queryHash: newBlock.getHash(),
                queryHeight: upperBound,
                low: lowerBound,
                high: upperBound
              }
              return this.node.manager.createPeer(peerInfo)
                .query(query)
                .then(blocks => {
                  return this.syncSetBlocksInline(blocks)
                    .then((blocksStoredResults) => {
                      // if we didn't get the one block above the genesis block run again
                      if (lowerBound !== checkpoint.getHeight()) {
                        return this.syncFromDepth(conn, newBlock)
                      }

                      /*
                      * test if it connects to the previous synced chain
                      * this would happen if a peer disconnected from the network
                      * and was now resyncing
                      */
                      if (lowerBound > 2) {
                        return (async () => {
                          const assertBlock = await this.persistence.get('bc.block.' + (lowerBound - 1))
                          // if the hash is not referenced the node could have been synced to a weaker chain
                          if (checkpoint.getPreviousHash() !== assertBlock.getHash()) {
                            await this.persistence.put('bc.block.checkpoint', getGenesisBlock)
                            await this.persistence.put('bc.depth', depth)
                            return this.syncFromDepth(conn, newBlock)
                          } else {
                            return this.persistence.putPending('bc')
                          }
                        })()
                      }
                      // all done, no more depth clean up, unlock peer
                      return this.persistence.put(peerLockKey, 0)
                        .then(() => {
                          return this.persistence.put('bc.depth', 2)
                            .then(() => {
                              return this.persistence.putPending('bc')
                            })
                            .catch((e) => {
                              return Promise.reject(e)
                            })
                        })
                        .catch(e => {
                          this._logger.error(errToString(e))
                          return Promise.reject(e)
                        })
                    })
                    .catch(e => {
                      this._logger.error(errToString(e))
                      // unlock the peer
                      return this.persistence.put(peerLockKey, 0)
                        .then(() => {
                          return this.persistence.put('bc.depth', depth)
                            .then(() => {
                              return Promise.resolve(false)
                            })
                        })
                        .catch(e => {
                          // reset the depth
                          return this.persistence.put('bc.depth', depth)
                            .then(() => {
                              return Promise.reject(e)
                            })
                        })
                    })
                })
                .catch(e => {
                  // unlock the peer and reset the depth
                  return this.persistence.put(peerLockKey, 0)
                    .then(() => {
                      return this.persistence.put('bc.depth', depth)
                        .then(() => {
                          return Promise.resolve(depth)
                        })
                    })
                })
            }
          })()
        })
      }
    } catch (err) {
      // no depth has been set
      return Promise.reject(err)
    }
  }

  /**
   * New block received from peer handler
   * @param conn Connection the block was received from
   * @param newBlock Block itself
   */
  blockFromPeer (conn: Object, newBlock: BcBlock): void {
    // Test if new block has been seen before
    if (newBlock && !this._knownBlocksCache.get(newBlock.getHash())) {
      // Add block to LRU cache to avoid processing the same block twice
      debug(`Adding received block into cache of known blocks - ${newBlock.getHash()}`)
      this._knownBlocksCache.set(newBlock.getHash(), newBlock)
      this._logger.info('Received new block from peer', newBlock.getHeight())

      // EVAL NEXT
      // is newBlock next after currentHighestBlock? (all)
      // [] - newBlock previousHash is hash of currentHighestBlock
      // [] - newBlock timestamp > currentHighestBlock timestamp
      // [] - newBlock totalDifficulty > currentHighestBlock totalDifficulty
      // [] - newBlock connected chain heights > currentHighestBlock connected chain heights

      // 1 EVAL REJECT / RESYNC
      // * requires currentParentHighestBlock
      // when does newBlock trigger resync after multiverse rejection (pick any)
      // [] = newBlock has greater totalDifficulty
      // [] = greater child heights of the parentHighestBlock
      //
      // 2 EVAL REJECT / RESYNC
      // when no parentBlockExists (light client / early sync)
      // [] = newBlock has greater totalDifficulty
      //
      // after target adds weighted fusion positioning to also evaluate block  -> (X1,Y1) = D1/D1 + D2 * (X1,Y1) + D2 / D1 + D2 * (X2, Y2)
      // encourages grouped transactions from one tower to be more likely to enter a winning block in batch due to lowest distance

      const isNextBlock = this.multiverse.addNextBlock(newBlock)

      if (isNextBlock === true) {
        if (this.multiverse._chain.length > 1) {
          this._logger.info('new block ' + newBlock.getHash() + ' references previous Block ' + newBlock.getPreviousHash() + ' for block ' + this.multiverse._chain[1].getHash())
        }
        this._logger.info('block ' + newBlock.getHeight() + ' considered next block in current multiverse ')
        // RESTART MINING USED newBlock.getHash()
        this.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock })
        // notify the miner
        this.node.broadcastNewBlock(newBlock)
        // if depth !== 0
        // if peer unlocked
        // lock peer
        // request lowest multiverse block height, lowest block height - 5000 / 0
        // set the bc.depth depth  at the lowest - 5000 height
        // if the request succeeds check the depth and see if we are done
        // if we are done unlock the peer
        // if we are not done re-request a sync
      } else {
        this._logger.info('new block ' + newBlock.getHeight() + ' is NOT next block, evaluating resync.')
        this.multiverse.addResyncRequest(newBlock, this.miningOfficer._canMine)
          .then(shouldResync => {
            if (shouldResync === true) {
              this._logger.info(newBlock.getHash() + ' new block: ' + newBlock.getHeight() + ' should rsync request approved')
              // 1. request multiverse from peer, if fail ignore
              // succeed in getting multiverse -->
              // 2. Compare purposed multiverse sum of difficulty with current sum of diff
              // determined newBlock multiverse better
              // 3. restart miner
              // 4. set bc.depth to lowest height and hash of new multiverse
              // 5. get peer lock status
              //
              //
              const upperBound = newBlock.getHeight()
              this._logger.info(newBlock.getHash() + ' resync upper bound: ' + upperBound)
              // get the lowest of the current multiverse
              const lowerBound = this.multiverse.getLowestBlock()
              this._logger.info(newBlock.getHash() + ' resync lower bound: ' + lowerBound)
              this.miningOfficer.stopMining()
              return conn.getPeerInfo((err, peerInfo) => {
                if (err) {
                  this._logger.error(errToString(err))
                  return Promise.reject(err)
                }
                // request proof of the multiverse from the peer
                const peerLockKey = peerInfo.id.toB58String()
                const query = {
                  queryHash: newBlock.getHash(),
                  queryHeight: upperBound,
                  low: lowerBound,
                  high: upperBound
                }
                this._logger.info(newBlock.getHash() + ' requesting multiverse proof from peer: ' + peerLockKey)
                this.node.manager.createPeer(peerInfo)
                  .query(query)
                  .then(newBlocks => {
                    if (newBlocks === undefined) {
                      this._logger.warn(newBlock.getHash() + ' no blocks recieved from proof ')
                      return Promise.resolve(true)
                    }
                    this._logger.info(1)
                    this._logger.info(newBlock.getHash() + ' recieved ' + newBlocks.length + ' blocks for multiverse proof')
                    const currentHeights = this.multiverse._chain.map(b => {
                      return b.getHeight()
                    })
                    this._logger.info(2)
                    this._logger.info(newBlock.getHash() + ' new heights: ' + currentHeights)
                    const comparableBlocks = newBlocks.filter(a => {
                      if (currentHeights.indexOf(a) > -1) return a
                    })
                    this._logger.info(comparableBlocks)
                    this._logger.info(3)
                    const sorted = comparableBlocks.sort((a, b) => {
                      if (a.getHeight() > b.getHeight()) {
                        return -1
                      }
                      if (a.getHeight() < b.getHeight()) {
                        return 1
                      }
                      return 0
                    })
                    this._logger.info(4)
                    const highestBlock = this.multiverse.getHighestBlock()
                    this._logger.info(5)
                    this._logger.info(newBlock.getHash() + ' comparing with: ' + highestBlock.getHash() + ' height: ' + highestBlock.getHeight())
                    this._logger.info(6)

                    let conditional = false
                    if (highestBlock !== undefined && sorted !== undefined && sorted.length > 0) {
                      // conanaOut
                      conditional = new BN(sorted[0].getTotalDistance()).gt(new BN(highestBlock.getTotalDistance()))
                    } else if (sorted.length < 1) {
                      conditional = true
                    }

                    if (conditional === true) {
                      // overwrite current multiverse
                      this._logger.info(7)
                      this._logger.info(newBlock.getHash() + ' approved --> assigning as current multiverse')
                      this.multiverse._candidates.length = 0
                      this.multiverse._chain.length = 0
                      this.multiverse._chain = sorted
                      this._logger.info('multiverse has been assigned')
                      return this.persistence.put('bc.depth', highestBlock.getHeight())
                        .then(() => {
                          this._logger.info(8)
                          this.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock, force: true, multiverse: this.multiverse._chain })
                          this.node.broadcastNewBlock(newBlock)
                          // assign where the last sync began
                          return this.syncFromDepth(conn, this.multiverse.getHighestBlock())
                            .then(synced => {
                              this._logger.info(9)
                              this._logger.info(newBlock.getHash() + ' blockchain sync complete')
                            })
                            .catch(e => {
                              this._logger.info(newBlock.getHash() + ' blockchain sync failed')
                              this._logger.error(errToString(e))
                            })
                        })
                        .catch(e => {
                          this._logger.error(errToString(e))
                        })
                    }
                  })
                  .catch(e => {
                    this._logger.error(errToString(e))
                  })
              })
            } else {
              return conn.getPeerInfo((err, peerInfo) => {
                if (err) {
                  this._logger.error(errToString(err))
                  return Promise.reject(err)
                }
                // request proof of the multiverse from the peer
                const url = `${PROTOCOL_PREFIX}/newblock`
                this.bundle.dialProtocol(peerInfo, url, (err, cn) => {
                  if (err) {
                    this._logger.error('Error sending message to peer', err)
                    return err
                  }
                  // TODO JSON.stringify?
                  pull(pull.values([newBlock.serializeBinary()]), cn)
                })
              })
                .catch(err => {
                  this._logger.error(errToString(err))
                })
            }
          })
      }
    }
  }

  receiveSyncPeriod (peerIsSyncing: bool) {
    this._logger.info('peer sync request')
  }

  /**
   * Start Server
   *
   * @param opts Options to start server with
   */
  startServer (opts: Object) {
    this.server.run(opts)
  }

  requestExit () {
    ts.stop()
    this.miningOfficer.stop()
    return this._rovers.killRovers()
  }

  _writeRoverData (newBlock: BcBlock) {
    const dataPath = ensureDebugPath(`bc/rover-block-data.csv`)
    const rawData = JSON.stringify(newBlock)
    writeFileSync(dataPath, `${rawData}\r\n`, { encoding: 'utf8', flag: 'a' })
  }

  /**
   * Broadcast new block
   *
   * - peers
   * - pubsub
   * - ws
   *
   * This function is called by this._processMinedBlock()
   * @param newBlock
   * @param solution
   * @returns {Promise<boolean>}
   * @private
   */
  _broadcastMinedBlock (newBlock: BcBlock, solution: Object): Promise<boolean> {
    const self = this
    this._logger.info('Broadcasting mined block')

    if (newBlock === undefined) {
      return Promise.reject(new Error('cannot broadcast empty block'))
    }

    try {
      self.node.broadcastNewBlock(newBlock)

      // NOTE: Do we really need nested try-catch ?
      try {
        const newBlockObj = {
          ...newBlock.toObject(),
          iterations: solution.iterations,
          timeDiff: solution.timeDiff
        }
        self.pubsub.publish('block.mined', { type: 'block.mined', data: newBlockObj })
      } catch (e) {
        return Promise.reject(e)
      }
    } catch (err) {
      return Promise.reject(err)
    }

    return Promise.resolve(true)
  }

  /**
   * Deals with unfinished block after the solution is found
   *
   * @param newBlock
   * @param solution
   * @returns {Promise<boolean>} Promise indicating if the block was successfully processed
   * @private
   */
  _processMinedBlock (newBlock: BcBlock, solution: Object): Promise<boolean> {
    // TODO: reenable this._logger.info(`Mined new block: ${JSON.stringify(newBlockObj, null, 2)}`)
    // Trying to process null/undefined block
    if (newBlock === null || newBlock === undefined) {
      this._logger.warn('Failed to process work provided by miner')
      return Promise.resolve(false)
    }
    this._logger.info('pmb' + 1)
    // Prevent submitting mined block twice
    if (this._knownBlocksCache.has(newBlock.getHash())) {
      this._logger.warn('Received duplicate new block ' + newBlock.getHeight() + ' (' + newBlock.getHash() + ')')
      return this.miningOfficer.stopMining()
    }
    // Add to multiverse and call persist
    this._knownBlocksCache.set(newBlock.getHash(), newBlock)
    this._logger.info('submitting mined block to current multiverse')
    const isNextBlock = this.multiverse.addNextBlock(newBlock)
    this._logger.info('submitted mine block is next block in multiverse: ' + isNextBlock)
    this._logger.info('pmb' + 2)
    // if (isNextBlock) {
    // TODO: this will break now that _blocks is not used in multiverse
    // if (this.multiverse.getHighestBlock() !== undefined &&
    //    this.multiverse.validateBlockSequenceInline([this.multiverse.getHighestBlock(), newBlock]) === true) {
    this._logger.info('number of blocks in multiverse: ' + this.multiverse._chain.length)
    if (isNextBlock === true) {
      this._logger.info('pmb' + 3)
      this._logger.info('pmb' + 4)
      this.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock, mined: true })
      this._server._wsBroadcastMultiverse(this.multiverse)
      return Promise.resolve(true)
    } else {
      this._logger.info('local mined block ' + newBlock.getHeight() + ' does not stack on multiverse height ' + this.multiverse.getHighestBlock().getHeight())
      this._logger.info('mined block ' + newBlock.getHeight() + ' cannot go on top of multiverse block ' + this.multiverse.getHighestBlock().getHash())
      this.miningOfficer.stopMining()
        .then((res) => {
          this._logger.info(res)
        })
        .catch((e) => {
          this._logger.error(errToString(e))
        })
    }
    return Promise.resolve(false)
    // }
  }
}

export default Engine
