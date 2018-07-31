
import type { Engine } from '../engine'
const events = require('events')
const { Multiverse } = require('../bc/multiverse')
const { BlockPool } = require('../bc/blockpool')
const { Parser } = require('./parser')
const Dialer = require('./dialer').default
const logging = require('../logger')

export class PeerNode {
  _logger: Object // eslint-disable-line no-undef
  _engine: Engine // eslint-disable-line no-undef
  _multiverse: Multiverse
  _parser: Object
  _blockPool: BlockPool
  _events: Object
  _dialer: Dialer // eslint-disable-line no-undef

  constructor (engine: Engine) {
    this._engine = engine
    this._multiverse = new Multiverse(engine.persistence) /// !important this is a (nonselective) multiverse
    this._blockPool = new BlockPool(engine.persistence, engine._pubsub)
    this._dialer = new Dialer()
    this._logger = logging.getLogger(__filename)
    this._parser = new Parser()
    this._events = new events.EventEmitter()

    // TODO: possibly readd
    // if (config.p2p.stats.enabled) {
    //  this._interval = setInterval(() => {
    //    debug(`Peers count ${this.manager.peerBookConnected.getPeersCount()}`)
    //  }, config.p2p.stats.interval * 1000)
    // }
  }

  get dialer (): Dialer {
    return this._dialer
  }

  get node (): PeerNode {
    return this._node
  }

  async start () {
    try {
      this._node = await this._dialer.createNode()
      this._scan = await this._dialer.createDiscoveryScan()
      this._events.on('peerData', (msg) => {
        const peer = msg.peer
        const peerId = peer.id.toString('hex')
        const data = this._parser.readStr(msg.data)
        const type = data[0]

        // i -> peer introduction
        // r -> request (future)
        // b -> delivery of blocks

        if (type === 'i') { // peer introduction
          const parts = data.split('*')
          const host = parts[1]
          const port = parts[2]
          const remoteNodeId = parts[3]

          if (this._node.remoteNodeToPeerId[remoteNodeId] !== undefined) {
            return
          }

          this._node.remoteNodeToPeerId[remoteNodeId] = peerId
          this._node.peerToRemoteNodeId[peerId] = remoteNodeId

          const req = [remoteNodeId, {
            hostname: host,
            port: port
          }]

          this._node.join(req, () => {
            this._events.emit('newNode', req)
          })
        } else if (type === 'r') { // request

        } else if (type === 'b') { // bulk block delivery

        } else {
          this._logger.warn('unable to parse peer message type: ' + type)
        }
      })

      this._scan.on('connection', (peer, info, type) => {
        const peerId = peer.id.toString('hex')

        if (this._node.peerToRemoteNodeId[peerId] !== undefined) {
          return
        }

        peer.on('data', (data) => {
          this._events.emit('peerData', { peer: peer, data: data })
        })
      })

      this._scan.on('connection-closed', (connection, info) => {

      })

      return Promise.resolve(true)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  get multiverse (): Multiverse {
    return this._multiverse
  }

  set multiverse (multiverse: Multiverse) {
    this._multiverse = multiverse
  }

  // start
  // query
  // sendBlockToPeer
  // broadcastNewBlock
  // getPeersCount
  // getPeerEvent
  // getPeerEvent
  // putPeerEvent
}

export default PeerNode
