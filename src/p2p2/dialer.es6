
const fs = require('fs-extra')
const kad = require('kad')
const Discovery = require('./discovery')
const dns = require('bdns')
const logging = require('../logger')
const quasar = require('kad-quasar')
const levelup = require('levelup')
var leveldown = require('leveldown')

export class Dialer {
  _logger: Object // eslint-disable-line no-undef
  _quasarPort: Number
  _identity: String
  _dhtDirectory: String
  _dhtFile: String
  _networkKey: Number
  _discovery: Object
  _events: Object

  constructor (opts: ?Object) {
    // TODO: Confirm port is unused
    this._quasarPort = 100006 + Math.floor(Math.random() * 10000)
    this._identity = kad.utils.getRandomKeyString()
    this._dhtDirectory = opts.dhtDirectory || './dht'
    this._dhtFile = opts.dhtFile || this.dhtDirectory + '/dht.db'
    this._discovery = new Discovery()
    this._logger = logging.getLogger(__filename)
    fs.ensureDirSync(this.dhtDirectory)
  }

  async createNode (opts: ?Object): Promise<Object> {
    let ip = false
    try {
      ip = await dns.getIPv4()
    } catch (err) {
      try {
        this._logger.warn('unable to get external IPv4 address <- attempting IPv6')
        ip = await dns.getIPv6()
      } catch (err) {
        this._logger.error(err)
        return Promise.reject(new Error('unable to get external IPv4 or IPv6 address'))
      }
    }

    try {
      const node = kad({
        identity: this._identity,
        transport: new kad.UDPTransport(),
        storage: levelup(leveldown(this._dhtFile)),
        contact: {
          hostname: ip,
          port: this._quasarPort
        }
      })

      node.peerToRemoteNodeId = {}
      node.remoteNodeToPeerId = {}
      node.plugin(quasar)
      node.listen(this._quasarPort)
      return Promise.resolve(node)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  async createDiscoveryScan (): Promise<Object> {
    try {
      return Promise.resolve(this._discovery.start())
    } catch (err) {
      return Promise.reject(err)
    }
  }
}

export default Dialer
