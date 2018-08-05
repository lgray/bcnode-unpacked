
const Client = require('bittorrent-tracker')
const swarm = require('discovery-swarm')
const avon = require('avon')
const crypto = require('crypto')
const { config } = require('../config')
const bootstrap = require('../utils/templates/bootstrap')
// const seeds = require('../utils/templates/seed')
const logging = require('../logger')
// load
function blake2bl (input) {
  return avon.sumBuffer(Buffer.from(input), avon.ALGORITHMS.B).toString('hex').slice(64, 128)
}

function random (range) {
  return Math.floor(Math.random() * range)
}

function randomId () {
  return crypto.randomBytes(20)
}

function Discovery (nodeId) {
  const seeds = []
  seeds.unshift('udp://tds.blockcollider.org:16060')
  seeds.unshift('udp://tds.blockcollider.org:16060/announce')
  seeds.unshift('wss://tds.blockcollider.org:16060')
  seeds.unshift('wss://tds.blockcollider.org:16060/announce')
  seeds.unshift('ws://tds.blockcollider.org:16060')
  seeds.unshift('ws://tds.blockcollider.org:16060/announce')
  seeds.unshift('http://tds.blockcollider.org:16060')
  seeds.unshift('http://tds.blockcollider.org:16060/announce')

  const hash = blake2bl('bcbt002' + config.blockchainFingerprintsHash) // peers that do not update for one year
  const port = 16061
  this.options = {
    id: nodeId,
    dns: false,
    dht: {
      nodeId: nodeId,
      bootstrap: bootstrap,
      interval: 10000 + random(1000),
      timeBucketOutdated: (180000 + random(40000))
    }
  }
  this.streamOptions = {
    infoHash: Buffer.from(hash),
    peerId: Buffer.from(nodeId),
    port: port,
    announce: seeds
  }
  this.port = port
  this.nodeId = nodeId
  this._logger = logging.getLogger(__filename)
  this._logger.info('edge selection <- ' + hash)
  this.hash = hash
}

Discovery.prototype = {

  seeder: function () {
    const self = this
    const client = new Client(self.streamOptions)
    client.on('error', (err) => {
      self._logger.error(err.message)
    })

    client.on('warning', function (err) {
      self._logger.warn(err.message)
    })

    // start getting peers from the tracker
    // client.on('update', function (data) {
    //  console.log('got an announce response from tracker: ' + data.announce)
    //  console.log('number of seeders in the swarm: ' + data.complete)
    //  console.log('number of leechers in the swarm: ' + data.incomplete)
    // })

    // client.on('peer', function (addr) {
    //  console.log('found a peer: ' + addr) // 85.10.239.191:48623
    // })
    client.start()

    return client
  },

  start: function () {
    this._logger.info('initializing far reach discovery from ' + this.port + '@' + this.hash)
    const localHash = this.hash
    // this.dht.addPeer('54.197.206.163', 16061)
    // this.dht.addNode({ host: '18.210.15.44', port: 16061 })
    // this.dht.addNode({ host: '54.197.206.163', port: 16061 })
    this.dht = swarm(this.options)
    this.dht.listen(this.port)
    // add({ host: port: }, done)
    this.dht.add = (obj, done) => {
      if (obj.id === undefined) {
        obj.id = randomId()
      }
      this.dht.addNode(obj)
      this.dht.once('node', done)
    }
    this.dht.join(this.hash, this.port, () => {
      this._logger.info('joined network')
    })

    this.dht.getPeerByHost = (query) => {
      return this.dht.connections.filter((a) => {
        if (a.remoteHost === query.remoteHost && a.remotePort === query.remotePort) {
          return a
        }
      })
    }

    this.dht.qsend = async (conn, msg) => {
      const list = this.dht.getPeerByHost(conn)
      if (list.length < 1) { return Promise.resolve(false) }
      const tasks = list.reduce((all, conn) => {
        const a = new Promise((resolve, reject) => {
          try {
            conn.write(msg)
            return resolve({
              address: conn.remoteAddress + ':' + conn.remotePort,
              success: true,
              message: 'success'
            })
          } catch (err) {
            conn.close()
            return resolve({
              address: conn.remoteAddress + ':' + conn.remotePort,
              success: false,
              message: err.message
            })
          }
        })
        all.push(a)
        return all
      }, [])
      await Promise.all(tasks)
    }

    this.dht.qbroadcast = async (msg) => {
      const warnings = []
      for (const conn of this.dht.connections) {
        const res = await this.dht.qsend(conn, msg)
        if (!res.success) {
          warnings.push(res)
        }
      }
      return warnings
    }

    const signNetwork = () => {
      this.dht._discovery.dht.put({ v: localHash }, (err, hash) => {
        if (err) { this._logger.error(err) } else {
          // setTimeout(() => {
          //  if (this.dht._discovery.dht.connected !== undefined && this.dht._discovery.dht.connected.length > 0) {
          //    this.dht._discovery.dht.get(hash, (err, localHashObject) => {
          //      if (err) { this._logger.error(err) } else {
          //        this._logger.info('network signature: ' + hash.toString())
          //        this.dht._discovery.dht.lookup(localHash, (err) => {
          //          if (err) { this._logger.error(err) } else {
          //            this.dht._discovery.dht.announce(localHash, (err) => {
          //              if (err) { this._logger.error(err) } else {
          //                this._logger.debug('discovery beacon cycled')
          //              }
          //            })
          //          }
          //        })
          //      }
          //    })
          //  }
          // }, 20000)
        }
      })
    }
    this.dht.manualNetworkSigInverval = setInterval(signNetwork, 60000)
    return this.dht
  },

  stop: function () {
    this.dht.leave(this.hash)
  }
}

module.exports = Discovery
