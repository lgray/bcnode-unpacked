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
const { inspect } = require('util')
const WavesApi = require('waves-api')
const request = require('request')
const LRUCache = require('lru-cache')
const { isEmpty } = require('ramda')

const { Block } = require('../../protos/core_pb')
const { getLogger } = require('../../logger')
const { errToString } = require('../../helper/error')
const { blake2b } = require('../../utils/crypto')
const { RpcClient } = require('../../rpc')
const { createUnifiedBlock } = require('../helper')
const { getBackoff } = require('../utils')
const { randRange } = require('../../utils/ramda')
const ts = require('../../utils/time').default // ES6 default export

const WAVES_NODE_ADDRESS = WavesApi.MAINNET_CONFIG.nodeAddress

type WavesTransaction = {
  type: number,
  id: string,
  sender: string,
  senderPublicKey: string,
  fee: number,
  timestamp: number,
  signature: string,
  recipient: string,
  assetId: string,
  amount: number,
  feeAsset: string,
  attachment: string
}

type WavesBlock = {
  version: number,
  timestamp: number,
  reference: string,
  'nxt-consensus': {
    'base-target': number,
    'generation-signature': string
  },
  features: Array<any>,
  generator: string,
  signature: string,
  blocksize: number,
  fee: number,
  transactions: WavesTransaction[],
  height: number
}

type WavesHeader = {
  version: number,
  timestamp: number, // e.g. 1530795651152
  reference: string,
  "nxt-consensus": {
    "base-target": number,
    "generation-signature": string
  },
  features: number[],
  generator: string,
  signature: string,
  blocksize: number,
  transactionCount: number,
  height: number
}

const getMerkleRoot = (block) => {
  if (!block.transactions || (block.transactions.length === 0)) {
    return blake2b(block.signature)
  }

  const txs = block.transactions.map((tx) => tx.id)
  return txs.reduce((acc, el) => blake2b(acc + el), '')
}

export const getLastHeight = (): Promise<WavesHeader> => {
  return new Promise((resolve, reject) => {
    request({
      url: `${WAVES_NODE_ADDRESS}/blocks/headers/last`,
      headers: { 'Accept': 'application/json' }
    }, (error, response, body) => {
      if (error) {
        return reject(error)
      }

      const data = JSON.parse(body)
      if (data.status === 'error') {
        return reject(data.details)
      }
      return resolve(data)
    })
  })
}

const getBlock = (height: number): Promise<WavesBlock> => {
  return new Promise((resolve, reject) => {
    request({
      url: `${WAVES_NODE_ADDRESS}/blocks/at/${height}`,
      headers: { 'Accept': 'application/json' }
    }, (error, response, body) => {
      if (error) {
        return reject(error)
      }

      const data = JSON.parse(body)
      if (data.status === 'error') {
        return reject(data.details)
      }
      return resolve(data)
    })
  })
}

function _createUnifiedBlock (block): Block {
  const obj = {
    blockNumber: block.height,
    prevHash: block.reference,
    blockHash: block.signature,
    root: getMerkleRoot(block),
    fee: block.fee,
    size: block.blocksize,
    generator: block.generator,
    genSignature: block['nxt-consensus']['generation-signature'],
    baseTarget: block['nxt-consensus']['base-target'],
    timestamp: parseInt(block.timestamp, 10),
    version: block.version,
    transactions: block.transactions.reduce(
      function (all, t) {
        all.push({
          txHash: t.id,
          // inputs: t.inputs,
          // outputs: t.outputs,
          marked: false
        })
        return all
      },
      []
    )
  }

  const msg = new Block()
  msg.setBlockchain('wav')
  msg.setHash(obj.blockHash)
  msg.setPreviousHash(obj.prevHash)
  msg.setTimestamp(obj.timestamp)
  msg.setHeight(obj.blockNumber)
  msg.setMerkleRoot(obj.root)

  return msg
}

/**
 * WAV Controller
 */
export default class Controller {
  _config: { isStandalone: bool, dfConfig: DfConfig }
  _logger: Logger
  _rpc: RpcClient
  _timeoutDescriptor: TimeoutID
  _checkFibersIntervalID: IntervalID
  _blockCache: LRUCache<string, bool>
  _lastBlockHeight: number
  _backoff: Backoff
  _pendingRequests: Array<[number, number]>
  _pendingFibers: Array<[number, Block]>

  constructor (config: { isStandalone: bool, dfConfig: DfConfig }) {
    this._config = config
    this._logger = getLogger(__filename)
    this._rpc = new RpcClient()
    this._blockCache = new LRUCache({ max: 500 })
    this._lastBlockHeight = 0
    this._backoff = getBackoff()
    this._pendingRequests = []
    this._pendingFibers = []
    ts.start()
  }

  init () {
    this._logger.debug('Initialized')

    process.on('disconnect', () => {
      this._logger.info('Parent exited')
      process.exit()
    })

    process.on('uncaughtException', (e) => {
      this._logger.error(`Uncaught exception: ${errToString(e)}`)
      process.exit(3)
    })

    const DFBound = this._config.dfConfig.wav.DFBound

    const cycle = () => {
      this._timeoutDescriptor = setTimeout(() => {
        this._logger.debug(`Pending requests: ${inspect(this._pendingRequests)}, pending fibers: ${inspect(this._pendingFibers.map(([ts, b]) => { return [ts, b.toObject()] }))}`)

        if (isEmpty(this._pendingRequests)) {
          getLastHeight().then(({ height, timestamp }) => {
            const ts = timestamp / 1000 << 0
            const requestTime = randRange(ts, ts + DFBound)
            this._pendingRequests.push([requestTime, height - 1])
            // push second further to future
            this._pendingRequests.push([requestTime + randRange(5, 15), height])
            cycle()
          }).catch(err => {
            this._logger.warn(`Unable to start roving, could not get block count, err: ${err.message}`)
            cycle()
          })
          return
        }

        const [requestTimestamp, requestBlockHeight] = this._pendingRequests.shift()
        if (requestTimestamp <= ts.nowSeconds()) {
          getBlock(requestBlockHeight).then(block => {
            this._logger.debug(`Got block at height : "${requestBlockHeight}"`)
            if (!this._blockCache.has(requestBlockHeight)) {
              this._blockCache.set(requestBlockHeight, true)
              this._logger.debug(`Unseen block with hash: ${block.signature} => using for BC chain`)

              const unifiedBlock = createUnifiedBlock(block, _createUnifiedBlock)
              const formatTimestamp = unifiedBlock.getTimestamp() / 1000 << 0
              const currentTime = ts.nowSeconds()
              this._pendingFibers.push([formatTimestamp, unifiedBlock])

              const maxPendingHeight = this._pendingRequests[this._pendingRequests.length - 1][1]
              if (currentTime + 5 < formatTimestamp + DFBound) {
                this._pendingRequests.push([randRange(currentTime, formatTimestamp + DFBound), maxPendingHeight + 1])
              } else {
                this._pendingRequests.push([randRange(currentTime, currentTime + 5), maxPendingHeight + 1])
              }
            }
            this._backoff.reset()
            cycle()
          }, reason => {
            throw new Error(reason)
          }).catch(err => {
            this._logger.warn(`Error while getting new block height: ${requestBlockHeight}, err: ${errToString(err)}`)
            const moveBySeconds = Math.ceil(this._backoff.duration() / 1000)
            // postpone remaining requests
            this._pendingRequests = this._pendingRequests.map(([ts, height]) => [ts + moveBySeconds, height])
            // prepend currentrequest back but schedule to try it in [now, now + 10s]
            this._pendingRequests.unshift([randRange(ts.nowSeconds(), ts.nowSeconds() + 10) + moveBySeconds, requestBlockHeight])
            cycle()
          })
        } else {
          // prepend request back to queue - we have to wait until time it is scheduled
          this._pendingRequests.unshift([requestTimestamp, requestBlockHeight])
          cycle()
        }
      }, 1000)
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
      if (fiberTs + DFBound <= ts.nowSeconds()) {
        const [, fiberBlock] = this._pendingFibers.shift()
        this._logger.debug('WAV Fiber is ready, going to call this._rpc.rover.collectBlock()')

        if (this._config.isStandalone) {
          this._logger.debug(`Would publish block: ${inspect(fiberBlock.toObject())}`)
          return
        }

        this._rpc.rover.collectBlock(fiberBlock, (err, response) => {
          if (err) {
            this._logger.error(`Error while collecting block ${inspect(err)}`)
            return
          }
          this._logger.debug(`Collector Response: ${JSON.stringify(response.toObject(), null, 4)}`)
        })
      }
    }

    cycle()

    this._checkFibersIntervalID = setInterval(checkFibers, 1000)
  }

  close () {
    ts.stop()
    this._timeoutDescriptor && clearTimeout(this._timeoutDescriptor)
    this._checkFibersIntervalID && clearInterval(this._checkFibersIntervalID)
  }
}
