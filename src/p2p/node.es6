/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Engine } from '../engine'

const { inspect } = require('util')

const PeerInfo = require('peer-info')
const waterfall = require('async/waterfall')
// const parallel = require('async/parallel')
const multiaddr = require('multiaddr')
const pull = require('pull-stream')
// const { uniqBy } = require('ramda')

const debug = require('debug')('bcnode:p2p:node')
const { config } = require('../config')
// const { toObject } = require('../helper/debug')
const { getVersion } = require('../helper/version')
const logging = require('../logger')

const { BcBlock } = require('../protos/core_pb')
const { ManagedPeerBook } = require('./book')
const Bundle = require('./bundle').default
const Discovery = require('./discovery')
const Signaling = require('./signaling').websocket
const { PeerManager, DATETIME_STARTED_AT, QUORUM_SIZE } = require('./manager/manager')
// const { validateBlockSequence } = require('../bc/validation')
const { Multiverse } = require('../bc/multiverse')
const { BlockPool } = require('../bc/blockpool')
const { anyDns } = require('../engine/helper')
// const { blockByTotalDistanceSorter } = require('../engine/helper')

const { PROTOCOL_PREFIX, NETWORK_ID } = require('./protocol/version')
//
const kad = require('kad')
const levelup = require('levelup')
const leveldown = require('leveldown')
const fs = require('fs-extra')

// const { PEER_QUORUM_SIZE } = require('./quorum')

export class PeerNode {
  _logger: Object // eslint-disable-line no-undef
  _engine: Engine // eslint-disable-line no-undef
  _interval: IntervalID // eslint-disable-line no-undef
  _bundle: Bundle // eslint-disable-line no-undef
  _manager: PeerManager // eslint-disable-line no-undef
  _peer: PeerInfo // eslint-disable-line no-undef
  _multiverse: Multiverse // eslint-disable-line no-undef
  _blockPool: BlockPool // eslint-disable-line no-undef
  _identity: string // eslint-disable-line no-undef
  _quasarPort: number // eslint-disable-line no-undef
  _quasarDbDirectory: string // eslint-disable-line no-undef
  _quasarDbPath: string // eslint-disable-line no-undef
  _quasar: Object // eslint-disable-line no-undef
  _scanner: Object // eslint-disable-line no-undef
  _externalIP: string // eslint-disable-line no-undef

  constructor (engine: Engine) {
    const manualDirectory = process.env.BC_DATA_DIR || config.persistence.path

    this._engine = engine
    this._multiverse = new Multiverse(engine.persistence) /// !important this is a (nonselective) multiverse
    this._blockPool = new BlockPool(engine.persistence, engine._pubsub)
    this._logger = logging.getLogger(__filename)
    this._manager = new PeerManager(this)
    this._identity = kad.utils.getRandomKeyString()
    this._quasarPort = 10006 + Math.floor(Math.random() * 10000)
    this._quasarDbDirectory = manualDirectory + '/quasar'
    this._quasarDbPath = manualDirectory + '/quasar/dht.db'

    fs.ensureDirSync(manualDirectory + '/quasar')

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

  get quasar (): Object {
    return this._quasar
  }

  set quasar (quasar: Object) {
    this._quasar = quasar
  }

  _pipelineStartNode () {
    debug('_pipelineStartNode')

    return [
      // Create PeerInfo for local node
      (cb: Function) => {
        this._logger.info('Generating peer info')
        PeerInfo.create(cb)
      },

      // Join p2p network
      (peerInfo: PeerInfo, cb: Function) => {
        const peerId = peerInfo.id.toB58String()
        this._logger.info(`Registering addresses for ${peerId}`)

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

      // Start
      // (quasar: Object, cb: Function) => {
      //  this._logger.info('starting Quasar P2P node')
      //  dns.getIPv4().then((ip) => {
      //    const contact = {
      //      hostname: ip,
      //      port: this._quasarPort
      //    }

      //    const network = kad({
      //      identity: this._identity,
      //      transport: new kad.UDPTransport(),
      //      storage: levelup(leveldown(this._quasarDbPath)),
      //      contact: contact
      //    })

      //    network.plugin(require('kad-quasar'))
      //    network.listen(this._quasarPort)
      //    cb(null, network)
      //  })
      //    .catch((err) => {
      //      this._logger.error(err)
      //      this._logger.error(new Error('unable to start p2p node'))
      //      cb(err)
      //    })
      // },

      // Start node
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
        this._logger.info('Registering event handlers')

        this.bundle.on('peer:discovery', (peer) => {
          return this.manager.onPeerDiscovery(peer).then(() => {
            if (this._shouldStopDiscovery()) {
              debug(`peer:discovery - Quorum of ${QUORUM_SIZE} reached, if testnet stopping discovery`)
              // return Promise.resolve(true)
              return this.stopDiscovery()
            }
          })
        })

        this.bundle.on('peer:connect', (peer) => {
          return this.manager.onPeerConnect(peer)
            .then((header) => {
              if (header !== undefined && header.getHeight !== undefined) {
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

      // Start discovery
      // (_discovery: Object, cb: Function) => {
      //  this._logger.info('starting far reaching discovery')
      //  try {
      //    const discovery = new Discovery()
      //    const scan = discovery.start()
      //    cb(null, scan)
      //  } catch (err) {
      //    this._logger.error(err)
      //    cb(err)
      //  }
      // },

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

  start () {
    waterfall(this._pipelineStartNode(), (err) => {
      if (err) {
        this._logger.error(err)
        throw err
      }

      this._logger.info('P2P node started')
    })

    // parallel([
    //  // initialize quasar p2p messaging
    //  (cb) => {
    this._logger.info('initialize p2p messaging...')

    anyDns().then((ip) => {
      this._externalIP = ip
      this._logger.info('external ip address <- ' + ip)
      try {
        const contact = {
          hostname: ip,
          port: this._quasarPort
        }

        this._quasar = kad({
          identity: this._identity,
          transport: new kad.UDPTransport(),
          storage: levelup(leveldown(this._quasarDbPath)),
          contact: contact
        })

        this._quasar.plugin(require('kad-quasar'))
        this._quasar.listen(this._quasarPort)
        this._logger.info('p2p messaging initialized')
      } catch (err) {
        this._logger.info('p2p messaging failed')
        this._logger.error(err)
      }
      this._logger.info('start far reaching discovery...')
      const discovery = new Discovery()
      this._scanner = discovery.start()
      this._logger.info('successful discovery start <- edge seed ' + discovery.hash)
      this._scanner.on('connection', (conn, info, type) => {
        this.peerNewConnectionHandler(conn, info, type)
      })
      this._scanner.on('connection-closed', (conn, info) => {
        this.peerClosedConnectionHandler(conn, info)
      })

      this._logger.info('p2p services ready')
    })
      .catch((err) => {
        this._logger.error(err)
        this._logger.error(new Error('unable to start quasar node'))
        // cb(err)
      })
    //  }
    // })
  }

  peerNewConnectionHandler (conn: Object, info: ?Object, type: ?string) {
    // TODO: Check if this connection is unique

    // create quasar link
    // TODO: move this to pull conn
    const idMessage = 'i*' + this._externalIP + '*' + this._quasarPort + '*' + this._identity
    this._logger.info('idMessage: ' + idMessage)
    conn.on('data', (data) => {
      this.peerDataHandler(conn, data)
    })
    conn.write(idMessage)
  }

  peerClosedConnectionHandler (conn: Object, info: Object) {
    this._logger.info('peer disconnect ')
    // TODO: Update current connected peers remove or otherwise
  }

  peerDataHandler (conn: Object, data: ?Object) {
    if (data === undefined) { return }

    // TODO: add lz4 compression for things larger than 1000 characters
    //
    const str = data.toString()
    const type = str[0]

    // TYPES
    // i - peer identity
    // b - bulk block delivery
    // r - request (future use)
    // const block = BcBlock.deserializeBinary(raw)

    if (type === 'i') {
      const parts = str.split('*')
      const host = parts[1]
      const port = parts[2]
      const remoteIdentity = parts[3]

      const req = [remoteIdentity, {
        hostname: host,
        port: port
      }]

      this._quasar.join(req, () => {
        this._logger.info('entered gravity well for seed ' + remoteIdentity)
      })
    } else if (type === 'b') {
      this._logger.info('bulk block type')
    } else if (type === 'r') {
      this._logger.info('request type')
    } else {
      this._logger.error('unable to parse incoming message')
      // TODO: downweight peer
    }
  }

  addNodeHandler (peer: Object, req: Array) {
    const nodeId = req[0]

    this._logger.info('node added: ' + nodeId)
    // TODO: check if nodeId has been seen before
    // if it has not continue with it and set the expire timeout
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

  broadcastNewBlock (block: BcBlock, withoutPeerId: ?string) {
    this._logger.debug(`Broadcasting msg to peers, ${inspect(block.toObject())}`)

    // this.bundle.pubsub.publish('newBlock', Buffer.from(JSON.stringify(block.toObject())), () => {})
    // const raw = block.serializeBinary()
    this.quasar.publishQuasar('newblock', block.toObject())

    const url = `${PROTOCOL_PREFIX}/newblock`
    this.manager.peerBookConnected.getAllArray().map(peer => {
      this._logger.debug(`Sending to peer ${peer}`)
      const peerId = peer.id.toB58String()
      if (withoutPeerId === undefined || peerId !== withoutPeerId) {
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
