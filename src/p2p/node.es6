/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/* eslint no-console: ["error", { allow: ["warn", "error", "log", "trace"  ] }] */

import type { Engine } from '../engine'

const { inspect } = require('util')

const Url = require('url')
const PeerInfo = require('peer-info')
const queue = require('async/queue')
const multiaddr = require('multiaddr')
const pull = require('pull-stream')
// const toPull = require('stream-to-pull-stream')

const LRUCache = require('lru-cache')
const BN = require('bn.js')
const debug = require('debug')('bcnode:p2p:node')
const { config } = require('../config')
const { getVersion } = require('../helper/version')
const logging = require('../logger')

const { BcBlock } = require('../protos/core_pb')
const { ManagedPeerBook } = require('./book')
const Bundle = require('./bundle').default
const Discovery = require('./discovery')
const Signaling = require('./signaling').websocket
const { PeerManager, DATETIME_STARTED_AT, QUORUM_SIZE } = require('./manager/manager')
const { Multiverse } = require('../bc/multiverse')
const { BlockPool } = require('../bc/blockpool')

const { PROTOCOL_PREFIX, NETWORK_ID } = require('./protocol/version')
const MIN_HEALTH_NET = process.env.MIN_HEALTH_NET === 'true'
const USER_QUORUM = process.env.USER_QUORUM || config.bc.quorum
const BC_MAX_CONNECTIONS = process.env.BC_MAX_CONNECTIONS || 60

const { range, max } = require('ramda')
const { protocolBits, anyDns } = require('../engine/helper')
// const waterfall = require('async/waterfall')
// const { toObject } = require('../helper/debug')
// const { validateBlockSequence } = require('../bc/validation')

// function toBuffer (str) {
//  if (Buffer.isBuffer(str)) return str
//  if (ArrayBuffer.isView(str)) return Buffer.from(str.buffer, str.byteOffset, str.byteLength)
//  if (typeof str === 'string') return Buffer.from(str, 'hex')
//  throw new Error('Pass a buffer or a string')
// }
//
process.on('uncaughtError', (err) => {
  /* eslint-disable */
  console.trace(err)
  /* eslint-enable */
})

// const { PEER_QUORUM_SIZE } = require('./quorum')

export class PeerNode {
  _logger: Object // eslint-disable-line no-undef
  _engine: Engine // eslint-disable-line no-undef
  _interval: IntervalID // eslint-disable-line no-undef
  _bundle: Bundle // eslint-disable-line no-undef
  _manager: PeerManager // eslint-disable-line no-undef
  _peer: PeerInfo // eslint-disable-line no-undef
  _seededPeers: Object // eslint-disable-line no-undef
  _multiverse: Multiverse // eslint-disable-line no-undef
  _blockPool: BlockPool // eslint-disable-line no-undef
  _identity: string // eslint-disable-line no-undef
  _scanner: Object // eslint-disable-line no-undef
  _externalIP: string // eslint-disable-line no-undef
  _knownBlocks: Object // eslint-disable-line no-undef
  _ds: Object // eslint-disable-line no-undef
  _p2p: Object // eslint-disable-line no-undef
  _queue: Object // eslint-disable-line no-undef
  _greetingRegister: Object // eslint-disable-line no-undef

  constructor (engine: Engine) {
    this._engine = engine
    this._multiverse = new Multiverse(engine.persistence) /// !important this is a (nonselective) multiverse
    this._blockPool = new BlockPool(engine.persistence, engine._pubsub)
    this._logger = logging.getLogger(__filename)
    this._p2p = {
      givenHostName: false
    }
    this._manager = new PeerManager(this)
    this._ds = {}
    this._greetingRegister = {}
    this._knownBlocks = LRUCache({
      max: 1000
    })
    this._seededPeers = LRUCache({
      max: 1000
    })
    this._queue = queue((task, cb) => {
      if (task.constructor === Array) {
        this._engine.persistence.getBulk(task).then((res) => {
          cb(null, res)
        })
          .catch((err) => {
            cb(err)
          })
      } else {
        this._engine.persistence.get(task).then((res) => {
          cb(null, res)
        })
          .catch((err) => {
            cb(err)
          })
      }
    })

    if (config.p2p.stats.enabled) {
      this._interval = setInterval(() => {
        debug(`peers count ${this.manager.peerBookConnected.getPeersCount()}`)
      }, config.p2p.stats.interval * 1000)
    }
  }

  get bundle (): Bundle {
    return this._bundle
  }

  get manager (): PeerManager {
    return this._manager
  }

  get peer (): PeerInfo {
    return this._peer
  }

  get peerBook (): ManagedPeerBook {
    return this.manager.peerBook
  }

  get reportSyncPeriod (): Function {
    return this._engine.receiveSyncPeriod
  }

  get blockpool (): BlockPool {
    return this._blockPool
  }

  get multiverse (): Multiverse {
    return this._multiverse
  }

  set multiverse (multiverse: Multiverse) {
    this._multiverse = multiverse
  }

  _pipelineStartNode () {
    debug('_pipelineStartNode')

    return [
      // Create PeerInfo for local node
      (cb: Function) => {
        this._logger.info('generating peer info')
        PeerInfo.create(cb)
      },

      // Join p2p network
      (peerInfo: PeerInfo, cb: Function) => {
        const peerId = peerInfo.id.toB58String()
        this._logger.info(`registering addresses for ${peerId}`)

        peerInfo.multiaddrs.add(multiaddr('/p2p-websocket-star'))

        // peerInfo.multiaddrs.add(Signaling.getAddress(peerInfo))
        peerInfo.multiaddrs.add(`/ip4/0.0.0.0/tcp/0/ipfs/${peerId}`)
        peerInfo.multiaddrs.add(`/ip6/::1/tcp/0/ipfs/${peerId}`)

        peerInfo.meta = {
          p2p: {
            networkId: NETWORK_ID
          },
          ts: {
            connectedAt: DATETIME_STARTED_AT,
            startedAt: DATETIME_STARTED_AT
          },
          version: {
            protocol: PROTOCOL_PREFIX,
            ...getVersion()
          }
        }
        this._peer = peerInfo

        cb(null, peerInfo)
      },

      // Create node
      (peerInfo: PeerInfo, cb: Function) => {
        this._logger.info('creating P2P node')

        const opts = {
          signaling: Signaling.initialize(peerInfo),
          relay: false
        }
        this._bundle = new Bundle(peerInfo, this.peerBook, opts)

        cb(null, this._bundle)
      },
      (bundle: Object, cb: Function) => {
        this._logger.info('starting P2P node')

        bundle.start((err) => {
          if (err) {
            this._logger.error(err)
          }
          cb(err, bundle)
        })
      },

      // Register event handlers
      (bundle: Object, cb: Function) => {
        this._logger.info('registering event handlers')

        this.bundle.on('peer:discovery', (peer) => {
          return this.manager.onPeerDiscovery(peer).then(() => {
            if (this._shouldStopDiscovery()) {
              debug(`peer:discovery - quorum of ${QUORUM_SIZE} reached, if testnet stopping discovery`)
              // return Promise.resolve(true)
              return this.stopDiscovery()
            }
          })
        })

        this.bundle.on('peer:connect', (peer) => {
          return this.manager.onPeerConnect(peer)
            .then((header) => {
              if (header !== undefined && header.getHeight() !== undefined) {
                const highestBlock = this._engine.multiverse.getHighestBlock()
                if (highestBlock !== undefined) {
                  if (header.getHeight() + 2 < highestBlock.getHeight()) {
                    this.sendBlockToPeer(highestBlock, peer.id.toB58String())
                  }
                }
              }
            })
            .catch((err) => {
              this._logger.error(err)
              return this.manager.onPeerDisconnect(peer).then(() => {
                if (this._shouldStartDiscovery()) {
                  debug(`peer:disconnect - Quorum of ${QUORUM_SIZE} not reached, starting discovery`)
                  return this.startDiscovery()
                }
              })
            })
        })

        this.bundle.on('peer:disconnect', (peer) => {
          return this.manager.onPeerDisconnect(peer).then(() => {
            if (this._shouldStartDiscovery()) {
              debug(`peer:disconnect - Quorum of ${QUORUM_SIZE} not reached, starting discovery`)
              return this.startDiscovery()
            }
          })
        })

        cb(null)
      },

      // Register protocols
      (cb: Function) => {
        this._logger.info('Registering protocols')
        try {
          this.manager.registerProtocols(this.bundle)
          cb(null)
        } catch (err) {
          cb(err)
        }
      }
    ]
  }

  async getLiteMultiverse (latest: Object): Promise<*> {
    if (latest.getHeight() < 4) {
      return Promise.resolve([
        latest
      ])
    }
    const query = [
      'bc.block.' + (latest.getHeight() - 1),
      'bc.block.' + (latest.getHeight() - 2)
    ]

    try {
      const set = await this._engine.persistence.getBulk(query)
      // if it is a valid set of multiple options send it otherwise resolve with the latest
      if (set !== undefined && set !== false && set.length > 0) {
        set.unshift(latest)
        return Promise.resolve(set.sort((a, b) => {
          if (new BN(a.getHeight()).gt(new BN(b.getHeight())) === true) {
            return -1
          }
          if (new BN(a.getHeight()).lt(new BN(b.getHeight())) === true) {
            return 1
          }
          return 0
        }))
      }
      return Promise.resolve([latest])
    } catch (err) {
      this._logger.error(err)
      this._logger.warn('multiverse not set on disk')
      return Promise.resolve([latest])
    }
  }

  async start (nodeId) {
    // waterfall(this._pipelineStartNode(), (err) => {
    //  if (err) {
    //    this._logger.error(err)
    //    throw err
    //  }
    // })

    /* eslint-disable */
    const discovery = new Discovery(nodeId)
		anyDns().then((ip) => {

    this._p2p = discovery.start()
    this._p2p.join(this._p2p.hash, this._p2p.port, (data) => {
		this._p2p.ip = ip

    const waypointDiscoveryInterval = 300000 + Math.floor(Math.random() * 50000)

    const waypoint = setInterval(() => {
     if(this._p2p !== undefined && this._p2p._discovery !== undefined){
        this._p2p.join(this._p2p.hash, this._p2p.port, (data) => {
            this._p2p._discovery.update()
        })
      }
    }, waypointDiscoveryInterval)

    this._engine._emitter.on('sendblockcontext', (msg) => {
      if(msg.data.constructor === Array.constructor) return
      const type = '0008W01'
      const sort = msg.data.sort((a,b) => {
        if(new BN(a.getHeight()).gt(new BN(b.getHeight())) === true){
          return -1
        }
        if(new BN(a.getHeight()).lt(new BN(b.getHeight())) === true){
          return -1
        }
        return 0
      })
      return this._p2p.qsend(msg.connection, '0008W01' + '[*]' +  msg.data.serializeBinary())
    })

    this._engine._emitter.on('sendblock', (msg) => {
      const type = '0008W01'
      this.getLiteMultiverse(msg.data).then((list) => {
          const serial = list.map((l) => { return l.serializeBinary() }).join(protocolBits[type])
          this._p2p.qsend(msg.connection, type + protocolBits[type] +  serial)
        .then(() => {
        	this._logger.info('block announced!')
				})
				.catch((err) => {
					this._logger.warn('critical block rewards feature is failing with this error')
					this._logger.error(err)
				})
      })
    })

    this._engine._emitter.on('announceblock', (msg) => {
      const type = '0008W01'
      this._logger.info('announceblock <- event')
      //this._engine.persistence.get('bc.block.' + msg.data.getHeight() - 1
      this.getLiteMultiverse(msg.data).then((list) => {
          const serial = list.map((l) => { return l.serializeBinary() }).join(protocolBits[type])
        	this._p2p.qbroadcast(type +
                             protocolBits[type] +
                             serial)
        .then(() => {
        	this._logger.info('block announced!')
				})
				.catch((err) => {
					this._logger.warn('critical block rewards feature is failing with this error')
					this._logger.error(err)
				})
      })
      .catch((err) => {
        this._logger.warn('critical block rewards feature is failing with this error')
        this._logger.error(err)
      })
    })

    this._logger.info('initialized far reaching discovery module')

    this._p2p.on('connection', (conn, info) => {

      (async () => {
                // greeting reponse to connection with provided host information and connection ID
                const address = conn.remoteAddress + ':' + conn.remotePort
                if (this._ds[address] === undefined) {
                    this._ds[address] = false
                }

                // get heighest block
                const latestBlock = await this._engine.persistence.get('bc.block.latest')
                const quorumState = await this._engine.persistence.get('bc.dht.quorum')
                const quorum = parseInt(quorumState, 10) // coerce for Flow

                if(this._p2p.totalConnections < USER_QUORUM && quorum === 1 && MIN_HEALTH_NET === false){
                    await this._engine.persistence.put('bc.dht.quorum', "0")
                } else if(this._p2p.totalConnections >= USER_QUORUM && quorum === 0){
                    await this._engine.persistence.put('bc.dht.quorum', "1")
                } else if (quorum === 0 && MIN_HEALTH_NET === true){
                    await this._engine.persistence.put('bc.dht.quorum', "1")
                }

                //https://github.com/webtorrent/bittorrent-dht/blob/master/client.js#L579r
                //const msg = '0000R01' + info.host + '*' + info.port + '*' + info.id.toString('hex')
                const type = '0008W01'
                const list = await this.getLiteMultiverse(latestBlock)
                const serial = list.map((l) => { return l.serializeBinary() }).join(protocolBits[type])
                const msg = type + protocolBits[type] + serial
                await this._p2p.qsend(conn, msg)

                //const { source, sink } = toPull.duplex(conn)

                //pull(
                //  pull.values([msg]),
                //  sink,
                //)

                //pull(
                //  source,
                //  pull.collect((err, data) => {
                //    //debug(err)
                //    //debug(data)
                //    this.peerDataHandler(conn, info, data)
                //  })
                //)

                conn.on('data', (data) => {
                    /* eslint-disable */
                    if(!data && this._ds[address] !== false){
                         const remaining = "" + this._ds[address]
                         this._ds[address] = false
                         this.peerDataHandler(conn, info, remaining)
                    } else {
												if(data.length > 95000) {
													 return
												}
												if(this._ds[address] !== undefined && this._ds[address] !== false && this._ds[address].length > 95000) {
													 this._ds[address] = false
													 return
												}
                        let chunk = data.toString()
                        if (chunk.length === 1382 && this._ds[address] === false) {
                            this._ds[address] = chunk
                        } else if (chunk.length === 1382 && this._ds[address] !== false) {
                            this._ds[address] = this._ds[address] + chunk
                        } else if (chunk.length !== 1382 && this._ds[address] !== false) {
                            const complete = "" + this._ds[address] + chunk
                            this._ds[address] = false
                            this.peerDataHandler(conn, info, complete)
                        } else {
                            this.peerDataHandler(conn, info, chunk)
                        }
                    }
                })

      })().catch(err => {
                        this._logger.error(err);
                })
            })

            /* eslint-disable */

            this._engine._emitter.on('getmultiverse', (obj) => {

                const type = '0009R01' // read selective block list (multiverse)
                const split = protocolBits[type]
                const low = obj.data.low
                const high = obj.data.high
                const msg = type + split + low + split + high
                this._p2p.qsend(obj.connection, msg)
                  .then((res) => {
                    if (res !== undefined && res.length !== undefined) {
                      this._logger.info(res.length + ' delivered')
                    }
                  })
                  .catch((err) => {
                    this._logger.error(new Error('critical write to peer socket failed'))
                    this._logger.error(err)
                  })
            })

          this._engine._emitter.on('putmultiverse', (msg) => {
            this._engine.getMultiverseHandler(msg, msg.data)
            .then((res) => {
              this._logger.info(res)
            })
            .catch((err) => {
                this._logger.error(err)
            })
          })

          this._engine._emitter.on('getblocklist', (request) => {
            const type = '0006R01'
            const split = protocolBits[type]
            const low = request.low
            const high = request.high
            const msg = type + split + low + split + high
            this._p2p.qsend(request.connection, msg).then((res) => {
              if (res !== undefined && res.length > 0) {
                return Promise.resolve(true)
              }
              return Promise.resolve(false)
            })
              .catch((err) => {
                this._logger.error(err)
                return Promise.resolve(false)
              })
          })

          this._engine._emitter.on('putblocklist', (msg) => {
            this._engine.stepSyncHandler(msg)
              .then(() => {
                this._logger.debug('stepSync complete sent')
              })
              .catch((err) => {
                this._logger.error(err)
              })
          })

          this._engine._emitter.on('putblock', (msg) => {
            this._logger.debug('candidate block ' + msg.data.getHeight() + ' recieved')
            this._engine.blockFromPeer(msg, msg.data)
          })

          /*
          * PEER SEEDER
          */
					this._p2p._seeder = discovery.seeder()

          this._p2p._seeder.on('peer', (peer) => {

              if(this._p2p.totalConnections > BC_MAX_CONNECTIONS){
                return
              }
              if(this._seededPeers.get(peer)) {
                return
              }

              this._seededPeers.set(peer, 1)

                     const channel = this._p2p.hash
                     const url = Url.parse(peer)
                     const h = url.href.split(':')
                     const obj = {
                         //id: crypto.createHash('sha1').update(peer).digest('hex'),
                         host: h[0],
                         port: Number(h[1]) + 1, // seeder broadcasts listen on one port below the peers address
                         retries: 0,
                         channel: Buffer.from(channel),
                     }
                     obj.id = obj.host + ':' + obj.port
                     obj.remotePort = obj.port
                     obj.remoteHost = obj.host

                     if(this._p2p.ip === obj.host) return
                           try {
                               const name = obj.host + ':' + obj.port + this._p2p.hash
                               this._p2p._discovery.emit('peer', name, obj, 'utp')

                           } catch (err) {
                               console.log('')
                           }
            })

      			this._p2p._seeder.start()
            this._manager._p2p = this._p2p
            this._engine._p2p = this._p2p

      this._logger.info('joined waypoint table')
            setInterval(() => {
                // this._logger.info('peers', Object.getOwnPropertyNames(this._p2p._discovery.dht))
                // this._logger.info('peers', this._p2p._discovery.dht._peers)
                this._logger.info('active waypoints:  ' + this._p2p.totalConnections)
                this._engine._emitter.emit('peerCount', this._p2p.totalConnections)
                if(this._p2p.totalConnections < USER_QUORUM && MIN_HEALTH_NET !== true) {
                  this._engine.persistence.put('bc.dht.quorum', '0')
                  .then(() => {
                      this._logger.info('searching for additional waypoints')
                  })
                  .catch((err) => {
                      this._logger.debug(err)
                  })
                }
            }, 5900)
   })
		})
		.catch((err) => {
      this._logger.debug('an error has occured determining local IP address')
      this._logger.error(err)
		})
     return Promise.resolve(true)
            /* eslint-enable */
  }

  // const protocolBits = {
  //   '0000R01': '[*]', // introduction
  //   '0001R01': '[*]', // reserved
  //   '0002W01': '[*]', // reserved
  //   '0003R01': '[*]', // reserved
  //   '0004W01': '[*]', // reserved
  //   '0005R01': '[*]', // list services
  //   '0006R01': '[*]', // read block heights
  //   '0007W01': '[*]', // write block heights
  //   '0008R01': '[*]', // read highest block
  //   '0008W01': '[*]', // write highest block
  //   '0009R01': '[*]', // read multiverse (selective sync)
  //   '0010W01': '[*]'  // write multiverse (selective sync)
  // }
  peerDataHandler (conn: Object, info: Object, str: ?string) {
    (async () => {
      if (str === undefined) { return }
      if (str.length < 8) { return }
      if (str.length > 95000) { return }

      // TODO: add lz4 compression for things larger than 1000 characters
      const type = str.slice(0, 7)
      if (protocolBits[type] === undefined) {
        return
      }

      this._logger.debug('peerDataHandler <- ' + type)
      // Peer Sent Highest Block
      if (type === '0007W01') {
        // this._logger.info('::::::::::::::::::::::::' + type)
        const parts = str.split(protocolBits[type])
        const rawUint = parts[1]
        const raw = new Uint8Array(rawUint.split(','))
        const block = BcBlock.deserializeBinary(raw)

        /* eslint-disable */
        this._engine._emitter.emit('putblock', {
          data: block,
          connection: conn
        })

      // Peer Requests Highest Block
      } else if (type === '0008R01') {
        //this._logger.info("::::::::::::::::::::::::" + type)
        const latestBlock = await this._engine.persistence.get('bc.block.latest')
        const msg = '0008W01' + protocolBits[type] + latestBlock.serializeBinary()
        const results = await this._p2p.qsend(conn, msg)

        if (results && results.length > 0) {
          this._logger.info('successful update sent to peer')
        }

      // Peer Requests Block Range
      } else if (type === '0006R01' || type === '0009R01') {

        //this._logger.info("::::::::::::::::::::::::" + type)
        const parts = str.split(protocolBits[type])
        const low = parts[1]
        const high = parts[2]

        let outboundType = '0007W01'
        if (type === '0009R01') {
          outboundType = '0010W01'
        }

        this._logger.info(outboundType)

        try {
          const query = range(max(2, low), (high + 1)).map((n) => {
            return 'bc.block.' + n
          })

          //console.log(query)
          this._logger.info(query.length + ' blocks requested by peer: ' + conn.remoteHost)
          this._queue.push(query, (err, res) => {

            if (err) {
              this._logger.warn(err)
            } else {
              const split = protocolBits[outboundType]
              const msg = [outboundType, res.map((r) => {
                return r.serializeBinary()
              })].join(split)
              this._p2p.qsend(conn, msg).then(() => {
                this._logger.info('sent message of length: ' + msg.length)
              })
                .catch((err) => {
                  this._logger.error(err)
                })
            }
          })
        } catch (err) {
          this._logger.error(err)
        }

      // Peer Sends Challenge Block
      } else if (type === '0011W01') {

        const parts = str.split(protocolBits[type])

        if(parts[1].indexOf(',') > -1) {
          const rawUint = parts[1]
          const raw = new Uint8Array(rawUint.split(','))
          const block = BcBlock.deserializeBinary(raw)

          this._engine._emitter.emit('putblock', {
            data: block,
            connection: conn
          })
        } else {
          const raw = new Uint8Array(parts[1])
          const block = BcBlock.deserializeBinary(raw)

          this._engine._emitter.emit('putblock', {
            data: block,
            connection: conn
          })
        }
      // Peer Sends New Block
      } else if (type === '0008W01') {
        //this._logger.info("::::::::::::::::::::::::" + type)
        const parts = str.split(protocolBits[type])

        let raw

        if(parts[1].indexOf(',') > -1) {
          const rawUint = parts[1]
          raw = new Uint8Array(rawUint.split(','))
        } else {
          raw = new Uint8Array(parts[1])
        }
        const block = BcBlock.deserializeBinary(raw)
        this._engine._emitter.emit('putblock', {
          data: block,
          connection: conn
        })

        try {
          const latestBlock = await this._engine.persistence.get('bc.block.latest')
          if(new BN(block.getHeight()).lt(new BN(latestBlock.getHeight())) === true){
            const msg = '0008W01' + protocolBits[type] + latestBlock.serializeBinary()
            await this._p2p.qsend(conn, msg)
          }
        } catch (err) {
          this._logger.error(err)
        }

      // Peer Sends Block List 0007 // Peer Sends Multiverse 001
      } else if (type === '0007W01' || type === '0010W01') {
        const parts = str.split(protocolBits[type])
        //this._logger.info("::::::::::::::::::::::::" + type)

        try {

          const list = parts.split(protocolBits[type]).reduce((all, rawBlock) => {
            const raw = new Uint8Array(rawBlock.split(','))
            all.push(BcBlock.deserializeBinary(raw))
            return all
          }, [])

          const sorted = list.sort((a, b) => {
            if (a.getHeight() > b.getHeight()) {
              return -1 // move block forward
            }
            if (a.getHeight() < b.getHeight()) {
              return 1 // move block forward
            }
            return 0
          })

          //this._logger.info(77777777777777777777777)
          if (type === '0007W01') {
        //this._logger.info("::::::::::::::::::::::::" + type)
            this._engine._emitter.emit('putblocklist', {
              data: {
                low: sorted[sorted.length - 1], // lowest block
                high: sorted[0] // highest block
              },
              connection: conn
            })
          } else if (type === '0010W01') {
        //this._logger.info("::::::::::::::::::::::::" + type)
            this._engine._emitter.emit('putmultiverse', {
              data: sorted,
              connection: conn
            })
          }
        } catch (err) {
          this._logger.debug('unable to parse: ' + type + ' from peer ')
        }
      } else {
        this._logger.info('unknown protocol flag received: ' + type)
      }

      return Promise.resolve(true)
    })().catch(err => {
      this._logger.debug(err)
    })
    //}
  }

  /**
   *  Start (all) discovery services
   *
   * @returns {Promise}
   */
  startDiscovery (): Promise<bool> {
    debug('startDiscovery()')

    if (!this.bundle) {
      return Promise.resolve(false)
    }

    return this.bundle.startDiscovery()
  }

  /**
   * Stop (all) discovery services
   *
   * @returns {Promise}
   */
  stopDiscovery (): Promise<bool> {
    debug('stopDiscovery()')

    if (!this.bundle) {
      return Promise.resolve(false)
    }

    return this.bundle.stopDiscovery()
  }

  /**
   * Should be discovery started?
   *
   * - Is bundle initialized?
   * - Is discovery already started?
   * - Is the quorum not reached yet?
   *
   * @returns {boolean}
   * @private
   */
  _shouldStartDiscovery (): bool {
    debug('_shouldStartDiscovery()')

    // Check if bundle is initialized and discovery is enabled
    const bundle = this.bundle
    if (!bundle || bundle.discoveryEnabled) {
      debug('_shouldStartDiscovery() - discovery enabled')
      return false
    }

    // Check if manager is initialized
    const manager = this.manager
    if (!manager) {
      debug('_shouldStartDiscovery() - manager null')
      return false
    }

    return !manager.hasQuorum
  }

  /**
   * Should be discovery stopped?
   *
   * - Is bundle initialized?
   * - Is discovery already stopped?
   * - Is the quorum reached already?
   *
   * @returns {*}
   * @private
   */
  _shouldStopDiscovery (): bool {
    debug('_shouldStopDiscovery()')

    // Check if bundle is initialized and discovery is enabled
    const bundle = this.bundle
    if (!bundle || !bundle.discoveryEnabled) {
      return false
    }

    // Check if manager is initialized
    const manager = this.manager
    if (!manager) {
      return false
    }

    return manager.hasQuorum
  }

  sendBlockToPeer (block: BcBlock, peerId: string) {
    this._logger.debug(`Broadcasting msg to peers, ${inspect(block.toObject())}`)

    const url = `${PROTOCOL_PREFIX}/newblock`
    this.manager.peerBookConnected.getAllArray().map(peer => {
      this._logger.debug(`Sending to peer ${peer}`)
      if (peerId === peer.id.toB58String()) {
        this.bundle.dialProtocol(peer, url, (err, conn) => {
          if (err) {
            this._logger.debug('Error sending message to peer', peer.id.toB58String(), err)
            this._logger.debug(err)
            return err
          }
          // TODO JSON.stringify?
          pull(pull.values([block.serializeBinary()]), conn)
        })
      }
    })
  }

  broadcastNewBlock (block: BcBlock, withoutPeerId: ?Object) {
    this._logger.debug(`broadcasting msg to peers, ${inspect(block.toObject())}`)

    let filters = []
    if (withoutPeerId !== undefined) {
      if (withoutPeerId.constructor === Array) {
        filters = withoutPeerId
      } else {
        filters.push(withoutPeerId)
      }
    }
    this._engine._emitter.emit('announceblock', { data: block, filters: filters })
  }

  // get the best multiverse from all peers
  triggerBlockSync () {
    // const peerMultiverses = []
    // Notify miner to stop mining
    this.reportSyncPeriod(true)

    this.manager.peerBookConnected.getAllArray().map(peer => {
      this.reportSyncPeriod(true)
      this.manager.createPeer(peer)
        .getMultiverse()
        .then((multiverse) => {
          debug('Got multiverse from peer', peer.id.toB58String())
          // peerMultiverses.push(multiverse)

          // if (peerMultiverses.length >= PEER_QUORUM_SIZE) {
          //  const candidates = peerMultiverses.reduce((acc: Array<Object>, peerMultiverse) => {
          //    if (peerMultiverse.length > 0 && validateBlockSequence(peerMultiverse)) {
          //      acc.push(peerMultiverse)
          //    }

          //    return acc
          //  }, [])

          //  if (candidates.length >= PEER_QUORUM_SIZE) {
          //    const uniqueCandidates = uniqBy((candidate) => candidate[0].getHash(), candidates)
          //    if (uniqueCandidates.length === 1) {
          //      // TODO: Commit as active multiverse and begin full sync from known peers
          //    } else {
          //      const peerMultiverseByDifficultySum = uniqueCandidates
          //        .map(peerBlocks => peerBlocks[0])
          //        .sort(blockByTotalDistanceSorter)

          //      const winningMultiverse = peerMultiverseByDifficultySum[0]
          //      // TODO split the work among multiple correct candidates
          //      // const syncCandidates = candidates.filter((candidate) => {
          //      //   if (winner.getHash() === candidate[0].getHash()) {
          //      //     return true
          //      //   }
          //      //   return false
          //      // })
          //      const lowestBlock = this.multiverse.getLowestBlock()
          //      // TODO handle winningMultiverse[0] === undefined, see sentry BCNODE-6F
          //      if (lowestBlock && lowestBlock.getHash() !== winningMultiverse[0].getHash()) {
          //        this._blockPool.maximumHeight = lowestBlock.getHeight()
          //        // insert into the multiverse
          //        winningMultiverse.map(block => this.multiverse.addNextBlock(block))
          //        // TODO: Use RXP
          //        // Report not syncing
          //        this.reportSyncPeriod(false)
          //      }
          //    }
          //  }
          // }
        })
    })
  }
}

export default PeerNode
