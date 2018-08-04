
const swarm = require('discovery-swarm')
const avon = require('avon')
const { config } = require('../config')
const bootstrap = require('../utils/templates/bootstrap')
const logging = require('../logger')
// load
function blake2bl (input) {
  return avon.sumBuffer(Buffer.from(input), avon.ALGORITHMS.B).toString('hex').slice(64, 128)
}

function Discovery () {
  const hash = blake2bl('bcbt001' + config.blockchainFingerprintsHash) // peers that do not update for one year
  this.port = 16061
  this._logger = logging.getLogger(__filename)
  this._logger.info('edge selection <- ' + hash)
  this.hash = hash
  this.dht = swarm({
    dns: false,
    dht: {
      host: '18.210.15.44:16061',
      bootstrap: bootstrap,
      interval: 9000,
      timeBucketOutdated: 600000
    }
  })
}

Discovery.prototype = {

  start: function () {
    const localHash = this.hash
    this.dht.listen(this.port)
    this.dht.join(this.hash)
    this.dht.qsend = async (conn, msg) => {
      return new Promise((resolve, reject) => {
        try {
          conn.write(msg)
          return resolve({
            address: conn.remoteAddress + ':' + conn.remotePort,
            success: true,
            message: 'success'
          })
        } catch (err) {
          return resolve({
            address: conn.remoteAddress + ':' + conn.remotePort,
            success: false,
            message: err.message
          })
        }
      })
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

    this.dht.beacon = setInterval(() => {
      this.dht._discovery.dht.put({ v: localHash }, (err, hash) => {
        if (err) { this._logger.error(err) } else {
          setTimeout(() => {
            this.dht._discovery.dht.get(this.hash, (err, localHashObject) => {
              if (err) { this._logger.error(err) } else {
                this.dht._discovery.dht.lookup(localHash, (err) => {
                  if (err) { this._logger.error(err) } else {
                    this.dht._discovery.dht.announce(localHash, (err) => {
                      if (err) { this._logger.error(err) } else {
                        this._logger.debug('beacon cycled')
                      }
                    })
                  }
                })
              }
            })
          }, 20000)
        }
      })
    }, 60000)
    return this.dht
  },

  stop: function () {
    this.dht.leave(this.hash)
  }
}

module.exports = Discovery
