
const Client = require('bittorrent-tracker')
const swarm = require('discovery-swarm')
// const avon = require('avon')
const crypto = require('crypto')
const { config } = require('../config')
// const bootstrap = require('../utils/templates/bootstrap')
// const seeds = require('../utils/templates/seed')
const bootstrap = require('../utils/templates/collocation.json')
const seeds = []
const logging = require('../logger')
// load
// function blake2bl (input) {
//  return avon.sumBuffer(Buffer.from(input), avon.ALGORITHMS.B).toString('hex').slice(64, 128)
// }

// function toBuffer (str) {
//  if (Buffer.isBuffer(str)) return str
//  if (ArrayBuffer.isView(str)) return Buffer.from(str.buffer, str.byteOffset, str.byteLength)
//  if (typeof str === 'string') return Buffer.from(str, 'hex')
//  throw new Error('Pass a buffer or a string')
// }

function random (range) {
  return Math.floor(Math.random() * range)
}

// function randomId () {
//  return crypto.randomBytes(20)
// }
function randomIndex (items, last) {
  const d = items[Math.floor(Math.random() * items.length)]
  if (last !== undefined && last === d) {
    return randomIndex(items, last)
  }
  return d
}

function Discovery (nodeId) {
  // bootstrap from two randomly selected nodes
  seeds.unshift(randomIndex(bootstrap))
  seeds.unshift(randomIndex(bootstrap, seeds[0]))

  if (process.env.BC_SEED !== undefined) {
    seeds.unshift(process.env.BC_SEED)
  }
  const hash = crypto.createHash('sha1').update('bcbt002' + config.blockchainFingerprintsHash).digest('hex') // 68cb1ee15af08755204674752ef9aee13db93bb7
  const maxConnections = process.env.BC_MAX_CONNECTIONS || 80
  const seederPort = process.env.BC_SEEDER_PORT || 16060
  const port = process.env.BC_DISCOVERY_PORT || 16061
  this.options = {
    // id: nodeId,
    // nodeId: nodeId,
    maxConnections: maxConnections,
    port: port,
    utp: process.env.BC_DISCOVERY_UTP || true,
    tcp: process.env.BC_DISCOVERY_TCP === 'true',
    dns: process.env.BC_DISCOVERY_MDNS === 'true',
    dht: {
      // nodeId: nodeId,
      bootstrap: ['18.210.15.44:16060'],
      interval: 30000 + random(1000),
      maxConnections: maxConnections,
      concurrency: maxConnections,
      host: 'tds.blockcollider.org:16060'
    }
  }
  this.streamOptions = {
    infoHash: hash,
    peerId: nodeId,
    port: seederPort,
    announce: seeds,
    quiet: true,
    log: false
  }
  this.port = port
  this.seederPort = seederPort
  this.nodeId = nodeId
  this._logger = logging.getLogger(__filename)
  this._logger.info('assigned edge <- ' + hash)
  this.hash = hash
}

Discovery.prototype = {

  seeder: function () {
    const self = this
    const client = new Client(self.streamOptions)
    client.on('error', (err) => {
      self._logger.debug(err.message)
    })

    client.on('warning', function (err) {
      self._logger.debug(err.message)
    })
    return client
  },

  start: function () {
    this._logger.info('initializing far reach discovery from ' + this.port + '@' + this.hash)
    this.dht = swarm(this.options)
    this.dht.hash = this.hash
    this.dht.port = this.port
    this.dht.listen(this.port)

    this.dht.getPeerByHost = (query) => {
      let list = this.dht.connections.filter((a) => {
        if (a.remoteHost === query.remoteHost && a.remotePort === query.remotePort) {
          return a
        }
      })

      if (list.length < 1 && query._utp !== undefined) {
        list.push(query)
        this.dht.connections.push(query)
        return list
      }
      return list
    }

    this.dht.qsend = async (conn, msg) => {
      /* eslint-disable */
      const list = this.dht.getPeerByHost(conn)
      this._logger.debug('peers to write: ' + list.length)
      if (list.length < 1) { return Promise.resolve(false) }
      const tasks = list.reduce((all, conn) => {
        const a = new Promise((resolve, reject) => {
          try {
                conn.resume()
                conn.write(msg)
                conn.close()
                return resolve({
                  address: conn.remoteAddress + ':' + conn.remotePort,
                  success: true,
                  message: "success"
                })
          } catch (err) {
            if(err) {
              return resolve({
                address: conn.remoteAddress + ':' + conn.remotePort,
                success: false,
                message: err.message
              })
            }
              return resolve({
                address: conn.remoteAddress + ':' + conn.remotePort,
                success: false,
                message: 'connection lost'
              })
          }
        })
        all.push(a)
        return all
      }, [])
      await Promise.all(tasks)
    }

    this.dht.qbroadcast = async (msg, filters) => {
      const warnings = []
      if (filters === undefined) {
        filters = []
      }
      for (const conn of this.dht.connections) {
        const idr = conn.remoteHost || conn.host
        if (filters.indexOf(idr) < 0) {
          const res = await this.dht.qsend(conn, msg)
          if (!res || res.length === 0) {
            warnings.push(res)
          }
        }
      }
      return warnings
    }
    return this.dht
  },

  stop: function () {
    this.dht.leave(this.hash)
  }
}

module.exports = Discovery
