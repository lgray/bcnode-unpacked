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

const { fork, ChildProcess } = require('child_process')
const { writeFileSync } = require('fs')
const { resolve } = require('path')
const { inspect } = require('util')

const BN = require('bn.js')
const debug = require('debug')('bcnode:mining:officer')
const { all, equals, flatten, fromPairs, last, range, values } = require('ramda')

const { prepareWork, prepareNewBlock, getNewBlockCount } = require('./primitives')
const { getLogger } = require('../logger')
const { Block, BcBlock } = require('../protos/core_pb')
const { isDebugEnabled, ensureDebugPath } = require('../debug')
const { isValidBlock } = require('../bc/validation')
const { getBlockchainsBlocksCount } = require('../bc/helper')
const ts = require('../utils/time').default // ES6 default export

const MINER_WORKER_PATH = resolve(__filename, '..', '..', 'mining', 'worker.js')

type UnfinishedBlockData = {
  lastPreviousBlock: ?BcBlock,
  block: ?Block,
  currentBlocks: ?{ [blokchain: string]: Block },
  iterations: ?number,
  timeDiff: ?number
}

const keyOrMethodToChain = (keyOrMethod: string) => keyOrMethod.replace(/^get|set/, '').replace(/List$/, '').toLowerCase()
const chainToSet = (chain: string) => `set${chain[0].toUpperCase() + chain.slice(1)}List`
const chainToGet = (chain: string) => `get${chain[0].toUpperCase() + chain.slice(1)}List`

export class MiningOfficer {
  _logger: Logger
  _minerKey: string
  _pubsub: PubSub
  _persistence: RocksDb
  _knownRovers: string[]

  _collectedBlocks: { [blockchain: string]: number }
  _canMine: bool
  _workerProcess: ?ChildProcess
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

    this._collectedBlocks = {}
    for (let roverName of this._knownRovers) {
      this._collectedBlocks[roverName] = 0
    }
    this._canMine = false
    this._unfinishedBlockData = { block: undefined, lastPreviousBlock: undefined, currentBlocks: {}, timeDiff: undefined, iterations: undefined }
    this._paused = false
    this._blockTemplates = []
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

  async newRoveredBlock (rovers: string[], block: Block): Promise<number|false> {
    this._collectedBlocks[block.getBlockchain()] += 1

    // TODO: Adjust minimum count of collected blocks needed to trigger mining
    if (!this._canMine && all((numCollected: number) => numCollected >= 1, values(this._collectedBlocks))) {
      this._canMine = true
    }

    // Check if _canMine
    if (!this._canMine) {
      const keys = Object.keys(this._collectedBlocks)
      const values = '|' + keys.reduce((all, a, i) => {
        const val = this._collectedBlocks[a]
        if (i === (keys.length - 1)) {
          all = all + a + ':' + val
        } else {
          all = all + a + ':' + val + ' '
        }
        return all
      }, '') + '|'

      const totalBlocks = keys.reduce((all, key) => {
        return all + this._collectedBlocks[key]
      }, 0)

      this._logger.info('constructing multiverse from blockchains ' + values)
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
        return Promise.resolve(false)
      })
  }

  stop () {
    this.stopMining()
    this._cleanUnfinishedBlock()
  }

  async startMining (rovers: string[], block: Block): Promise<boolean|number> {
    // get latest block from each child blockchain
    try {
      const lastPreviousBlock = await this.persistence.get('bc.block.latest')
      this._logger.info(`Got last previous block (height: ${lastPreviousBlock.getHeight()}) from persistence`)
      const latestRoveredHeadersKeys: string[] = this._knownRovers.map(chain => `${chain}.block.latest`)
      const latestBlockHeaders = await this.persistence.getBulk(latestRoveredHeadersKeys)
      const latestBlockHeadersHeights = fromPairs(latestBlockHeaders.map(header => [header.getBlockchain(), header.getHeight()]))
      this._logger.debug(`latestBlockHeadersHeights: ${inspect(latestBlockHeadersHeights)}`)

      // prepare a list of keys of headers to pull from persistence
      const newBlockHeadersKeys = flatten(Object.keys(lastPreviousBlock.getBlockchainHeaders().toObject()).map(listKey => {
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
            throw new Error(`Previous BC block ${lastPreviousBlock.getHeight()} does not have any "${chain}" headers`)
          }
          from = lastHeaderInPreviousBlock.getHeight() + 1
          to = latestBlockHeadersHeights[chain]
        }

        this._logger.debug(`newBlockHeadersKeys, previous BC: ${lastPreviousBlock.getHeight()}, ${chain}, from: ${from}, to: ${to}`)

        if (from === to) {
          return [`${chain}.block.${from}`]
        }

        if (from > to) {
          return []
        }

        return [range(from, to + 1).map(height => `${chain}.block.${height}`)]
      }))

      this._logger.info(`Loading ${inspect(newBlockHeadersKeys)}`)
      const currentBlocks = await this.persistence.getBulk(newBlockHeadersKeys)
      this._logger.info(`Loaded ${currentBlocks.length} blocks from persistence`)

      // get latest known BC block
      try {
        this._logger.info(`Preparing new block`)

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

        this.setCurrentMiningBlock(newBlock)

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

        // if blockchains block count === 5 we will create a block with 6 blockchain blocks (which gets bonus)
        // if it's more, do not restart mining and start with new ones
        if (this._workerProcess && this._unfinishedBlock) {
          this._logger.info(`Restarting mining with a new rovered block`)
          return this.restartMining()
        }

        this._logger.info(`Starting miner process with work: "${work}", difficulty: ${newBlock.getDifficulty()}, ${JSON.stringify(this._collectedBlocks, null, 2)}`)
        const proc: ChildProcess = fork(MINER_WORKER_PATH)
        this._workerProcess = proc
        if (this._workerProcess !== null) {
          // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
          this._workerProcess.on('message', this._handleWorkerFinishedMessage.bind(this))

          // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
          this._workerProcess.on('error', this._handleWorkerError.bind(this))

          // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
          this._workerProcess.on('exit', this._handleWorkerExit.bind(this))

          this._logger.info('sending difficulty threshold to worker: ' + newBlock.getDifficulty())
          // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
          this._workerProcess.send({
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
            }})

          // $FlowFixMe - Flow can't properly find worker pid
          return Promise.resolve(this._workerProcess.pid)
        }
      } catch (err) {
        this._logger.warn(`Error while getting last previous BC block, reason: ${err.message}`)
        return Promise.reject(err)
      }

      return Promise.resolve(false)
    } catch (err) {
      this._logger.warn(`Error while getting current blocks, reason: ${err.message}`)
      return Promise.reject(err)
    }
  }

  /**
  * Manages the current most recent block template used by the miner
  * @param blockTemplate
  */
  setCurrentMiningBlock (blockTemplate: Object): void {
    if (blockTemplate === undefined) {
      return
    }
    this._blockTemplates.length = 0
    this._blockTemplates.push(blockTemplate)
  }

  /**
  * Accessor for block templates
  */
  getCurrentMiningBlock (): ?BcBlock {
    if (this._blockTemplates.length < 1) return
    return this._blockTemplates[0]
  }

  stopMining (): Promise<bool> {
    debug('Stopping mining')

    const process = this._workerProcess
    if (!process) {
      return Promise.resolve(false)
    }

    if (process.connected) {
      try {
        process.disconnect()
      } catch (err) {
        this._logger.info(`Unable to disconnect workerProcess, reason: ${err.message}`)
      }
    }

    try {
      process.removeAllListeners()
    } catch (err) {
      this._logger.info(`Unable to remove workerProcess listeners, reason: ${err.message}`)
    }

    // $FlowFixMe
    if (process.killed !== true) {
      try {
        process.kill()
      } catch (err) {
        this._logger.info(`Unable to kill workerProcess, reason: ${err.message}`)
      }
    }

    this._logger.info('mining worker process has been killed')
    this._workerProcess = undefined
    return Promise.resolve(true)
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

  async rebaseMiner (): Promise<?boolean> {
    if (this._canMine !== true) return Promise.resolve(false)
    const staleBlock = this.getCurrentMiningBlock()
    if (!staleBlock) {
      return Promise.resolve(false)
    }
    const lastPreviousBlock = await this.persistence.get('bc.block.latest')
    const previousHeaders = lastPreviousBlock.getBlockchainHeaders()
    const blockHeaderCounts = getNewBlockCount(lastPreviousBlock.getBlockchainHeaders(), staleBlock.getBlockchainHeaders())
    // const currentTimestamp = ts.nowSeconds()

    this._logger.info('child blocks usable in rebase: ' + blockHeaderCounts)

    if (blockHeaderCounts === 0) {
      return Promise.resolve(false)
    }

    const finalHeaders = []
    const previousTable = {}
    previousTable.btc = this.sortBlocks(previousHeaders.getBtcList())
    const btcListStale = this.sortBllocks(staleHeaders.getBtcList())
    previousTable.eth = this.sortBlocks(previousHeaders.getEthList())
    const ethListStale this.sortBlocks(= staleHeaders.getEthList())
    previousTable.wav = this.sortBlocks(previousHeaders.getWavList())
    const wavListStale = this.sortBlocks(staleHeaders.getWavList())
    previousTable.neo = this.sortBlocks(previousHeaders.getNeoList())
    const neoListStale = this.sortBlocks(staleHeaders.getNeoList())
    previousTable.lsk = this.sortBlocks(previousHeaders.getLskList())
    const lskListStale = this.sortBlocks(staleHeaders.getLskList())

    const finalTable = {}
          finalTable.btc = []
          finalTable.eth = []
          finalTable.wav = []
          finalTable.neo = []
          finalTable.lsk = []

    btcListStale.reduce((all, s) => {
      if(btcList[0].getHeight() <= s.getHeight()){
        if(all.btc.length === 0) {
          all.btc.push(s)
        } else if(s.getHeight() > btcList[0].getHeight() {
          all.btc.push(s)
        }
      }
      return all
    }, finalTable){


    const blocks = this._knownRovers.reduce((all, roverName) => {
      this._logger.info('processing rover ' + roverName)

      staleHeaders..
      return all
    }, [])

    this._logger.info(JSON.stringify(blocks, null, 2))

    const bestCurrentBlocks = blocks.reduce((all, chain, i) => {
      if (all[chain.getBlockchain()] === undefined) {
        all[chain.getBlockchain()] = chain
      } else if (all[chain.getBlockchain()].getHeight() < chain.getHeight()) {
        all[chain.getBlockchain()] = chain
      }
      return all
    }, {})

    this._logger.info(JSON.stringify(bestCurrentBlocks, null, 2))

    if (Object.keys(blockchains).length !== Object.keys(bestCurrentBlocks).length) return Promise.resolve(false)

    // const candidates = Object.keys(bestCurrentBlocks).reduce((all, key) => {
    //  const chain = bestCurrentBlocks[key]
    //  all[key] = blockchains[key].filter((a) => {
    //    if (a.getHeight() > chain.getHeight()) {
    //      return a
    //    }
    //  })
    //  return all
    // }, {})

    /// / if there are no higher candidates return nul
    // if (Object.keys(candidates).length < 1) return

    /// / stop the miner
    // this.stopMining()

    // const rebasedBlocks = Object.keys(bestCurrentBlocks).reduce((all, key) => {
    //  if (candidates[key] === undefined) {
    //    all.push(bestCurrentBlocks[key])
    //  } else {
    //    all = all.concat(candidates[key])
    //  }
    //  return all
    // }, [])

    // const block = rebasedBlocks[0]

    // const [newBlock, finalTimestamp] = prepareNewBlock(
    //  currentTimestamp,
    //  lastPreviousBlock,
    //  rebasedBlocks,
    //  rebasedBlocks[0],
    //  [], // TXs Pool
    //  this._minerKey,
    //  this._unfinishedBlock
    // )

    // debug('Restarting mining', this._knownRovers)

    // this.setCurrentMiningBlock(newBlock)

    // const work = prepareWork(lastPreviousBlock.getHash(), newBlock.getBlockchainHeaders())
    // newBlock.setTimestamp(finalTimestamp)
    // this._unfinishedBlock = newBlock
    // this._unfinishedBlockData = {
    //  lastPreviousBlock,
    //  currentBlocks: newBlock.getBlockchainHeaders(),
    //  block,
    //  iterations: undefined,
    //  timeDiff: undefined
    // }

    /// / if blockchains block count === 5 we will create a block with 6 blockchain blocks (which gets bonus)
    /// / if it's more, do not restart mining and start with new ones
    // if (this._workerProcess && this._unfinishedBlock) {
    //  this._logger.info(`Restarting mining with a new rovered block`)
    //  return this.restartMining()
    // }

    // this._logger.info(`Starting miner process with work: "${work}", difficulty: ${newBlock.getDifficulty()}, ${JSON.stringify(this._collectedBlocks, null, 2)}`)
    // const proc: ChildProcess = fork(MINER_WORKER_PATH)
    // this._workerProcess = proc
    // if (this._workerProcess !== null) {
    //  // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
    //  this._workerProcess.on('message', this._handleWorkerFinishedMessage.bind(this))

    //  // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
    //  this._workerProcess.on('error', this._handleWorkerError.bind(this))

    //  // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
    //  this._workerProcess.on('exit', this._handleWorkerExit.bind(this))

    //  // $FlowFixMe - Flow can't find out that ChildProcess is extended form EventEmitter
    //  this._logger.info('sending difficulty threshold to worker: ' + newBlock.getDifficulty())
    //  this._workerProcess.send({
    //    currentTimestamp,
    //    offset: ts.offset,
    //    work,
    //    minerKey: this._minerKey,
    //    merkleRoot: newBlock.getMerkleRoot(),
    //    difficulty: newBlock.getDifficulty(),
    //    difficultyData: {
    //      currentTimestamp,
    //      lastPreviousBlock: lastPreviousBlock.serializeBinary(),
    //      // $FlowFixMe
    //      newBlockHeaders: newBlock.getBlockchainHeaders().serializeBinary()
    //    }})

    //  // $FlowFixMe - Flow can't properly find worker pid
    //  return Promise.resolve(this._workerProcess.pid)
    // }
    return Promise.resolve(true)
  }

  // FIXME: Review and fix restartMining
  restartMining (): Promise<boolean> {
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
    unfinishedBlock.setNonce(nonce)
    unfinishedBlock.setDistance(distance)
    unfinishedBlock.setTotalDistance(new BN(unfinishedBlock.getTotalDistance()).add(new BN(unfinishedBlock.getDifficulty(), 10)).toString())
    unfinishedBlock.setTimestamp(timestamp)

    const unfinishedBlockData = this._unfinishedBlockData
    if (unfinishedBlockData) {
      unfinishedBlockData.iterations = iterations
      unfinishedBlockData.timeDiff = timeDiff
    }

    if (!isValidBlock(unfinishedBlock)) {
      this._logger.warn(`The mined block is not valid`)
      this._cleanUnfinishedBlock()
      return
    }

    if (unfinishedBlock !== undefined && isDebugEnabled()) {
      this._writeMiningData(unfinishedBlock, solution)
    }

    this.pubsub.publish('miner.block.new', { unfinishedBlock, solution })
    this._cleanUnfinishedBlock()
    this.stopMining()
  }

  _handleWorkerError (error: Error): Promise<boolean> {
    this._logger.warn(`Mining worker process errored, reason: ${error.message}`)
    this._cleanUnfinishedBlock()

    // $FlowFixMe - Flow can't properly type subproccess
    if (!this._workerProcess) {
      return Promise.resolve(false)
    }

    return this.stopMining()
  }

  _handleWorkerExit (code: number, signal: string) {
    if (code === 0 || code === null) { // 0 means worker exited on it's own correctly, null that is was terminated from engine
      this._logger.info(`Mining worker finished its work (code: ${code})`)
    } else {
      this._logger.warn(`Mining worker process exited with code ${code}, signal ${signal}`)
      this._cleanUnfinishedBlock()
    }

    this._workerProcess = undefined
  }

  _cleanUnfinishedBlock () {
    debug('Cleaning unfinished block')
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
