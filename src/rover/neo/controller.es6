/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
import type { Logger } from 'winston'
import type { Backoff } from 'backo'
import type { DfConfig } from '../../bc/validation'
const profiles = require('@cityofzion/neo-js/dist/common/profiles')
const { sites } = require('./mesh.json')
const NeoMesh = require('@cityofzion/neo-js/dist/node/mesh')
const NeoNode = require('@cityofzion/neo-js/dist/node/node')
const { inspect } = require('util')
const LRUCache = require('lru-cache')
const { isEmpty } = require('ramda')
const { shuffle } = require('lodash')

const { Block } = require('../../protos/core_pb')
const logging = require('../../logger')
const { errToString } = require('../../helper/error')
const { RpcClient } = require('../../rpc')
const { createUnifiedBlock } = require('../helper')
const { getBackoff } = require('../utils')
const { randRange } = require('../../utils/ramda')
const ts = require('../../utils/time').default // ES6 default export
const { ROVER_DF_VOID_EXIT_CODE } = require('../manager')

const PING_PERIOD = 20000
const localMesh = sites.reduce((all, site) => {
  if (site.type === 'RPC') {
    if (site.protocol === 'https' || site.protocol === 'http') {
      let port = 80
      let address = false
      if (site.port !== undefined) {
        port = Number(site.port)
      } else if (site.protocol === 'https') {
        port = 443
      } else if (site.url !== undefined && site.url.indexOf('https') > -1) {
        port = 443
      }
      // determine key availability. Accolade to @davidthamwf.
      if (site.address !== undefined) {
        address = site.address
      } else if (site.url !== undefined) {
        address = site.url
      }

      if (address.indexOf('http') < 0 && port !== 443) {
        address = 'http://' + address
      } else if (address.indexOf('https') < 0 && port === 443) {
        address = 'https://' + address
      }

      if (address !== false) {
        const obj = {
          domain: address,
          port: port
        }
        all.push(obj)
      }
    }
  }
  return all
}, [])

process.on('uncaughtError', (err) => {
  /* eslint-disable */
  console.trace(err)
  /* eslint-enable */
  process.exit()
})

type NeoBlock = { // eslint-disable-line no-undef
  hash: string,
  size: number,
  version: number,
  previousblockhash: string,
  merkleroot: string,
  time: number,
  index: number,
  nonce: string,
  nextconsensus: string,
  script: {
    invocation: string,
    verification: string,
  },
  tx: [{
    txid: string,
    size: number,
    type: string,
    version: number,
    attributes: any[],
    vin: any[],
    vout: any[],
    sys_fee: number,
    net_fee: number,
    scripts: any[],
    nonce: number
  }],
  confirmations: number,
  nextblockhash: string
}

function _createUnifiedBlock (block: NeoBlock): Block {
  const obj = {}

  obj.blockNumber = block.index
  obj.prevHash = block.previousblockhash
  obj.blockHash = block.hash
  obj.root = block.merkleroot
  obj.size = block.size
  obj.nonce = block.nonce
  obj.nextConsensus = block.nextconsensus
  obj.timestamp = block.time * 1000
  obj.version = block.version
  obj.transactions = block.tx.reduce(function (all, t) {
    const tx = {
      txHash: t.txid,
      // inputs: t.inputs,
      // outputs: t.outputs,
      marked: false
    }
    all.push(tx)
    return all
  }, [])

  const msg = new Block()
  msg.setBlockchain('neo')
  msg.setHash(obj.blockHash)
  msg.setPreviousHash(obj.prevHash)
  msg.setTimestamp(obj.timestamp)
  msg.setHeight(obj.blockNumber)
  msg.setMerkleRoot(obj.root)

  return msg
}

type PendingRequestPair = [number, number]
type PendingFiberPair = [number, Block]

/**
 * NEO Controller
 */
export default class Controller {
  _blockCache: LRUCache<string, bool>
  _rpc: RpcClient
  _logger: Logger
  _config: { isStandalone: bool, dfConfig: DfConfig }
  _neoMesh: Object
  _timeoutDescriptor: TimeoutID
  _networkRefreshIntervalDescriptor: IntervalID
  _checkFibersIntervalID: IntervalID
  _backoff: Backoff
  _pendingRequests: Array<PendingRequestPair>
  _pendingFibers: Array<PendingFiberPair>

  constructor (config: { isStandalone: bool, dfConfig: DfConfig }) {
    this._config = config
    this._logger = logging.getLogger(__filename)
    this._blockCache = new LRUCache({
      max: 500,
      maxAge: 1000 * 60 * 60
    })
    this._neoMesh = new NeoMesh(shuffle(profiles.rpc.mainnet.endpoints.concat(localMesh)).map(endpoint => {
      return new NeoNode({
        domain: endpoint.domain,
        port: endpoint.port
      })
    }))
    this._rpc = new RpcClient()
    this._backoff = getBackoff()
    this._pendingRequests = []
    this._pendingFibers = []
    ts.start()
  }

  init () {
    this._logger.debug('initialized')

    process.on('disconnect', () => {
      this._logger.info('parent exited')
      process.exit()
    })

    process.on('uncaughtException', (e) => {
      this._logger.error(`Uncaught exception: ${errToString(e)}`)
      process.exit(3)
    })

    const { dfBound, dfVoid } = this._config.dfConfig.neo

    const cycle = () => {
      this._timeoutDescriptor = setTimeout(() => {
        const node = this._neoMesh.getHighestNode()
        this._logger.debug(`Pending requests: ${inspect(this._pendingRequests)}, pending fibers: ${inspect(this._pendingFibers.map(([ts, b]) => { return [ts, b.toObject()] }))}`)

        if (isEmpty(this._pendingRequests)) {
          node.rpc.getBlockCount().then(height => node.rpc.getBlock(height - 1)).then(block => {
            const ts = block.time
            const requestTime = randRange(ts, ts + dfBound)
            this._pendingRequests.push([requestTime, block.index])
            // push second further to future
            this._pendingRequests.push([requestTime + 5, block.index + 1])
            setTimeout(cycle, 2000)
          }).catch(err => {
            this._logger.debug(`unable to start roving, could not get block count, err: ${err.message}`)
            setTimeout(cycle, 5000)
          })
          return
        }

        const [requestTimestamp, requestBlockHeight] = this._pendingRequests.shift()
        if (requestTimestamp <= ts.nowSeconds()) {
          node.rpc.getBlock(requestBlockHeight).then(block => {
            this._logger.debug(`neo height set to ${requestBlockHeight}`)
            if (!this._blockCache.has(requestBlockHeight)) {
              this._blockCache.set(requestBlockHeight, true)
              this._logger.debug(`Unseen block with hash: ${block.hash} => using for BC chain`)

              const unifiedBlock = createUnifiedBlock(block, _createUnifiedBlock)
              const formatTimestamp = unifiedBlock.getTimestamp() / 1000 << 0
              const currentTime = ts.nowSeconds()
              this._pendingFibers.push([formatTimestamp, unifiedBlock])

              const maxPendingHeight = this._pendingRequests[this._pendingRequests.length - 1][1]
              if (currentTime + 5 < formatTimestamp + dfBound) {
                this._pendingRequests.push([randRange(currentTime, formatTimestamp + dfBound), maxPendingHeight + 1])
              } else {
                this._pendingRequests.push([randRange(currentTime, currentTime + 5), maxPendingHeight + 1])
              }
            }
            cycle()
          }, reason => {
            this._logger.error(reason)
            throw new Error(reason)
          }).catch(err => {
            this._logger.debug(`error while getting new block height: ${requestBlockHeight}, err: ${errToString(err)}`)
            // postpone remaining requests
            this._pendingRequests = this._pendingRequests.map(([ts, height]) => [ts + 10, height])
            // prepend currentrequest back but schedule to try it in [now, now + 10s]
            this._pendingRequests.unshift([randRange(ts.nowSeconds(), ts.nowSeconds() + 10), requestBlockHeight])
            setTimeout(cycle, 5000)
          })
        } else {
          // prepend request back to queue - we have to wait until time it is scheduled
          this._pendingRequests.unshift([requestTimestamp, requestBlockHeight])
          setTimeout(cycle, 5000)
        }
      }, 4000)
    }

    const pingNode = (node: NeoNode) => {
      this._logger.debug('pingNode triggered.', `node: [${node.domain}:${node.port}]`)
      const t0 = Date.now()
      node.pendingRequests += 1
      node.rpc.getBlockCount()
        .then((res) => {
          this._logger.debug('getBlockCount success:', res)
          const blockCount = res
          node.blockHeight = blockCount
          node.index = blockCount - 1
          node.active = true
          node.age = Date.now()
          node.latency = node.age - t0
          node.pendingRequests -= 1
          this._logger.debug('node.latency:', node.latency)
        })
        .catch((err) => {
          this._logger.debug(`getBlockCount failed, ${err.reason}`)
          node.active = false
          node.age = Date.now()
          node.pendingRequests -= 1
        })
    }

    const checkFibers = () => {
      if (isEmpty(this._pendingFibers)) {
        this._logger.debug(`No fiber ready, waiting: ${inspect(
          this._pendingFibers.map(([ts, b]) => ([ts, b.getHash()]))
        )}`)
        return
      }
      this._logger.debug(`Fibers count ${this._pendingFibers.length}`)
      const fiberTs = this._pendingFibers[0][0]
      if (fiberTs + dfBound < ts.nowSeconds()) {
        const [, fiberBlock] = this._pendingFibers.shift()
        this._logger.debug('NEO Fiber is ready, going to call this._rpc.rover.collectBlock()')

        if (this._config.isStandalone) {
          this._logger.debug(`Would publish block: ${inspect(fiberBlock.toObject())}`)
          return
        }

        if (fiberTs + dfVoid < ts.nowSeconds()) {
          this._logger.debug(`Would publish block: ${inspect(fiberBlock.toObject())}`)
          process.exit(ROVER_DF_VOID_EXIT_CODE)
        }

        this._rpc.rover.collectBlock(fiberBlock, (err, response) => {
          if (err) {
            this._logger.debug(`Error while collecting block ${inspect(err)}`)
            return
          }
          this._logger.debug(`Collector Response: ${JSON.stringify(response.toObject(), null, 4)}`)
        })
      }
    }

    cycle()

    this._checkFibersIntervalID = setInterval(checkFibers, 1000)

    // Ping all nodes in order to setup their height and latency
    this._neoMesh.nodes.forEach((node) => {
      pingNode(node)
    })

    setInterval(() => {
      // this._logger.info(`peer count pool: ${pool.numberConnected()} dp: ${network.discoveredPeers}, sp: ${network.satoshiPeers}, q: ${network.hasQuorum()}, bh: ${network.bestHeight}`)
      const pendingUpdate = Math.floor(this._neoMesh.nodes.reduce((all, node) => {
        all = all + node.pendingRequests
        return all
      }, 0) / this._neoMesh.nodes.length)
      const active = this._neoMesh.nodes.reduce((all, node) => {
        if (node.active !== undefined && node.active === true) {
          all++
        }
        return all
      }, 0)
      this._logger.info('mesh count pool: ' + active + '/' + this._neoMesh.nodes.length + ' pending state changes: ' + pendingUpdate)
    }, 9 * 1000)

    // Ping a random node periodically
    // TODO: apply some sort of priority to ping inactive node less frequent
    this._networkRefreshIntervalDescriptor = setInterval(() => {
      pingNode(this._neoMesh.getRandomNode())
    }, PING_PERIOD)
  }

  close () {
    ts.stop()
    this._timeoutDescriptor && clearTimeout(this._timeoutDescriptor)
    this._networkRefreshIntervalDescriptor && clearInterval(this._networkRefreshIntervalDescriptor)
    this._checkFibersIntervalID && clearInterval(this._checkFibersIntervalID)
  }
}
