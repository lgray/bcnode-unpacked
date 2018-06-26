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

const BN = require('bn.js')
const { flatten } = require('ramda')

const { validateBlockSequence } = require('./validation')
const { standardId } = require('./helper')
const logging = require('../logger')

export class Multiverse {
  _chain: BcBlock[]
  _candidates: BcBlock[]
  _height: number
  _created: number
  _id: string
  _logger: Logger

  constructor () {
    this._id = standardId()
    this._chain = []
    this._canddiates = []
    this._logger = logging.getLogger(`bc.multiverse.${this._id}`, false)
    this._height = 0
    this._created = Math.floor(Date.now() * 0.001)
  }

  get blocks (): Object {
    return this._chain
  }

  set blocks (blocks: Object) {
    this._chain = blocks
  }

  get blocksCount (): number {
    const blocks = this._chain
    return blocks.length
  }

  purge () {
    this._chain.length = 0
    this._logger.info('metaverse has been purged')
  }

  /**
   * Get sencond to highest block in Multiverse
   * @returns {*}
   */
  getParentHighestBlock (): ?BcBlock {
    if (this._chain.length > 1) {
      return false
    }
    return this._chain[1]
  }

  /**
   * Get highest block in Multiverse
   * @returns {*}
   */
  getHighestBlock (): ?BcBlock {
    if (this._chain.length === 0) {
      return false
    }
    return this._chain[0]
  }

  /**
   * Get lowest block by block key
   * @returns {*}
   */
  getLowestBlock (): ?BcBlock {
    if (this._chain.length > 0) {
      return this._chain[this._chain.length - 1]
    }
    return false
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
    // if no block is available go by total difficulty
    // FAIL if new block not within 16 seconds of local time
    if (newBlock.getTimestamp() + 21 < Math.floor(Date.now * 0.001)) {
      return false
    }
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
    if (newBlock.getPreviousHash() === currentParentHighestBlock.getHash() && validateBlockSequence([newBlock, currentParentHighestBlock]) === true) {
      this._chain.shift()
      this._chain.unshift(newBlock)
      return true
    }
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
    if (currentHighestBlock === false) {
      this._chain.unshift(newBlock)
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
  addResyncRequest (newBlock: BcBlock): boolean {
    const currentHighestBlock = this.getHighestBlock()
    const currentParentHighestBlock = this.getParentHighestBlock()

    // PASS if no highest block exists go with current
    if (currentHighestBlock === false) {
      return true
    }

    // FAIL if new block not within 16 seconds of local time
    if (newBlock.getTimestamp() + 16 < Math.floor(Date.now() * 0.001)) {
      return false
    }
    if (currentParentHighestBlock === false && currentHighestBlock !== false) {
      if (new BN(newBlock.getTotalDifficulty()).gt(new BN(currentHighestBlock.getTotalDifficulty()))) {
        this.addCandidateBlock(newBlock)
        return true
      }
    }
    // FAIL if newBlock total difficulty <  currentHighestBlock
    if (new BN(newBlock.getTotalDifficulty()).lt(new BN(currentHighestBlock.getTotalDifficulty()))) {
      return false
    }
    // TODO: need child sum function
    // TODO: make sure that blocks that are added reference child chains
    // FAIL if sum of child block heights is less than the rovered child heights
    // if (roveredChildHeights(newBlock) <= roveredChildHeights(currentParentHighestBlock)){
    //   return false
    // }
    this.addCandidateBlock(newBlock)
    return true
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
