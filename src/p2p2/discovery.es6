
const swarm = require('discovery-swarm')
const avon = require('avon')
const { config } = require('../config')
// load
function blake2bl (input) {
  return avon.sumBuffer(Buffer.from(input), avon.ALGORITHMS.B).toString('hex').slice(64, 128)
}

export class Discovery {
  port: Number
  swarm: Object
  enableTcp: boolean
  enableUtp: boolean
  enableDht: boolean
  constructor (opts: ?Object) {
    this.port = opts.port || 16600 + Math.floor(Math.random() * 20)
    this.enableTcp = opts.enableTcp || false
    this.enableUtp = opts.enableUtp || true
    this.enableDht = opts.enableDht || false

    if (opts !== undefined) {
      Object.keys(opts).map(function (k) {
        this[k] = opts[k]
      })
    }
  }

  start (): ?Promise<boolean> {
    try {
      this.swarm = swarm({
        tcp: this.enableTcp,
        dht: this.enableDht,
        utp: this.enableUtp
      })

      this.hash = blake2bl(config.blockchainFingerprintsHash)
      this.swarm.listen(this.port)
      this.swarm.join(this.hash)
      return Promise.resolve(true)
    } catch (err) {
      return Promise.reject(err)
    }
  }

  stop (): Promise<boolean> {
    if (this.swarm !== undefined) {
      this.swarm.leave(this.hash)
      return Promise.resolve(true)
    }
    return Promise.resolve(false)
  }
}

export default Discovery
