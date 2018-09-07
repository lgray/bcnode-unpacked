
const Client = require('bittorrent-tracker')
const swarm = require('discovery-swarm')
// const avon = require('avon')
const crypto = require('crypto')
const { config } = require('../config')
// const seeds = require('../utils/templates/seed')
const seederBootstrap = require('../utils/templates/collocation.json')
const dhtBootstrap = require('../utils/templates/bootstrap')
let seeds = seederBootstrap
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
// function randomIndex (items, last) {
//  const d = items[Math.floor(Math.random() * items.length)]
//  if (last !== undefined && last === d) {
//    return randomIndex(items, last)
//  }
//  return d
// }

function Discovery (nodeId) {
  // bootstrap from two randomly selected nodes

  if (process.env.MIN_HEALH_NETWORK === 'true') {
    seeds = seederBootstrap
  }

  if (process.env.BC_SEED_FILE !== undefined) {
    seeds = require(process.env.BC_SEED_FILE)
  }

  if (process.env.BC_SEED !== undefined) {
    let seed = process.env.BC_SEED
    if (seed.indexOf(',') > -1) {
      seed = seed.split(',')
      seeds = seeds.concat(seed)
    } else {
      seeds.unshift(seed)
    }
  }

  const hash = crypto.createHash('sha1').update('bcbt002' + config.blockchainFingerprintsHash).digest('hex') // 68cb1ee15af08755204674752ef9aee13db93bb7
  const maxConnections = process.env.BC_MAX_CONNECTIONS || config.bc.maximumWaypoints
  const seederPort = process.env.BC_SEEDER_PORT || 16060
  const port = process.env.BC_DISCOVERY_PORT || 16061
  this.options = {
    maxConnections: maxConnections,
    port: port,
    utp: process.env.BC_DISCOVERY_UTP || true,
    tcp: process.env.BC_DISCOVERY_TCP === 'true',
    dns: process.env.BC_DISCOVERY_MDNS === 'true',
    dht: {
      bootstrap: dhtBootstrap,
      interval: 180000 + random(1000),
      maxConnections: maxConnections,
      concurrency: maxConnections,
      host: 'tds-r3.blockcollider.org:16060'
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
    const refreshWindow = 190000 + Math.floor(Math.random() * 50000)

    client.on('error', (err) => {
      self._logger.debug(err.message)
    })

    client.on('warning', function (err) {
      self._logger.debug(err.message)
    })

    setInterval(() => {
      try {
        client.update()
      } catch (err) {
        this._logger.warn(err.message)
      }
    }, refreshWindow)

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
        return new Promise((resolve, reject) => {
          try {
                conn.resume()
                conn.write(msg)
                //conn.close()
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
          if (!res || res.success === false) {
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
