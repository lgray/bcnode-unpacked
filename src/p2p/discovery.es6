
const swarm = require('discovery-swarm')
const avon = require('avon')
const { config } = require('../config')
const bootstrap = require('../utils/templates/bootstrap')
const logging = require('../logger')
// load
function blake2bl (input) {
  return avon.sumBuffer(Buffer.from(input), avon.ALGORITHMS.B).toString('hex').slice(64, 128)
}

function Discovery (id) {
  const hash = blake2bl('bcbt002' + config.blockchainFingerprintsHash) // peers that do not update for one year
  this.port = 16060
  this._logger = logging.getLogger(__filename)
  this._logger.info('edge selection <- ' + hash)
  this.hash = hash
  const options = {
    // id: id,
    dns: false,
    dht: {
      bootstrap: bootstrap,
      interval: 10000,
      timeBucketOutdated: 9000
    }
  }

  this.dht = swarm(options)
}

Discovery.prototype = {

  start: function () {
    this._logger.info('initializing far reach discovery from ' + this.port + '@' + this.hash)
    const localHash = this.hash
    // this.dht.addPeer('54.197.206.163', 16061)
    this.dht.listen(this.port)
    this.dht.join(this.hash, this.port)
    this.dht.addNode({ host: '18.210.15.44', port: 16061 })
    this.dht.addNode({ host: '54.197.206.163', port: 16061 })

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
            conn.destroy()
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
