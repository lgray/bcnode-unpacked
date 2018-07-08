/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type BcBlock from '../protos/core_pb'
import type { Logger } from 'winston'
import type PersistenceRocksDb from '../persistence/rocksdb'

const BN = require('bn.js')
const { all, flatten, zip } = require('ramda')

const { validateBlockSequence, childrenHeightSum } = require('./validation')
const { standardId } = require('./helper')
const { getLogger } = require('../logger')

export class Multiverse {
  _chain: BcBlock[]
  _candidates: BcBlock[]
  _height: number
  _created: number
  _id: string
  _logger: Logger
  _persistence: PersistenceRocksDb

  constructor (persistence: PersistenceRocksDb) {
    this._persistence = persistence
    this._id = standardId()
    this._chain = []
    this._candidates = []
    this._logger = getLogger(`bc.multiverse.${this._id}`, false)
    this._height = 0
    this._created = Math.floor(Date.now() * 0.001)
  }

  get blocks (): Array<BcBlock> {
    return this._chain
  }

  set blocks (blocks: BcBlock[]) {
    this._chain = blocks
  }

  get blocksCount (): number {
    const blocks = this._chain
    return blocks.length
  }

  get persistence (): PersistenceRocksDb {
    return this._persistence
  }

  purge () {
    this._chain.length = 0
    this._logger.info('metaverse has been purged')
  }

  /**
   * Get second to highest block in Multiverse
   */
  getParentHighestBlock (): BcBlock|null {
    if (this._chain.length > 1) {
      return null
    }
    return this._chain[1]
  }

  /**
   * Accessor for validation function
   * @returns {*}
   */
  validateBlockSequence (blocks: BcBlock[]): boolean {
    return validateBlockSequence(blocks)
  }

  /**
   * Valid Block Range
   * @returns {*}
   */
  async validateBlockSequenceInline (blocks: BcBlock[]): boolean {
    if (blocks === undefined || blocks.length < 1) return false
    const sorted = blocks.sort((a, b) => {
      if (a.getHeight() < b.getHeight()) {
        return 1
      }
      if (a.getHeight() > b.getHeight()) {
        return -1
      }
      return 0
    })
    // check if the actually sequence itself is valid
    const upperBound = sorted[0]
    const lowerBound = sorted[sorted.length - 1]
    const upperBoundChild = await this.persistence.get('pending.bc.block.' + (sorted[0].getHeight() + 1))
    // current pending block does not match the purposed block at that height
    if (upperBoundChild === undefined || upperBound.getHash() !== upperBoundChild.getPreviousHash()) return Promise.reject(new Error('pending block does not match purposed block'))
    // add the child block of the sequence
    sorted.unshift(upperBoundChild)
    if (lowerBound === 1) {
      // if at final depth this will equal 1 or the genesis block
      const lowerBoundParent = await this.persistence.get('bc.block.1')
      if (lowerBound.getPreviousHash() !== lowerBoundParent.getHash()) return Promise.reject(new Error('sync did not resolve to genesis block'))
      // add the genesis block to the sequence
      sorted.push(lowerBoundParent)
    }
    // finally check the entire sequence
    if (!validateBlockSequence(sorted)) return Promise.reject(new Error('block sequence invalid'))
    return Promise.resolve(true)
  }

  /**
   * Get highest block in Multiverse
   * @returns {*}
   */
  getHighestBlock (): BcBlock|null {
    if (this._chain.length === 0) {
      return null
    }
    return this._chain[0]
  }

  /**
   * Get lowest block by block key
   * @returns {*}
   */
  getLowestBlock (): BcBlock|null {
    if (this._chain.length > 0) {
      return this._chain[this._chain.length - 1]
    }
    return null
  }

  /**
   * Add candidate block to candidate list (max 12)
   * @param newBlock
   * @returns {*}
   */
  addCandidateBlock (newBlock: BcBlock) {
    this._candidates.unshift(newBlock)
    if (this._candidates.length > 12) {
      this._candidates.pop()
    }
  }

  /**
   * Check if immmediate height is better
   * @param newBlock
   * @returns {boolean}
   */
  addBestBlock (newBlock: BcBlock): boolean {
    const currentHighestBlock = this.getHighestBlock()
    const currentParentHighestBlock = this.getParentHighestBlock()
    if (currentHighestBlock === null) {
      // assume we always have current highest block
      throw Error('Cannot get currentHighestBlock')
    }
    // if no block is available go by total difficulty
    // FAIL if new block not within 16 seconds of local time
    if (newBlock.getTimestamp() + 16 < Math.floor(Date.now() * 0.001)) {
      return false
    }
    // if there is no current parent, this block is the right lbock
    if (currentParentHighestBlock === false) {
      if (new BN(newBlock.getTotalDifficulty()).gt(new BN(currentHighestBlock.getTotalDifficulty()))) {
        this._chain.length = 0
        this._chain.push(newBlock)
        return true
      }
      return false
    }
    // FAIL if newBlock total difficulty <  currentHighestBlock
    if (new BN(newBlock.getTotalDifficulty()).lt(new BN(currentHighestBlock.getTotalDifficulty()))) {
      return false
    }
    // if the current block at the same height is better switch
    if (currentParentHighestBlock !== null && newBlock.getPreviousHash() === currentParentHighestBlock.getHash() && validateBlockSequence([newBlock, currentParentHighestBlock]) === true) {
      this._chain.shift()
      this._chain.unshift(newBlock)
      return true
    }

    return false
  }

  /**
   * Eval and update multiverse with next block
   * @param block New block
   * @returns {boolean}
   */
  addNextBlock (newBlock: BcBlock): boolean {
    // if there are no blocks in the multiverse this block is the highest
    if (this._chain.length === 0) {
      this._chain.push(newBlock)
      return true
    }
    const currentHighestBlock = this.getHighestBlock()
    // PASS no other candidate in Multiverse
    if (currentHighestBlock === null) {
      this._chain.unshift(newBlock)
      return true // TODO added - check with @schnorr
    }
    // Fail is the block hashes are identical
    if (newBlock.getHash() === currentHighestBlock.getHash()) {
      return false
    }
    // FAIL if newBlock totalDifficulty < (lt) currentHighestBlock totalDifficulty
    if (new BN(newBlock.getTotalDifficulty()).lt(new BN(currentHighestBlock.getTotalDifficulty()))) {
      return false
    }
    // FAIL if malformed timestamp referenced from previous block with five second lag
    if (newBlock.getTimestamp() + 5 <= currentHighestBlock.getTimestamp()) {
      this._logger.debug('purposed block ' + newBlock.getHash() + ' has invalid timestamp ' + newBlock.getTimestamp() + ' from current height timestamp ' + currentHighestBlock.getTimestamp())
      return this.addBestBlock(newBlock)
    }
    // FAIL if timestamp of block is greater than 31 seconds from system time
    if (newBlock.getTimestamp() + 31 < Math.floor(Date.now() * 0.001)) {
      this._logger.debug('purposed block ' + newBlock.getHash() + ' has invalid timestamp ' + newBlock.getTimestamp() + ' from current height timestamp ' + currentHighestBlock.getTimestamp())
      return this.addBestBlock(newBlock)
    }
    // FAIL if newBlock does not reference the current highest block as it's previous hash
    if (newBlock.getPreviousHash() !== currentHighestBlock.getHash()) {
      this._logger.debug('purposed block ' + newBlock.getHash() + ' previous hash not current highest ' + currentHighestBlock.getHash())
      return this.addBestBlock(newBlock)
    }
    // FAIL if newBlock does not reference the current highest block as it's previous hash
    if (validateBlockSequence([newBlock, currentHighestBlock]) !== true) {
      this._logger.debug('addition of block ' + newBlock.getHash() + ' creates malformed child blockchain sequence')
      return this.addBestBlock(newBlock)
    }
    // PASS add the new block to the parent position
    this._chain.unshift(newBlock)
    if (this._chain.length > 7) {
      this._chain.pop()
    }
    return true
  }

  /**
   * Check if block sould be queued for resync as a potentially bettter path
   * if returns true miner is paused
   * @param newBlock
   * @returns {boolean}
   */
  addResyncRequest (newBlock: BcBlock): Promise<boolean> {
    const currentHighestBlock = this.getHighestBlock()
    const currentParentHighestBlock = this.getParentHighestBlock()

    // PASS if no highest block exists go with current
    if (currentHighestBlock === null) {
      return Promise.resolve(true)
    }

    // Fail is the block hashes are identical
    if (newBlock.getHash() === currentHighestBlock.getHash()) {
      return false
    }
    // FAIL if new block not within 16 seconds of local time
    if (newBlock.getTimestamp() + 16 < Math.floor(Date.now() * 0.001)) {
      return Promise.resolve(false)
    }
    if (currentParentHighestBlock === null && currentHighestBlock !== null) {
      if (new BN(newBlock.getTotalDifficulty()).gt(new BN(currentHighestBlock.getTotalDifficulty()))) {
        this.addCandidateBlock(newBlock)
        return Promise.resolve(true)
      }
    }
    // FAIL if newBlock total difficulty <  currentHighestBlock
    if (new BN(newBlock.getTotalDifficulty()).lt(new BN(currentHighestBlock.getTotalDifficulty()))) {
      return Promise.resolve(false)
    }

    // make sure that blocks that are added reference child chains
    return this.validateRoveredBlocks(newBlock).then(areAllChildrenRovered => {
      if (!areAllChildrenRovered) {
        return Promise.resolve(false)
      }

      // FAIL if sum of child block heights is less than the rovered child heights
      if (childrenHeightSum(newBlock) <= childrenHeightSum(currentParentHighestBlock)) {
        return Promise.resolve(false)
      }
      this.addCandidateBlock(newBlock)
      return Promise.resolve(true)
    })
  }

  async validateRoveredBlocks (block: BcBlock): Promise<boolean> {
    // construct key array like ['btc.block.528089', ..., 'wav.block.1057771', 'wav.blocks.1057771']
    const receivedBlocks = flatten(Object.values(block.getBlockchainHeaders().toObject()))
    const keys = receivedBlocks
      // $FlowFixMe - Object.values is not generic
      .map(({ blockchain, height }) => `${blockchain}.block.${height}`)

    const blocks = await this.persistence.getBulk(keys)
    let valid = keys.length === blocks.length
    if (!valid) {
      return Promise.resolve(valid)
    }

    const pairs = zip(receivedBlocks, blocks)

    return Promise.resolve(all(flag => flag === true, pairs.map(([received, expected]) => {
      // $FlowFixMe
      return received.hash === expected.getHash() &&
        // $FlowFixMe
        received.height === expected.getHeight() &&
        // $FlowFixMe
        received.merkleRoot === expected.getMerkleRoot() &&
        // $FlowFixMe
        received.timestamp === expected.getTimestamp()
    })))
  }

  /**
   * Get multiverse as nested `BcBlock` array
   * @returns {*}
   */
  toArray (): Array<Array<BcBlock>> {
    return this._chain
  }

  /**
   * Get multiverse as flat `BcBlock` array
   */
  toFlatArray (): Array<BcBlock> {
    const blocks = this.toArray()
    return flatten(blocks)
  }

  // NOTE: Multiverse print disabled. Why?
  print () {
    // this._logger.info(this._blocks)
    this._logger.debug('multiverse print disabled')
  }
}

export default Multiverse
