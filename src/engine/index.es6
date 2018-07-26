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

const debug = require('debug')('bcnode:engine')
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
const { isValidBlock } = require('../bc/validation')
const { Block } = require('../protos/core_pb')
const { errToString } = require('../helper/error')
const { getVersion } = require('../helper/version')
const { MiningOfficer } = require('../mining/officer')
const ts = require('../utils/time').default // ES6 default export

const DATA_DIR = process.env.BC_DATA_DIR || config.persistence.path
const MONITOR_ENABLED = process.env.BC_MONITOR === 'true'
const BC_CHECK = process.env.BC_CHECK === 'true'
const BC_LIMIT_MINING = process.env.BC_LIMIT_MINING === 'true'
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
        if (semver.lt(version.version, '0.7.0')) { // GENESIS BLOCK 0.9
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
        await this.persistence.put('synclock', getGenesisBlock())
        await this.persistence.put('bc.block.oldest', getGenesisBlock())
        await this.persistence.get('bc.block.1')
        const latestBlock = await this.persistence.get('bc.block.latest')
        await this.multiverse.addNextBlock(latestBlock)
        this._logger.info('highest block height on disk ' + latestBlock.getHeight())
      } catch (_) { // genesis block not found
        try {
          await this.persistence.put('synclock', getGenesisBlock())
          await this.persistence.put('bc.block.1', newGenesisBlock)
          await this.persistence.put('bc.block.latest', newGenesisBlock)
          await this.persistence.put('bc.block.oldest', getGenesisBlock())
          await this.persistence.put('bc.block.checkpoint', newGenesisBlock)
          await this.persistence.put('bc.depth', 2)
          await this.multiverse.addNextBlock(newGenesisBlock)
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

    if (BC_CHECK === true) {
      await this.integrityCheck()
    }

    if (MONITOR_ENABLED) {
      this._monitor.start()
    }

    this.pubsub.subscribe('state.block.height', '<engine>', (msg) => {
      this.storeHeight(msg).then((res) => {
        if (res === true) {
          this._logger.info('wrote block ' + msg.data.getHeight())
        }
      }).catch((err) => {
        this._logger.error(errToString(err))
      })
    })

    this.pubsub.subscribe('update.checkpoint.start', '<engine>', (msg) => {
      this._peerIsResyncing = true
    })

    this.pubsub.subscribe('state.resync.failed', '<engine>', (msg) => {
      this._logger.info('pausing mining to reestablish multiverse')
      this._peerIsResyncing = true
      engineQueue.push(this.blockpool.purge(msg.data), (err) => {
        if (err) {
          this._logger.error(`Queued task failed, reason: ${err.message}`)
        }
      })
    })

    this.pubsub.subscribe('state.checkpoint.end', '<engine>', (msg) => {
      this._peerIsResyncing = false
    })

    this.pubsub.subscribe('update.block.latest', '<engine>', (msg) => {
      return this.miningOfficer.stopMining().then(() => {
        return this.updateLatestAndStore(msg)
          .then((res) => {
            if (msg.mined !== undefined && msg.mined === true) {
              this._logger.info(`latest block ${msg.data.getHeight()} has been updated`)
            } else {
              // this.miningOfficer.rebaseMiner()
              //  .then((state) => {
              //    this._logger.info(`latest block ${msg.data.getHeight()} has been updated`)
              //  })
              //  .catch((err) => {
              //    this._logger.error(`error occurred during updateLatestAndStore(), reason: ${err.message}`)
              //  })
            }
          })
          .catch((err) => {
            this._logger.info(errToString(err))
            this._logger.error(`error occurred during updateLatestAndStore(), reason: ${err.message}`)
            process.exit()
          })
      })
        .catch((err) => {
          this._logger.error(err)
        })
    })

    this.pubsub.subscribe('miner.block.new', '<engine>', ({ unfinishedBlock, solution }) => {
      return this._processMinedBlock(unfinishedBlock, solution).then((res) => {
        if (res === true) {
          return this._broadcastMinedBlock(unfinishedBlock, solution)
            .then((res) => {
              this._logger.info('broadcasted mined block', res)
            })
            .catch((err) => {
              this._logger.error(`mined block broadcast failed -> ${err.message}`)
            })
        }
      })
        .catch((err) => {
          this._logger.warn(err)
        })
    })

    this.node.bundle.channels.on('newblock', (msg) => {
      this._logger.info(msg.toString())
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
        let prev = getGenesisBlock()
        if ((block.getHeight() - 1) > 0) {
          prev = await this.persistence.get('bc.block.' + (block.getHeight() - 1))
        }
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
    this._logger.info('store block: ' + block.getHeight() + ' ' + block.getHash())
    try {
      const previousLatest = await this.persistence.get('bc.block.latest')

      if (previousLatest.getHash() === block.getPreviousHash()) {
        await this.persistence.put('bc.block.latest', block)
        await this.persistence.put('bc.block.' + block.getHeight(), block)
        await this.persistence.putChildHeaders(block)
      } else if (msg.force === true || previousLatest.getHeight() === 1) {
        await this.persistence.put('bc.block.latest', block)
        await this.persistence.put('bc.block.' + block.getHeight(), block)
        await this.persistence.putChildHeaders(block)
      } else {
        this._logger.error('failed to set block ' + block.getHeight() + ' ' + block.getHash() + ' as latest block, wrong previous hash')
      }

      if (this.miningOfficer._canMine === false) {
        this._logger.info('determining if rovered headers include new child blocks')
        const latestRoveredHeadersKeys: string[] = this.miningOfficer._knownRovers.map(chain => `${chain}.block.latest`)
        const latestBlockHeaders = await this.persistence.getBulk(latestRoveredHeadersKeys)
        latestBlockHeaders.map((r) => {
          if (this.miningOfficer._collectedBlocks[r.getBlockchain()] < 1) {
            this.miningOfficer._collectedBlocks[r.getBlockchain()]++
          }
        })
      }

      if (msg.multiverse !== undefined) {
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
    } catch (err) {
      this._logger.error(errToString(err))
      this._logger.warn('no previous block found')
      if (block !== undefined && msg.force === true) {
        await this.persistence.put('bc.block.latest', block)
        await this.persistence.put('bc.block.' + block.getHeight(), block)
        await this.persistence.putChildHeaders(block)
      } else {
        this._logger.warn('submitted block ' + block.getHeight() + ' ' + block.getHash() + ' will not be persisted')
      }
      if (msg.multiverse !== undefined) {
        // assert the valid state of the entire sequence of each rovered chain
        // DISABLED for BT: const multiverseIsValid = this.miningOfficer.validateRoveredSequences(msg.multiverse)
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

      // TEST IF THIS SHOULD BE DONE
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
                this._logger.info(`collectBlock handler: sent to miner: ${pid}`)
              }
            })
            .catch(err => {
              this._logger.error(`could not send to mining worker, reason: ${errToString(err)}`)
              process.exit()
            })
        }).catch(_ => {
          this._logger.info('“Save Waves and NEO!” - After Block Collider miners completely brought down the Waves network 22 minutes into mining the team has paused the launch of genesis until we setup protections for centralized chains. Your NRG is safe.')
        })
      })
    })
  }

  async integrityCheck () {
    try {
      await this.persistence.get('bc.block.1')
      this._logger.info('chain integrity check running')
      const limit = await this.persistence.stepFrom('bc.block', 1)
      this._logger.info('chain integrity: ' + limit)
      await this.persistence.flushFrom('bc.block', limit)
      return Promise.resolve(limit)
    } catch (err) {
      this._logger.error(err)
      this._logger.warn('unable to use default for integrity check')
      try {
        await this.persistence.set('bc.block.1', getGenesisBlock)
        await this.persistence.flushFrom('bc.block', 1)
      } catch (err) {
        this._logger.error(err)
      }
      return Promise.resolve(1)
    }
  }

  async sendPeerLatestBlock (conn: Object, newBlock: BcBlock): Promise<*> {
    return conn.getPeerInfo((err, peerInfo) => {
      if (err) {
        this._logger.error(errToString(err))
        return Promise.reject(err)
      }

      try {
        const targetPeer = peerInfo.id.toB58String()
        return this.node.sendBlockToPeer(newBlock, targetPeer)
      } catch (err) {
        return Promise.reject(err)
      }
      // request proof of the multiverse from the peer
    })
  }

  /**
   * Takes a range of blocks and validates them against within the contents of a parent and child
   * TODO: Move this to a better location
   * @param blocks BcBlock[]
   */
  async syncSetBlocksInline (blocks: BcBlock[], blockKey: ?string): Promise<Error|bool[]> {
    let valid = true
    if (blocks.length < 100) {
      valid = await this.multiverse.validateBlockSequenceInline(blocks)
    }
    if (valid === false) {
      return Promise.reject(new Error('invalid sequence of blocks')) // Enabled after target
    }
    let tasks = []
    if (blockKey === undefined) {
      tasks = blocks.map((item) => this.persistence.put('bc.block.' + item.getHeight(), item))
    } else {
      tasks = blocks.map((item) => this.persistence.put(blockKey + '.bc.block.' + item.getHeight(), item))
    }
    await Promise.all(tasks)
    return Promise.resolve(tasks.length)
  }

  /**
   * Determine if a sync request should be made to get the block
   * TODO: Move this to P2P / better location
   * @param conn Connection the block was received from
   * @param newBlock Block itself
   */
  async proveTwo (conn: Object, newBlock: BcBlock): Promise<bool|Error> {
    // disabled until
    try {
      this._logger.info('sync from depth start')
      const depthData = await this.persistence.get('bc.depth')
      const depth = parseInt(depthData, 10) // coerce for Flow
      // const checkpoint = await this.persistence.get('bc.block.checkpoint')
      // where the bottom of the chain is
      // if the last height was not a genesis block and the depth was 2 then sync only to the height
      if (depth === 2) {
        // chain has be sequenced backwards until block of height 2
        this._logger.info('depth is 2: sync from depth end')
        return Promise.resolve(true)
        // return Promise.resolve(true)
      } else {
        const upperBound = max(depth, 2) + 1 // so we dont get the genesis block
        const lowBound = max(depth - 1000, 2) // Assigned during AT
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
              await this.persistence.put('bc.depth', upperBound)
              const query = {
                queryHash: newBlock.getHash(),
                queryHeight: newBlock.getHeight(),
                low: lowBound,
                high: upperBound
              }
              return this.node.manager.createPeer(peerInfo)
                .query(query)
                .then(blocks => {
                  this._logger.info(blocks.length + ' recieved')
                  return this.syncSetBlocksInline(blocks, 'pending')
                    .then((blocksStoredResults) => {
                      // if we didn't get the one block above the genesis block run again

                      /*
                      * test if it connects to the previous synced chain
                      * this would happen if a peer disconnected from the network
                      * and was now resyncing
                      */
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
                      this._logger.info('error has occured reading bounds')
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

  stepSync (conn: Object, height: Number, syncBlockHash: string): Promise<*> {
    this._logger.info('step sync from height: ' + height)
    // return new Promise(resolve, reject) {
    // check if peer is known to be slow
    return this.persistence.get('synclock')
      .then((syncBlock) => {
        if (syncBlock.getHash() !== syncBlockHash) {
          // Another sync override --> break step
          return Promise.resolve(false)
        }

        if (height < 3) {
          return this.persistence.put('synclock', getGenesisBlock()).then(() => {
            this._logger.info('sync reset')
          })
        }

        return conn.getPeerInfo((err, peerInfo) => {
          if (err) {
            this._logger.error(err)
            return this.persistence.put('synclock', getGenesisBlock()).then(() => {
              this._logger.info('sync reset')
            })
          } else {
            // check if peer is known to have been slow with event type 2
            if (this.node.manager.getPeerEvent(peerInfo.id.toB58String(),
              2) > 0) {
              return this.persistence.put('synclock', getGenesisBlock()).then(() => {
                this._logger.info('sync reset')
                return Promise.resolve(true)
              })
                .catch((e) => {
                  this._logger.error(e)
                  return Promise.resolve(false)
                })
            }

            if (syncBlock.getHeight() !== 1 && syncBlock.getHash() === syncBlockHash) {
              const low = max(height - 2500, 2)
              const query = {
                queryHash: '0000',
                queryHeight: height,
                low: low,
                high: height
              }
              return this.node.manager.createPeer(peerInfo)
                .query(query)
                .then(newBlocks => {
                  this._logger.info(newBlocks.length + ' recieved')
                  return this.syncSetBlocksInline(newBlocks)
                    .then((blocksStoredResults) => {
                      const lowest = newBlocks[0]
                      return this.persistence.put('bc.block.oldest', lowest)
                        .then(() => {
                          return this.stepSync(conn, low, syncBlockHash)
                        })
                    })
                    .catch((err) => {
                      this._logger.warn('sync failed')
                      this._logger.error(err)
                      this.node.manager.putPeerEvent(peerInfo.id.toB58String(), 2)
                      return Promise.resolve(false)
                    })
                })
                .catch((e) => {
                  this._logger.warn('sync failed')
                  this._logger.error(e)
                  this.node.manager.putPeerEvent(peerInfo.id.toB58String(), 2)
                  return this.persistence.put('synclock', getGenesisBlock()).then(() => {
                    this._logger.info('sync reset')
                    return Promise.resolve(true)
                  })
                })
            } else {
              this._logger.warn('sync canceled')
              return Promise.resolve(true)
            }
          }
        })
      })

      .catch((e) => {
        this._logger.warn('sync failed')
        this._logger.error(e)
        return this.persistence.put('synclock', getGenesisBlock()).then(() => {
          this._logger.info('sync reset')
        })
      })
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
      this._knownBlocksCache.set(newBlock.getHash(), 1)
      this._logger.info('Received new block from peer', newBlock.getHeight())

      if (!isValidBlock(newBlock, 1)) {
        debug('Received block was not valid')
        // TODO this peer should make to the the blacklist
        return
      }

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

      return this.multiverse.addNextBlock(newBlock).then((isNextBlock) => {
        if (isNextBlock === true) {
          if (this.multiverse._chain.length > 1) {
            this._logger.info('new block ' + newBlock.getHash() + ' references previous Block ' + newBlock.getPreviousHash() + ' for block ' + this.multiverse._chain[1].getHash())
          }
          this._logger.info('block ' + newBlock.getHeight() + ' considered next block in current multiverse ')
          // RESTART MINING USED newBlock.getHash()
          this.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock })
          // notify the miner
          return conn.getPeerInfo((err, peerInfo) => {
            if (err) {
              this._logger.error(err)
            } else {
            // broadcast to other peers without sending back to the peer that sent it to us
              this.node.broadcastNewBlock(newBlock, peerInfo.id.toB58String())
            }
          })
        // if depth !== 0
        // if peer unlocked
        // lock peer
        // request lowest multiverse block height, lowest block height - 5000 / 0
        // set the bc.depth depth  at the lowest - 5000 height
        // if the request succeeds check the depth and see if we are done
        // if we are done unlock the peer
        // if we are not done re-request a sync
        } else {
          this._logger.info('block from peer ' + newBlock.getHeight() + ' is NOT next in multiverse block -> evaluating as sync candidate.')
          return this.multiverse.addResyncRequest(newBlock, this.miningOfficer._canMine)
            .then(shouldResync => {
              if (shouldResync === true) {
                this._logger.info(newBlock.getHash() + ' new block: ' + newBlock.getHeight() + ' should sync request approved')
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
                // get the lowest of the current multiverse
                return this.miningOfficer.stopMining().then(() => {
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
                      low: upperBound - 11,
                      high: upperBound
                    }
                    this._logger.info(newBlock.getHash() + ' resync upper bound: ' + query.high)
                    this._logger.info(newBlock.getHash() + ' resync lower bound: ' + query.low)
                    this._logger.info(newBlock.getHash() + ' multiverse peer proof: ' + peerLockKey)
                    return this.node.manager.createPeer(peerInfo)
                      .query(query)
                      .then(newBlocks => {
                        if (newBlocks === undefined) {
                          this._logger.warn(newBlock.getHash() + ' incomplete proof')
                          return Promise.resolve(true)
                        }
                        this._logger.info(1)
                        this._logger.info(newBlock.getHash() + ' recieved ' + newBlocks.length + ' blocks for multiverse proof')
                        const currentHeights = this.multiverse._chain.map(b => {
                          return b.getHeight()
                        })
                        this._logger.info(2)
                        this._logger.info(newBlock.getHash() + ' new heights: ' + currentHeights)

                        const sorted = newBlocks.sort((a, b) => {
                          if (new BN(a.getHeight()).gt(new BN(b.getHeight())) === true) {
                            return -1
                          }
                          if (new BN(a.getHeight()).lt(new BN(b.getHeight())) === true) {
                            return 1
                          }
                          return 0
                        })

                        this._logger.info('comparable blocks: ' + newBlocks.length)
                        this._logger.info(11)
                        const highestBlock = this.multiverse.getHighestBlock()
                        this._logger.info(newBlock.getHash() + ' height: ' + newBlock.getHeight() + ' comparing with ' + highestBlock.getHash() + ' height: ' + highestBlock.getHeight())
                        let conditional = false
                        if (highestBlock.getHash() === newBlock.getHash()) {
                          conditional = true
                        } else if (highestBlock !== undefined && sorted !== undefined && newBlocks.length > 0) {
                          // conanaOut
                          conditional = new BN(sorted[0].getTotalDistance()).gt(new BN(highestBlock.getTotalDistance()))
                          if (conditional === false) {
                            this._logger.info('purposed new block has lower total difficulty than current multiverse height')
                          }
                        } else if (sorted.length < 6) {
                          conditional = true
                        }

                        this._logger.info('highest in sorted: ' + sorted[0].getHeight())
                        this._logger.info('lowest in sorted: ' + sorted[sorted.length - 1].getHeight())
                        this._logger.info('sorted highest block: ' + sorted[0].getHeight() + ' ' + sorted[0].getHash())
                        if (conditional === true) {
                          // overwrite current multiverse
                          const hasBlock = this.multiverse.hasBlock(sorted[0])
                          this._logger.info(newBlock.getHash() + ' approved --> assigning as current multiverse')
                          this.multiverse._chain.length = 0
                          this.multiverse._chain = this.multiverse._chain.concat(sorted)
                          this._logger.info('multiverse has been assigned')

                          return this.syncSetBlocksInline(newBlocks)
                            .then((blocksStoredResults) => {
                              return this.persistence.put('bc.depth', this.multiverse.getHighestBlock().getHeight())
                                .then(() => {
                                  // if the block is already in the multiverse dont conduct a full sync
                                  if (hasBlock === false) {
                                    this._logger.info('legacy multiverse did not include current block')
                                    return this.persistence.put('synclock', this.multiverse.getHighestBlock())
                                      .then(() => {
                                        this.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock, force: true, multiverse: this.multiverse._chain })
                                        this.node.broadcastNewBlock(newBlock, peerInfo.id.toB58String())
                                        this._logger.debug('sync unlocked')
                                        const targetHeight = this.multiverse.getLowestBlock().getHeight() - 1
                                        // dont have to sync
                                        if (targetHeight === 1) {
                                          return Promise.resolve(true)
                                        }

                                        return this.stepSync(conn,
                                          this.multiverse.getHighestBlock().getHeight(),
                                          this.multiverse.getHighestBlock().getHash())
                                      })
                                      .catch((e) => {
                                        this._logger.error(e)
                                        return this.persistence.put('synclock', getGenesisBlock()).then(() => {
                                          this._logger.info('sync reset')
                                        })
                                          .catch((e) => {
                                            this._logger.error(e)
                                          })
                                      })
                                  } else {
                                    return this.persistence.put('synclock', getGenesisBlock()).then(() => {
                                      this._logger.info('sync reset')
                                    })
                                  }
                                  // assign where the last sync began
                                })
                                .catch(e => {
                                  this._logger.info(99)
                                  this._logger.error(errToString(e))
                                  return this.persistence.put('synclock', getGenesisBlock()).then(() => {
                                    this._logger.info('sync reset')
                                  })
                                    .catch((e) => {
                                      this._logger.error(e)
                                    })
                                })
                            })

                            .catch((e) => {
                              this._logger.error(e)
                              return Promise.resolve(true)
                            })
                        } else {
                          this._logger.info('resync conditions failed')
                          return this.persistence.put('synclock', getGenesisBlock()).then(() => {
                            this._logger.info('sync reset')
                          })
                            .catch((e) => {
                              this._logger.error(e)
                            })
                        }
                      })
                      .catch(e => {
                        this._logger.error(errToString(e))
                        this._logger.info(222)
                        return this.persistence.put('synclock', getGenesisBlock()).then(() => {
                          this._logger.info('sync reset')
                        })
                          .catch((e) => {
                            this._logger.error(e)
                          })
                      })
                  })
                })
                  .catch((e) => {
                    this._logger.info(333)
                    this._logger.error(e)
                    return this.persistence.put('synclock', getGenesisBlock()).then(() => {
                      this._logger.info('sync reset')
                    })
                      .catch((e) => {
                        this._logger.error(e)
                      })
                  })
              } else {
                return this.sendPeerLatestBlock(conn, this.multiverse.getHighestBlock())
                  .then(() => {
                    this._logger.info('peer sent for highest block to peer latest block')
                    return Promise.resolve(true)
                  })
                  .catch((e) => {
                    this._logger.warn('unable to warn peer of weaker branch')
                    this._logger.error(e)
                    return Promise.resolve(true)
                  })
              }
            })
        }
      })
        .catch((multiverseError) => {
          this._logger.error(multiverseError)
        })
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
    this._logger.info('Broadcasting mined block')

    if (newBlock === undefined) {
      return Promise.reject(new Error('cannot broadcast empty block'))
    }

    try {
      this.node.broadcastNewBlock(newBlock)
      this.node.bundle.channels.publish('newblock', Buffer.from(JSON.stringify(newBlock.toObject())), () => {})

      // NOTE: Do we really need nested try-catch ?
      try {
        const newBlockObj = {
          ...newBlock.toObject(),
          iterations: solution.iterations,
          timeDiff: solution.timeDiff
        }
        this.pubsub.publish('block.mined', { type: 'block.mined', data: newBlockObj })
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

    // Prevent submitting mined block twice
    if (this._knownBlocksCache.has(newBlock.getHash())) {
      this._logger.warn('received duplicate new block ' + newBlock.getHeight() + ' (' + newBlock.getHash() + ')')
      return this.miningOfficer.stopMiner().then((r) => {
        this._logger.info('end mining')
      })
        .catch((e) => {
          this._logger.warn('unable to stop miner')
          this._logger.error(e)
        })
    }

    // miners must have peers to mine
    if (this.node.manager.peerBookConnected.getPeersCount() < 6 &&
        BC_LIMIT_MINING === false) {
      this._logger.warn('mined blocks pending peer connections')
      return this.miningOfficer.stopMiner().then((r) => {
        this._logger.info('end mining')
      })
        .catch((e) => {
          this._logger.warn('unable to stop miner')
          this._logger.error(e)
        })
    }

    this._knownBlocksCache.set(newBlock.getHash(), 1)
    this._logger.info('submitting mined block to current multiverse')
    return this.multiverse.addNextBlock(newBlock)
      .then((isNextBlock) => {
        this._logger.info('accepted multiverse addition: ' + isNextBlock)
        // if (isNextBlock) {
        // TODO: this will break now that _blocks is not used in multiverse
        // if (this.multiverse.getHighestBlock() !== undefined &&
        //    this.multiverse.validateBlockSequenceInline([this.multiverse.getHighestBlock(), newBlock]) === true) {
        this._logger.info('multiverse coverage: ' + this.multiverse._chain.length)
        if (isNextBlock === true) {
          this.pubsub.publish('update.block.latest', { key: 'bc.block.latest', data: newBlock, mined: true })
          this._server._wsBroadcastMultiverse(this.multiverse)
          return Promise.resolve(true)
        } else {
          this._logger.warn('local mined block ' + newBlock.getHeight() + ' does not stack on multiverse height ' + this.multiverse.getHighestBlock().getHeight())
          this._logger.warn('mined block ' + newBlock.getHeight() + ' cannot go on top of multiverse block ' + this.multiverse.getHighestBlock().getHash())
          return this.miningOfficer.rebaseMiner()
            .then((res) => {
              this._logger.info(res)
            })
            .catch((e) => {
              this._logger.error(errToString(e))
            })
        }
      })
      .catch((err) => {
        this._logger.error(err)
      })
  }
}

export default Engine
