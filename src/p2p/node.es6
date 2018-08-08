/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

/* eslint-disable */
import type { Engine } from '../engine'

const { inspect } = require('util')

const Url = require('url')
const PeerInfo = require('peer-info')
const queue = require('async/queue')
const multiaddr = require('multiaddr')
const pull = require('pull-stream')
const events = require('events')
const toPull = require('stream-to-pull-stream')
// const utp = require('utp-native')

const LRUCache = require('lru-cache')
const zlib = require('zlib')
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
const LOW_HEALTH_NET = process.env.LOW_HEALTH_NET === 'true'

const { range, max } = require('ramda')
const { protocolBits, anyDns } = require('../engine/helper')
// const waterfall = require('async/waterfall')
// const { toObject } = require('../helper/debug')
// const { validateBlockSequence } = require('../bc/validation')


function toBuffer (str) {
  if (Buffer.isBuffer(str)) return str
  if (ArrayBuffer.isView(str)) return Buffer.from(str.buffer, str.byteOffset, str.byteLength)
  if (typeof str === 'string') return Buffer.from(str, 'hex')
  throw new Error('Pass a buffer or a string')
}

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
  _ds: Object // eslint-disable-line no-undef
  _p2p: Object // eslint-disable-line no-undef
  _queue: Object // eslint-disable-line no-undef

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
        debug(`Peers count ${this.manager.peerBookConnected.getPeersCount()}`)
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
    //const waypoint = setInterval(() => {
    //  this._p2p.announce(this._p2p.hash, this._p2p.port, function() {
    //    this._logger.info('confirmed waypoint key')
    //  })
    //}, 15000)

    this._engine._emitter.on('sendblock', (msg) => {
      this._logger.info('sendBlock event triggered')
      (async () => {
        // check required fields
        if(!msg || msg.data === undefined || msg.connection === undefined){
          return
        }
        await this._p2p.qsend(msg.connection, '0008W01' + '[*]' +  msg.data.serializeBinary())
      }
            )().catch(err => {
                    this._logger.error(err)
            })
    })

    this._engine._emitter.on('announceblock', (msg) => {
      this._logger.info('announceblock <- event')
			if(msg.filters !== undefined && msg.filters.length > 0){
      	this._p2p.qbroadcast('0008W01' + '[*]' +  msg.data.serializeBinary(), msg.filters)
        .then(() => {
        	this._logger.info('block announced!')
				})
				.catch((err) => {
					this._logger.error(err)
				})
			} else {
      	this._p2p.qbroadcast('0008W01' + '[*]' +  msg.data.serializeBinary())
        .then(() => {
        	this._logger.info('block announced!')
				})
				.catch((err) => {
					this._logger.error(err)
				})
			}
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

                if(this._p2p.totalConnections >= quorum && quorum === 0){
                    await this._engine.persistence.put('bc.dht.quorum', "1")
                } else if (quorum === 0 && LOW_HEALTH_NET !== false){
                    await this._engine.persistence.put('bc.dht.quorum', "1")
                }

        //https://github.com/webtorrent/bittorrent-dht/blob/master/client.js#L579r
                //const msg = '0000R01' + info.host + '*' + info.port + '*' + info.id.toString('hex')
                const type = '0008W01'
                const msg = type + protocolBits[type] + latestBlock.serializeBinary()

                conn.on('data', (data) => {
                    console.log('DATA REQUEST SIZE: ' + data.length)
                    if(!data && this._ds[address] !== false){
                         const remaining = "" + this._ds[address]
                         this._ds[address] = false
                         this.peerDataHandler(conn, info, remaining)
                    } else {
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



                await this._p2p.qsend(conn, msg)

      })().catch(err => {
                        this._logger.error(err);
                })
            })


            this._p2p.on('connection-closed', (conn, info) => {
             // this.peerClosedConnectionHandler(conn, info)
             this._logger.info('------- CONNECTION CLOSED ------')
             //console.log(conn)
             //console.log(info)
             console.log("^^^^^^^^^^^^^^^^^^^^^^^^")
            })
            this._p2p.on('error', (err) => {
             this._logger.info('------- ERROR ------')
             console.trace(err)
             console.log("^^^^^^^^^^^^^^^^^^^^^^^^")
            })

            this._p2p.on('redundant-connection', (conn, info) => {
             this._logger.info('------- REDUNDANT CONNECTION ------')
             console.log("^^^^^^^^^^^^^^^^^^^^^^^^")
            })

            this._p2p.on('peer', (channel) => {
             this._logger.info('-------  PEER DISCOVERED ------')
             console.log(channel)
             console.log("^^^^^^^^^^^^^^^^^^^^^^^^")
            })

            this._p2p.on('drop', (peer, type) => {
             this._logger.info('------- PEER DROPPED ------')
                console.log(peer)
                console.log(type)
             console.log("^^^^^^^^^^^^^^^^^^^^^^^^")
            })

            this._p2p.on('peer-banned', (peer, type) => {
             this._logger.info('------- PEER BANNED ------')
             console.log(peer)
             console.log(type)
             console.log("^^^^^^^^^^^^^^^^^^^^^^^^")
            })

            this._p2p.on('connect-failed', (next, timeout) => {
             this._logger.info('------- CONNECT FAILED ------')
             console.log(next)
             console.log(timeout)
             console.log("^^^^^^^^^^^^^^^^^^^^^^^^")
            })

            this._p2p.on('handshake-timeout', (conn, timeout) => {
             this._logger.info('------- HANDSHAKE TIMEOUT ------')
             console.log(timeout)
             console.log("^^^^^^^^^^^^^^^^^^^^^^^^")
            })

            this._p2p.on('peer-rejected', (peer, type) => {
             this._logger.warn('peer rejected ')
             console.log(peer)
             console.log(type)
             console.log("^^^^^^^^^^^^^^^^^^^^^^^^")
            })

            this._p2p._discovery.on('peer', (data) => {
                console.log(data)
            })

            this._engine._emitter.on('getmultiverse', (request) => {

							console.log('bone art event get multiverse not fired <----------------')
						  console.log(request)
						  console.log(request)
						  console.log(request)
						  console.log(request)
						  console.log(request)
						  console.log(request)
						  console.log(request)
						  console.log(request)
              // check required fields
              if (!request || request.low === undefined || request.high === undefined || request.connection === undefined) {
                return
              }

              const type = '0009R01' // read selective block list (multiverse)
              const split = protocolBits[type]
              const low = request.low
              const high = request.high
              const msg = type + split + low + split + high
              this._p2p.qsend(request.connection, msg)
                .then((res) => {
                  if (res) {
                    this._logger.debug(res.length + ' delivered')
                  }
                })
                .catch((err) => {
                  this._logger.error(err)
                })
            })

          this._engine._emitter.on('putmultiverse', (msg) => {
            this._logger.info('getblocklist event requests')
            this._engine.getMultiverseHandler(msg, msg.data)
          })

          this._engine._emitter.on('getblocklist', (request) => {

            this._logger.info('getblocklist event requests')
            if (!request || request.low === undefined || request.high === undefined || request.connection === undefined) {
              return
            }

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
            this._logger.info('candidate block ' + msg.data.getHeight() + ' recieved')
            this._engine.blockFromPeer(msg, msg.data)
          })

            /*
             * PEER SEEDER
             */
					this._p2p._seeder = discovery.seeder()
					this._p2p._seeder.on('update', (data) => {
						console.log(' ----> UPDATE ' )
						console.log(data)
					})

          this._p2p._seeder.on('peer', (peer) => {

          if(this._seededPeers.get(peer)) {
             return
          }
          this._seededPeers.set(peer, 1)


                 const channel = Buffer.from(this._p2p.hash)
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

					if(this._p2p.ip === obj.host) return

         // the host name as described by external peers
         // first one is always the immediate response to current peer

                 console.log('--------------> PEER FROM SEEDER ' )
                 // add seen protection

                 try {

                         const name = obj.host + ':' + obj.port + this._p2p.hash
                         console.log(obj)
                         console.log("local hash: " + this._p2p.hash)
                         console.log("local port: " + this._p2p.port)

                         //this._p2p._discovery.dht._addPeer(obj, toBuffer(this._p2p.hash), { host: obj.host, port: obj.port })
                         //this._p2p._discovery.dht.emit('announce', obj, toBuffer(this._p2p.hash), { host: obj.host, port: obj.port })

                         this._p2p._discovery.emit('peer', name, obj, 'utp')

                         //conn.once('connection', (c) => {
                         //  this._p2p._onconnection(c, 'utp')
                         //})
                         //conn.once('close', conn.destroy)
                         //conn.once('exit', conn.destroy)
                         //conn.once('error', conn.destroy)

                         //this._logger.info('peer from seeder: ' + url.href)
                         //this._p2p._discovery.emit('peer', this._p2p.hash, obj)

                     } catch (err) {
                         console.log('unable to reuse server')
                     }
                     //this._p2p.addPeer(this._p2p.hash, obj)
                     //this._p2p.add(obj, () => {
                     //   this._logger.info('adding peer: ' + peer)
                     //     console.log('connected peers: ' + this._p2p.totalConnections)
                     //})


            })

      			this._p2p._seeder.start()
            this._manager._p2p = this._p2p
            this._engine._p2p = this._p2p


      this._logger.info('joined waypoint table')
            setInterval(() => {
                this._logger.info('active waypoints:  ' + this._p2p.totalConnections)
            }, 5000)

            setTimeout(() => {
                this._p2p._seeder.complete()
            }, 10000)

   })
		})
		.catch((err) => {

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

      // TODO: add lz4 compression for things larger than 1000 characters
      const type = str.slice(0, 7)

      if (protocolBits[type] === undefined) {
        return
      }

      this._logger.info('peerDataHandler <- ' + type)
      // Peer Sent Highest Block
      if (type === '0007W01') {
        const parts = str.split(protocolBits[type])
        const rawUint = parts[1]
        const raw = new Uint8Array(rawUint.split(','))
        const block = BcBlock.deserializeBinary(raw)

        this._engine._emitter.emit('putblock', {
          data: block,
          remoteHost: conn.remoteHost,
          remotePort: conn.remotePort
        })

      // Peer Requests Highest Block
      } else if (type === '0008R01') {
        const latestBlock = await this._engine.persistence.get('bc.block.latest')
        const msg = '0008W01' + protocolBits[type] + latestBlock.serializeBinary()
        const results = await this._p2p.qsend(conn, msg)

        if (results && results.length > 0) {
          this._logger.info('successful update sent to peer')
        }

      // Peer Requests Block Range
      } else if (type === '0006R01' || type === '0009R01') {
        const parts = str.split(protocolBits[type])
        const low = parts[1]
        const high = parts[2]

        let outboundType = '0007W01'
        if (type === '0009R01') {
          outboundType = '0010W01'
        }

        try {
          const query = range(max(2, low), (high + 1)).map((n) => {
            return 'bc.block.' + n
          })

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

      // Peer Sends New Block
      } else if (type === '0008W01') {
        const parts = str.split(protocolBits[type])
        const rawUint = parts[1]
        const raw = new Uint8Array(rawUint.split(','))
        const block = BcBlock.deserializeBinary(raw)

        this._engine._emitter.emit('putblock', {
          data: block,
          remoteHost: conn.remoteHost,
          remotePort: conn.remotePort
        })

      // Peer Sends Block List 0007 // Peer Sends Multiverse 001
      } else if (type === '0007W01' || type === '0010W01') {
        const parts = str.split(protocolBits[type])

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

          if (type === '0007W01') {
            this._engine._emitter.emit('putblockList', {
              data: {
                low: sorted[sorted.length - 1], // lowest block
                high: sorted[0] // highest block
              },
              remoteHost: conn.remoteHost,
              remotePort: conn.remotePort
            })
          } else if (type === '0010W01') {
            this._engine._emitter.emit('putmultiverse', {
              data: sorted,
              remoteHost: conn.remoteHost,
              remotePort: conn.remotePort
            })
          }
        } catch (err) {
          this._logger.error('unable to parse: ' + type + ' from peer ')
        }
      } else {
        this._logger.info('unable to parse: ' + type)
      }

      return Promise.resolve(true)
    })().catch(err => {
      this._logger.error(err)
    })
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
            this._logger.error('Error sending message to peer', peer.id.toB58String(), err)
            this._logger.error(err)
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

    // this.bundle.pubsub.publish('newBlock', Buffer.from(JSON.stringify(block.toObject())), () => {})
    // const raw = block.serializeBinary()

    let filters = []
    if (withoutPeerId !== undefined) {
      if (withoutPeerId.constructor === Array) {
        filters = withoutPeerId
      } else {
        filters.push(withoutPeerId)
      }
    }
    this._engine._emitter.emit('announceblock', { data: block, filters: filters })

    // const url = `${PROTOCOL_PREFIX}/newblock`
    // this.manager.peerBookConnected.getAllArray().map(peer => {
    //  this._logger.debug(`Sending to peer ${peer}`)
    //  const peerId = peer.id.toB58String()
    //  if (withoutPeerId === undefined || peerId !== withoutPeerId) {
    //    this.bundle.dialProtocol(peer, url, (err, conn) => {
    //      if (err) {
    //        this._logger.error('error sending message to peer', peer.id.toB58String(), err)
    //        this._logger.error(err)
    //        return err
    //      }

    //      // TODO JSON.stringify?
    //      pull(pull.values([block.serializeBinary()]), conn)
    //    })
    //  }
    // })
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
