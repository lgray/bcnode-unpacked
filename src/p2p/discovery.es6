
const swarm = require('discovery-swarm')
const avon = require('avon')
const { config } = require('../config')
// load
function blake2bl (input) {
  return avon.sumBuffer(Buffer.from(input), avon.ALGORITHMS.B).toString('hex').slice(64, 128)
}

export class Discovery {
  swarm: Object
  hash: string
  port: number

  constructor () {
    this.port = 16600 + Math.floor(Math.random() * 20)
    this.hash = blake2bl('bt01_' + config.blockchainFingerprintsHash) // peers that do not update for one year
    this.swarm = swarm({
      tcp: false,
      dht: false,
      utp: true
    })
  }

  start () {
    this.swarm.listen(this.port)

    this.swarm.join(this.hash)

    return this.swarm
  }

  stop () {
    this.swarm.leave(this.hash)
  }
}
