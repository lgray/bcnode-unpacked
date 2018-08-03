
const swarm = require('discovery-swarm')
const avon = require('avon')
const { config } = require('../config')
const logging = require('../logger')
// load
function blake2bl (input) {
  return avon.sumBuffer(Buffer.from(input), avon.ALGORITHMS.B).toString('hex').slice(64, 128)
}

function Discovery () {
  const hash = blake2bl('bt1_' + config.blockchainFingerprintsHash) // peers that do not update for one year
  this.port = 16612
  this._logger = logging.getLogger(__filename)
  this._logger.info(hash)
  this.hash = hash
  this.swarm = swarm({
    tcp: false,
    utp: true,
    dns: false,
    dht: true
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
