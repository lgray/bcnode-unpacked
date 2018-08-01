
const swarm = require('discovery-swarm')
const avon = require('avon')
const { config } = require('../config')
const logging = require('../logger')
// load
function blake2bl (input) {
  return avon.sumBuffer(Buffer.from(input), avon.ALGORITHMS.B).toString('hex').slice(64, 128)
}

function Discovery () {
  const hash = blake2bl('bt01_' + config.blockchainFingerprintsHash) // peers that do not update for one year
  this.port = 16600 + Math.floor(Math.random() * 20)
  this._logger = logging.getLogger(__filename)
  this.hash = hash
  this._logger.info('hash: ' + hash)
  this.swarm = swarm({
    tcp: false,
    dht: false,
    utp: true
  })
}
Discovery.prototype = {

  start: function () {
    this.swarm.listen(this.port)

    this.swarm.join(this.hash)

    return this.swarm
  },

  stop: function () {
    this.swarm.leave(this.hash)
  }
}

module.exports = Discovery
