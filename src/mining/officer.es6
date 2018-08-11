/*
 * Copyright (c) 2017-present, Block Collider developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Logger } from 'winston'
import type { PubSub } from '../engine/pubsub'
import type { RocksDb } from '../persistence'

const { writeFileSync } = require('fs')
const { inspect } = require('util')

const BN = require('bn.js')
const debug = require('debug')('bcnode:mining:officer')
const { mean, all, equals, flatten, fromPairs, last, range, values } = require('ramda')

const { prepareWork, prepareNewBlock, getUniqueBlocks } = require('./primitives')
const { getLogger } = require('../logger')
const { Block, BcBlock, BlockchainHeaders } = require('../protos/core_pb')
const { isDebugEnabled, ensureDebugPath } = require('../debug')
const { validateRoveredSequences, isValidBlock } = require('../bc/validation')
const { getBlockchainsBlocksCount } = require('../bc/helper')
const { WorkerPool } = require('./pool')
const ts = require('../utils/time').default // ES6 default export

const LOW_HEALTH_NET = process.env.LOW_HEALTH_NET === 'true'

type UnfinishedBlockData = {
  lastPreviousBlock: ?BcBlock,
  block: ?Block,
  currentBlocks: ?{ [blokchain: string]: Block },
  iterations: ?number,
  timeDiff: ?number
}

const keyOrMethodToChain = (keyOrMethod: string) => keyOrMethod.replace(/^get|set/, '').replace(/List$/, '').toLowerCase()
// const chainToSet = (chain: string) => `set${chain[0].toUpperCase() + chain.slice(1)}List` // UNUSED
const chainToGet = (chain: string) => `get${chain[0].toUpperCase() + chain.slice(1)}List`

export class MiningOfficer {
  _logger: Logger
  _minerKey: string
  _pubsub: PubSub
  _persistence: RocksDb
  _timers: Object
  _timerResults: Object
  _knownRovers: string[]
  _speedResults: number[]

  _collectedBlocks: { [blockchain: string]: number }
  _canMine: bool
  _workerPool: WorkerPool
  _unfinishedBlock: ?BcBlock
  _unfinishedBlockData: ?UnfinishedBlockData
  _paused: bool
  _blockTemplates: Object[]

  constructor (pubsub: PubSub, persistence: RocksDb, opts: { minerKey: string, rovers: string[] }) {
    this._logger = getLogger(__filename)
    this._minerKey = opts.minerKey
    this._pubsub = pubsub
    this._persistence = persistence
    this._knownRovers = opts.rovers
    this._workerPool = new WorkerPool(pubsub, persistence, opts)

    this._speedResults = []
    this._collectedBlocks = {}
    for (let roverName of this._knownRovers) {
      this._collectedBlocks[roverName] = 0
    }
    this._canMine = false
    this._timers = {}
    this._timerResults = {}
    this._unfinishedBlockData = { block: undefined, lastPreviousBlock: undefined, currentBlocks: {}, timeDiff: undefined, iterations: undefined }
    this._paused = false
    this._blockTemplates = []
    (async () => {
      try {
        await this._workerPool.init()
        const ready = await this._workerPool.allRise()
        this._workerPool._emitter.on('mined', this._handleWorkerFinishedMessage.bind(this))
        this._logger.info('worker pool initialized')
      } catch (err) {
        this._logger.error(err)
      }
    })
  }

  get persistence (): RocksDb {
    return this._persistence
  }

  get pubsub (): PubSub {
    return this._pubsub
  }

  get paused (): bool {
    return this._paused
  }

  set paused (paused: bool) {
    this._paused = paused
  }

  async simMining (): Promise<*> {
    const wp = this._workerPool
    if (!wp.initialized) {
      await this._workerPool.init()
      await wp.allRise()
      this._logger.info('worker pool initialized')
    }
  }

  async newRoveredBlock (rovers: string[], block: Block): Promise<number|false> {
    this._collectedBlocks[block.getBlockchain()] += 1

    this._logger.info('[] <- [] ' + 'rovered ' + block.getBlockchain() + ' block ' + block.getHeight() + ' ' + block.getHash())
    // TODO: Adjust minimum count of collected blocks needed to trigger mining
    if (!this._canMine && all((numCollected: number) => numCollected >= 1, values(this._collectedBlocks))) {
      this._canMine = true
    }

    if (this._canMine === true && LOW_HEALTH_NET === false) {
      try {
        const quorum = await this._persistence.get('bc.dht.quorum')
        if (parseInt(quorum, 10) < 1 && this._canMine === true) {
          this._logger.info('peer waypoint discovery in progress')
          this._canMine = false
          return Promise.resolve(false)
        }
      } catch (err) {
        this._canMine = false
        this._logger.error('quorum state is not persisted on disk')
        this._logger.error(err)
        return Promise.reject(new Error('critical error -> restart application'))
      }
    }

    // make sure the miner has at least two blocks of the depth
    if (this._canMine === true && LOW_HEALTH_NET === false) {
      try {
        const parent = await this._persistence.get('bc.block.parent')
        const latest = await this._persistence.get('bc.block.latest')
        if (parent.getHash() !== latest.getPreviousHash()) {
          this._logger.warn('after resync approval rovers must complete new multiverse')
          this._canMine = false
          return Promise.resolve(false)
        }
        if (parent.getHeight() === '1') {
          this._logger.warn('cannot mine over the genesis block without enabling low health network.')
          this._canMine = false
        }
      } catch (err) {
        this._canMine = false
        this._logger.error('unable to assert parent block of highest block')
        return Promise.reject(new Error('crtical error -> restart application'))
      }
    }

    // Check if _canMine
    if (!this._canMine) {
      const keys = Object.keys(this._collectedBlocks)
      const values = '[' + keys.reduce((all, a, i) => {
        const val = this._collectedBlocks[a]
        if (i === (keys.length - 1)) {
          all = all + a + ':' + val
        } else {
          all = all + a + ':' + val + ' '
        }
        return all
      }, '') + ']'

      const totalBlocks = keys.reduce((all, key) => {
        return all + this._collectedBlocks[key]
      }, 0)

      this._logger.info('constructing multiverse with blockchains ' + values)
      this._logger.info('multiverse depth ' + totalBlocks)
      return Promise.resolve(false)
    }

    // Check if peer is syncing
    if (this.paused) {
      this._logger.info(`mining and ledger updates disabled until initial multiverse threshold is met`)
      return Promise.resolve(false)
    }

    // Check if all rovers are enabled
    if (equals(new Set(this._knownRovers), new Set(rovers)) === false) {
      this._logger.info(`consumed blockchains manually overridden, mining services disabled, active multiverse rovers: ${JSON.stringify(rovers)}, known: ${JSON.stringify(this._knownRovers)})`)
      return Promise.resolve(false)
    }

    // $FlowFixMe
    return this.startMining(rovers, block)
      .then((res) => {
        this._logger.info('mining cycle initiated')
        return Promise.resolve(res)
      })
      .catch((err) => {
        this._logger.error(err)
        return Promise.reject(err)
      })
  }

  stop () {
    this.stopMining()
    this._cleanUnfinishedBlock()
  }

  startTimer (name: string): void {
    this._timers[name] = Math.floor(Date.now() * 0.001)
  }

  // TODO: will have to remake for overline, no boundaries
  stopTimer (name: string): ?Number {
    if (this._timers[name] !== undefined) {
      const startTime = delete this._timers[name]
      const elapsed = Math.floor(Date.now() * 0.001) - startTime
      if (this._timerResults[name] === undefined) {
        this._timerResults[name] = []
      }
      this._timerResults[name].push(elapsed)
      return elapsed
    } else {
      return 0
    }
  }

  getTimerResults (name: string): ?Number {
    if (this._timerResults[name] !== undefined && this._timerResults[name].length > 4) {
      return mean(this._timerResults[name])
    }
    return false
  }

  async startMining (rovers: string[], block: Block): Promise<bool|number> {
    // get latest block from each child blockchain
    const lastPreviousBlock = await this.persistence.get('bc.block.latest')
    this._logger.info(`persisted block height: ${lastPreviousBlock.getHeight()}`)
    // [eth.block.latest,btc.block.latest,neo.block.latest...]
    const latestRoveredHeadersKeys: string[] = this._knownRovers.map(chain => `${chain}.block.latest`)
    const latestBlockHeaders = await this.persistence.getBulk(latestRoveredHeadersKeys)
    // { eth: 200303, btc:2389, neo:933 }
    const latestBlockHeadersHeights = fromPairs(latestBlockHeaders.map(header => [header.getBlockchain(), header.getHeight()]))
    this._logger.info(`latestBlockHeadersHeights: ${inspect(latestBlockHeadersHeights)}`)

    // prepare a list of keys of headers to pull from persistence
    const newBlockHeadersKeys = flatten(Object.keys(lastPreviousBlock.getBlockchainHeaders().toObject()).map(listKey => {
      this._logger.debug('assembling minimum heights for ' + listKey)
      const chain = keyOrMethodToChain(listKey)
      const lastHeaderInPreviousBlock = last(lastPreviousBlock.getBlockchainHeaders()[chainToGet(chain)]())

      let from
      let to
      if (lastPreviousBlock.getHeight() === 1) { // genesis
        // just pick the last known block for genesis
        from = latestBlockHeadersHeights[chain]// TODO check, seems correct
        to = from
      } else {
        if (!lastHeaderInPreviousBlock) {
          throw new Error(`previous NRG block ${lastPreviousBlock.getHeight()} failed minimum "${chain}" state changes`)
        }
        from = lastHeaderInPreviousBlock.getHeight() + 1
        to = latestBlockHeadersHeights[chain]
      }

      this._logger.info(`newBlockHeadersKeys, heights nrg: ${lastPreviousBlock.getHeight()}, ${chain} ln: ${from}, ${to}`)

      if (from === to) {
        return [`${chain}.block.${from}`]
      }

      if (from > to) {
        return []
      }

      if (to === undefined) {
        to = from - 1
      }

      this._logger.info('chain: ' + chain + 'from: ' + from + ' to: ' + to)

      return [range(from, to + 1).map(height => `${chain}.block.${height}`)]
    }))

    this._logger.debug(`loading ${inspect(newBlockHeadersKeys)}`)

    const currentBlocks = await this.persistence.getBulk(newBlockHeadersKeys)

    // get latest known BC block
    try {
      this._logger.info(`preparing new block`)
      const currentTimestamp = ts.nowSeconds()
      if (this._unfinishedBlock !== undefined && getBlockchainsBlocksCount(this._unfinishedBlock) >= 6) {
        this._cleanUnfinishedBlock()
      }

      const [newBlock, finalTimestamp] = prepareNewBlock(
        currentTimestamp,
        lastPreviousBlock,
        currentBlocks,
        block,
        [], // TODO: Transactions added here for AT period
        this._minerKey,
        this._unfinishedBlock
      )

      const work = prepareWork(lastPreviousBlock.getHash(), newBlock.getBlockchainHeaders())
      newBlock.setTimestamp(finalTimestamp)
      this._unfinishedBlock = newBlock
      this._unfinishedBlockData = {
        lastPreviousBlock,
        currentBlocks: newBlock.getBlockchainHeaders(),
        block,
        iterations: undefined,
        timeDiff: undefined
      }

      this.setCurrentMiningHeaders(newBlock.getBlockchainHeaders())

      // if blockchains block count === 5 we will create a block with 6 blockchain blocks (which gets bonus)
      // if it's more, do not restart mining and start with new ones
      // if (this._workerProcess) {
      //  this._logger.info(`new rovered block -> accepted`)
      //  this.stopMining()
      // }

      const update = {
        currentTimestamp,
        offset: ts.offset,
        work,
        minerKey: this._minerKey,
        merkleRoot: newBlock.getMerkleRoot(),
        difficulty: newBlock.getDifficulty(),
        difficultyData: {
          currentTimestamp,
          lastPreviousBlock: lastPreviousBlock.serializeBinary(),
          // $FlowFixMe
          newBlockHeaders: newBlock.getBlockchainHeaders().serializeBinary()
        }
      }

      await this._workerPool.updateWorkers({ type: 'work', data: update })

      // this._logger.debug(`starting miner process with work: "${work}", difficulty: ${newBlock.getDifficulty()}, ${JSON.stringify(this._collectedBlocks, null, 2)}`)
      // const proc: ChildProcess = fork(MINER_WORKER_PATH)
      // this._workerProcess = proc
      // if (this._workerProcess !== null) {
      //  // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
      //  this._workerProcess.on('message', this._handleWorkerFinishedMessage.bind(this))

      //  // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
      //  this._workerProcess.on('error', this._handleWorkerError.bind(this))

      //  // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
      //  this._workerProcess.on('exit', this._handleWorkerExit.bind(this))

      //  this._logger.info('worker <- calculated difficulty threshold ' + newBlock.getDifficulty())
      //  this.startTimer('w1')
      //  // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter

      //  // $FlowFixMe - Flow can't properly find worker pid
      //  return Promise.resolve(this._workerProcess.pid)
      // }
    } catch (err) {
      this._logger.error(err)
      this._logger.warn(`Error while getting last previous BC block, reason: ${err.message}`)
      return Promise.reject(err)
    }
  } catch (err) {
    this._logger.error(err)
    this._logger.warn(`Error while getting current blocks, reason: ${err.message}`)
    return Promise.reject(err)
  }

  /// **
  //* Manages the current most recent block template used by the miner
  //* @param blockTemplate
  //* /
  // setCurrentMiningHeaders (blockTemplate: BlockchainHeaders): void {
  //  if (this._blockTemplates.length > 0) {
  //    this._blockTemplates.pop()
  //  }
  //  this._blockTemplates.push(blockTemplate)
  // }

  /**
  * Accessor for block templates
  */
  getCurrentMiningHeaders (): ?BlockchainHeaders {
    if (this._blockTemplates.length < 1) return
    return this._blockTemplates[0]
  }

  stopMining (): bool {
    debug('stop mining')
    this._logger.info('petioning new mining work')

    this._workerPool.allDismissed().then(() => {
      this._logger.info('workers dismissed')
    })

    // const process = this._workerProcess
    // if (!process) {
    //  return true
    // }

    // if (process.connected) {
    //  try {
    //    process.disconnect()
    //  } catch (err) {
    //    this._logger.info(`unable to disconnect workerProcess, reason: ${err.message}`)
    //  }
    // }

    // try {
    //  process.removeAllListeners()
    // } catch (err) {
    //  this._logger.info(`unable to remove workerProcess listeners, reason: ${err.message}`)
    // }

    /// / $FlowFixMe
    // if (process.killed !== true) {
    //  try {
    //    process.kill()
    //  } catch (err) {
    //    this._logger.info(`Unable to kill workerProcess, reason: ${err.message}`)
    //  }
    // }

    // this._workerProcess = undefined

    return true

    // ENABLED for AT
    // try {
    //  return Promise.all(this._knownRovers.map((rv) => {
    //    return this.persistence.get(rv + '.block.latest')
    //      .then((latest) => {
    //        return this.persistence.get(rv + '.block.' + (latest.getHeight() + 1))
    //          .then((latestCandidate) => {
    //            if (latest.getHash() === latestCandidate.getPreviousHash()) {
    //              return this.persistence.put(latest.getBlockchain() + '.block.latest', latestCandidate)
    //            }
    //            return Promise.resolve(true)
    //          })
    //          .catch((err) => {
    //            this._logger.error(err)
    //            return Promise.resolve(false)
    //          })
    //      })
    //      .catch((err) => {
    //        this._logger.error(err)
    //        return Promise.resolve(false)
    //      })
    //  }))
    // } catch (err) {
    //  this._logger.error(err)
    //  return Promise.resolve(false)
    // }
  }

  /*
   * Alias for validation module
   */
  validateRoveredSequences (blocks: BcBlock[]): boolean {
    return validateRoveredSequences(blocks)
  }

  sortBlocks (list: Object[]): Object[] {
    return list.sort((a, b) => {
      if (a.getHeight() < b.getHeight()) {
        return 1
      }
      if (a.getHeight() > b.getHeight()) {
        return -1
      }
      return 0
    })
  }

  /*
   * Restarts the miner by merging any unused rover blocks into a new block
   */
  async rebaseMiner (): Promise<bool|number> {
    // if (this._canMine !== true) return Promise.resolve(false)

    this._logger.info('rebase miner request')
    try {
      const stopped = this.stopMining()
      this._logger.info(`miner rebased, result: ${inspect(stopped)}`)
      const latestRoveredHeadersKeys: string[] = this._knownRovers.map(chain => `${chain}.block.latest`)
      this._logger.info(latestRoveredHeadersKeys)
      const currentRoveredBlocks = await this.persistence.getBulk(latestRoveredHeadersKeys)
      const lastPreviousBlock = await this.persistence.get('bc.block.latest')
      const previousHeaders = lastPreviousBlock.getBlockchainHeaders()
      this._logger.info(currentRoveredBlocks)
      if (lastPreviousBlock === undefined) {
        return Promise.resolve(false)
      }
      if (currentRoveredBlocks !== undefined && currentRoveredBlocks.length > 0) {
        const perc = (currentRoveredBlocks.length / Object.keys(previousHeaders.toObject()).length) * 100
        this._logger.info('multiverse sync state: ' + perc + '%')
      }
      if (currentRoveredBlocks.length !== Object.keys(previousHeaders.toObject()).length) {
        return Promise.resolve(false)
      }
      const uniqueBlocks = getUniqueBlocks(previousHeaders, currentRoveredBlocks).sort((a, b) => {
        if (a.getHeight() > b.getHeight()) {
          return -1
        }
        if (a.getHeight() < b.getHeight()) {
          return 1
        }
        return 0
      })

      this._logger.info('stale branch blocks: ' + uniqueBlocks.length)

      if (uniqueBlocks.length < 1) {
        this._logger.info(uniqueBlocks.length + ' state changes ')
        return Promise.resolve(false)
      }
      return this.startMining(this._knownRovers, uniqueBlocks.shift())
    } catch (err) {
      return Promise.reject(err)
    }
  }

  restartMining (): boolean {
    debug('Restarting mining', this._knownRovers)

    // this.stopMining()
    // if (this._rawBlock.length > 0) {
    //  return this.startMining(this._knownRovers, this._rawBlock.pop())
    //    .then(res => {
    //      return Promise.resolve(!res)
    //    })
    // } else {

    // return Promise.resolve(true)
    // }

    return this.stopMining()
  }

  _handleWorkerFinishedMessage (solution: { distance: string, nonce: string, difficulty: string, timestamp: number, iterations: number, timeDiff: number }) {
    const unfinishedBlock = this._unfinishedBlock
    if (!unfinishedBlock) {
      this._logger.warn('There is not an unfinished block to use solution for')
      return
    }

    const { nonce, distance, timestamp, difficulty, iterations, timeDiff } = solution
    this._logger.info(`The calculated block difficulty was ${unfinishedBlock.getDifficulty()}, actual mining difficulty was ${difficulty}`)

    const chainWeight = unfinishedBlock.getDistance()

    unfinishedBlock.setNonce(nonce)
    unfinishedBlock.setDistance(distance)
    unfinishedBlock.setTotalDistance(new BN(unfinishedBlock.getTotalDistance()).add(new BN(chainWeight)).add(new BN(unfinishedBlock.getDifficulty(), 10)).toString())
    unfinishedBlock.setTimestamp(timestamp)

    const unfinishedBlockData = this._unfinishedBlockData
    if (unfinishedBlockData) {
      unfinishedBlockData.iterations = iterations
      unfinishedBlockData.timeDiff = timeDiff
    }

    if (!isValidBlock(unfinishedBlock, 1)) {
      this._logger.warn(`mined block is invalid`)
      this._cleanUnfinishedBlock()
      return
    }

    if (unfinishedBlock !== undefined && isDebugEnabled()) {
      this._writeMiningData(unfinishedBlock, solution)
    }

    this.stopTimer('w1')
    this._cleanUnfinishedBlock()
    this.pubsub.publish('miner.block.new', { unfinishedBlock, solution })
    return this.stopMining()
  }

  _handleWorkerError (error: Error): Promise<boolean> {
    this._logger.error(error)
    this._logger.warn(`Mining worker process errored, reason: ${error.message}`)
    this._cleanUnfinishedBlock()

    return this.stopMining()
  }

  _handleWorkerExit (code: number, signal: string) {
    return this.stopMining().then(() => {
      this._logger.info('miner pending new work')

      if (code === 0 || code === null) { // 0 means worker exited on it's own correctly, null that is was terminated from engine
        this._logger.info(`Mining worker finished its work (code: ${code})`)
      } else {
        this._logger.warn(`Mining worker process exited with code ${code}, signal ${signal}`)
        this._cleanUnfinishedBlock()
      }
    })
      .catch((e) => {
        this._logger.erorr(e)
      })
  }

  _cleanUnfinishedBlock () {
    debug('cleaning unfinished block')
    this._unfinishedBlock = undefined
    this._unfinishedBlockData = undefined
  }

  _writeMiningData (newBlock: BcBlock, solution: { iterations: number, timeDiff: number }) {
    // block_height, block_difficulty, block_distance, block_total_distance, block_timestamp, iterations_count, mining_duration_ms, btc_confirmation_count, btc_current_timestamp, eth_confirmation_count, eth_current_timestamp, lsk_confirmation_count, lsk_current_timestamp, neo_confirmation_count, neo_current_timestamp, wav_confirmation_count, wav_current_timestamp
    const row = [
      newBlock.getHeight(), newBlock.getDifficulty(), newBlock.getDistance(), newBlock.getTotalDistance(), newBlock.getTimestamp(), solution.iterations, solution.timeDiff
    ]

    this._knownRovers.forEach(roverName => {
      if (this._unfinishedBlockData && this._unfinishedBlockData.currentBlocks) {
        const methodNameGet = `get${roverName[0].toUpperCase() + roverName.slice(1)}List` // e.g. getBtcList
        // $FlowFixMe - flow does not now about methods of protobuf message instances
        const blocks = this._unfinishedBlockData.currentBlocks[methodNameGet]()
        row.push(blocks.map(block => block.getBlockchainConfirmationsInParentCount()).join('|'))
        row.push(blocks.map(block => block.getTimestamp() / 1000 << 0).join('|'))
      }
    })

    row.push(getBlockchainsBlocksCount(newBlock))
    const dataPath = ensureDebugPath(`bc/mining-data.csv`)
    writeFileSync(dataPath, `${row.join(',')}\r\n`, { encoding: 'utf8', flag: 'a' })
  }
}
