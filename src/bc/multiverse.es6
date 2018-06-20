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
const { equals, flatten } = require('ramda')

const { config } = require('../config')
const { validateBlockSequence } = require('./validation')
const { standardId } = require('./helper')
const logging = require('../logger')

const COMMIT_MULTIVERSE_DEPTH = config.bc.multiverse.commitDepth

export class Multiverse {
  _blocks: Object
  _commitDepth: number
  _writeQueue: BcBlock[]
  _height: number
  _created: number
  _selective: boolean
  _id: string
  _logger: Logger

  constructor (selective: boolean = false, commitDepth: number = COMMIT_MULTIVERSE_DEPTH) {
    this._id = standardId()
    this._selective = selective
    this._blocks = {}
    this._writeQueue = []
    this._commitDepth = commitDepth
    this._logger = logging.getLogger(`bc.multiverse.${this._id}`, false)
    this._height = 0
    this._created = Math.floor(Date.now() * 0.001)
    if (selective === true) {
      this._logger.warn('selective multiverse created')
    }
  }

  get blocks (): Object {
    return this._blocks
  }

  set blocks (blocks: Object) {
    this._blocks = blocks
  }

  get blocksCount (): number {
    const blocks = Object.keys(this._blocks)
    return blocks.length
  }

  getMissingBlocks (block: BcBlock): Object | boolean {
    if (!block) {
      this._logger.error('no block submitted to evaluate')
      return false
    }

    const height = block.getHeight()
    const hash = block.getHash()
    const previousHash = block.getPreviousHash()
    const distance = block.getTotalDistance()

    const template = {
      queryHash: hash,
      queryHeight: height,
      message: '',
      from: 0,
      to: 0
    }

    const highestBlock = this.getHighestBlock()
    if (!highestBlock) {
      this.addBlock(block)
      template.message = 'no highest block has been selected for multiverse'
      return template
    }

    const highestBlockHash = highestBlock.getHash()
    if (highestBlockHash === hash) {
      template.message = 'blocks are the equal to each-other'
      return template
    }

    const highestBlockHeight = highestBlock.getHeight()
    if (highestBlockHeight === height) {
      if (new BN(highestBlock.getTotalDistance()).lt(new BN(distance)) === true) {
        this.addBlock(block)
        template.message = 'purposed block will be the current height of the multiverse'
      }

      return template
    }

    if (highestBlockHash === previousHash) {
      this.addBlock(block)
      template.message = 'purposed block is next block'
      return template
    }

    if (highestBlockHeight + 2 < height) {
      template.from = highestBlockHeight - 2
      template.to = height + 1
      template.message = 'purposed block is ahead and disconnected from multiverse'
      return template
    }

    if (highestBlockHeight > height && (highestBlockHeight - height <= 7)) {
      this.addBlock(block)
      template.from = height - 10
      template.to = height + 1
      template.message = 'purposed block may be in a multiverse layer'
      return template
    }

    const lowestBlock = this.getLowestBlock()
    if (lowestBlock && (highestBlockHeight > height)) {
      this.addBlock(block)

      const lowestBlockHeight = lowestBlock && lowestBlock.getHeight()
      template.from = height - 1
      template.to = lowestBlockHeight + 1 // Plus one so we can check with the multiverse if side chain
      template.message = 'purposed block far behnd multiverse'

      return template
    }

    return template
  }

  validateMultiverse (mv: Object): boolean {
    if (Object.keys(mv).length < 3) {
      this._logger.error('threshold not met, comparison between multiverse structures after dimension depth of 3')
      return false
    }
    return true
  }

  isBestMultiverse (alt: Object): boolean {
    const current = this._blocks
    if (!this.validateMultiverse(alt)) {
      this._logger.warn('candidate multiverse is malformed')
      return false
    }
    if (Object.keys(current).length < 7) {
      this._logger.warn('current multiverse below suggested distance threshold')
    }
    // TODO: Switch to child chain comparisons
    return false
  }

  addBlock (block: BcBlock, force: boolean = false): boolean {
    // TODO @klob extract to helpers
    const getAllBlockchainHashes = (block: BcBlock) => {
      const headersObj = block.getBlockchainHeaders().toObject()
      return Object.keys(headersObj).reduce((acc, blockchainListKey) => {
        return acc.concat(headersObj[blockchainListKey].map(headerObj => headerObj.hash))
      }, [])
    }

    const self = this

    const height = block.getHeight()
    let syncing = false
    const keyCount = Object.keys(this._blocks).length

    this._logger.info('new multiverse candidate for height ' + height + ' (' + block.getHash() + ')')

    if (keyCount < 7 && this._selective === false) {
      this._logger.info('node is attempting to sync, multiverse filtering disabled')
      syncing = true
      force = true
      // keyCount must be 2 to account for the genesis block and the next block
    } else if (keyCount < 1) {
      syncing = true
      force = true
    }

    let hasParent = false
    let hasParentHash = false
    let hasParentHeight = false
    let uniqueParentHeaders = false
    const blockHeaderHashes = getAllBlockchainHashes(block)
    const parentHeight = height - 1
    if (this._blocks[parentHeight]) {
      hasParentHash = this._blocks[parentHeight].reduce((all, item, i) => {
        if (item.getHash() === block.getPreviousHash()) {
          this._logger.debug('!!! block ' + item.getHash() + ' is PARENT of --> ' + block.getHeight() + ' ' + block.getHash())
          all = true
        }
        return all
      }, false)

      hasParentHeight = this._blocks[parentHeight].reduce((all, item, i) => {
        if (item.getHeight() === (block.getHeight() - 1)) {
          this._logger.debug('!!! block ' + item.getHeight() + '  is parent of block ' + block.getHeight() + ' ' + block.getHash())
          all = true
        }
        return all
      }, false)

      const parentBlockHeaders = getAllBlockchainHashes(this._blocks[parentHeight][0])
      uniqueParentHeaders = !equals(parentBlockHeaders, blockHeaderHashes)
      hasParent = hasParentHash === true && hasParentHeight === true && uniqueParentHeaders === true
    }

    let uniqueChildHeaders = false
    let hasChild = false
    let hasChildHash = false
    let hasChildHeight = false
    const childHeight = height + 1
    if (this._blocks[childHeight] !== undefined) {
      hasChildHash = this._blocks[childHeight].reduce((all, item, i) => {
        if (item.getPreviousHash() === block.getHash() && (item.getHeight() - 1) === block.getHeight()) {
          this._logger.debug('!!! block ' + item.getHash() + ' <-- is CHILD of ' + block.getHeight() + ' ' + block.getHash())
          all = true
        }
        return all
      }, false)

      hasChildHeight = this._blocks[childHeight]
        .reduce((all, item, i) => {
          if ((item.getHeight() - 1) === block.getHeight()) {
            this._logger.debug('!!! block ' + item.getHeight() + ' <-- is CHILD of ' + block.getHeight() + ' ' + block.getHash())
            all = true
          }
          return all
        }, false)

      const childBlockHeaders = getAllBlockchainHashes(this._blocks[childHeight][0])
      uniqueChildHeaders = !equals(childBlockHeaders, blockHeaderHashes)
      hasChild = hasChildHash === true && hasChildHeight === true && uniqueChildHeaders === true
    }

    let alreadyInMultiverse = false
    if (this._blocks[height]) {
      // FIXME: Use https://ramdajs.com/docs/#any
      alreadyInMultiverse = this._blocks[height].reduce((all, item) => {
        if (item.getHash() === block.getHash()) {
          all = true
        }

        return all
      }, false)
    }

    if (!hasChild && !hasParent) {
      const failures = {}
      failures['hasParentHash'] = hasParentHash
      failures['hasParentHeight'] = hasParentHeight
      failures['uniqueParentHeaders'] = uniqueParentHeaders
      failures['hasChildHash'] = hasChildHash
      failures['hasChildHeight'] = hasChildHeight
      failures['uniqueChildHeaders'] = uniqueChildHeaders
      this._logger.info(failures)
    }

    this._logger.info(`Block hasParent: ${hasParent.toString()}, hasChild: ${hasChild.toString()}, syncing: ${syncing.toString()}, height: ${height.toString()}, alreadyInMultiverse: ${alreadyInMultiverse.toString()}`)
    if (hasParent || hasChild) {
      if (alreadyInMultiverse) {
        this._logger.warn('block ' + block.getHash() + ' already in multiverse')
        return false
      }

      if (self._blocks[height] === undefined) {
        self._blocks[height] = []
      }

      if (self._blocks[height][0] && (self._blocks[height][0].getHash() === block.getPreviousHash())) {
        self._blocks[height].push(block)
      } else {
        self._blocks[height].push(block)
      }

      if (self._blocks[height].length > 1) {
        self._blocks[height] = self._blocks[height].sort((a, b) => {
          if (new BN(a.getTotalDistance()).lt(new BN(b.getTotalDistance())) === true) {
            return 1
          }

          if (new BN(a.getTotalDistance()).gt(new BN(b.getTotalDistance())) === true) {
            return -1
          }

          return 0
        })
      }

      return true
    }

    if (force || syncing) {
      if (!self._blocks[height]) {
        self._blocks[height] = []
      }

      self._blocks[height].push(block)

      if (self._blocks[height].length > 1) {
        self._blocks[height] = self._blocks[height].sort((a, b) => {
          if (new BN(a.getTotalDistance()).lt(new BN(b.getTotalDistance())) === true) {
            return 1
          }

          if (new BN(a.getTotalDistance()).gt(new BN(b.getTotalDistance())) === true) {
            return -1
          }

          return 0
        })
      }

      return true
    }

    return false
  }

  purge () {
    this._blocks = {}
    this._writeQueue = []
    this._logger.info('metaverse has been purged')
  }

  caseBetterMultiverse (block: BcBlock): ?BcBlock {
    const currentHighestBlock = this.getHighestBlock()
    this._logger.info('caseBetterMultiverse()', currentHighestBlock)

    // TODO: Stub function for the comparison of two multiverse structures
    return currentHighestBlock
  }

  /**
   * Get highest block in Multiverse
   *
   * ```
   *
   *  --X|---
   *  ---|-X-
   *  X--|---
   *
   * ```
   *  dim([t,d]) . max(t+d*n)
   *
   */
  getHighestBlock (depth: ?number = 7, keys: string[] = [], inList: ?Array<BcBlock>): ?BcBlock {
    if (Object.keys(this._blocks).length === 0) {
      this._logger.warn('unable to determine height from incomplete multiverse')
      return null
    }

    let list = inList || []
    if (keys.length === 0) {
      keys = Object.keys(this._blocks).sort((a, b) => {
        if (a > b) {
          return -1
        }

        if (a < b) {
          return 1
        }

        return 0
      })

      list = []
    }

    const currentHeight = keys.pop()
    const currentRow = this._blocks[currentHeight]
    let matches = []
    currentRow.map((candidate) => { // [option1, option2, option3]
      matches = list.reduce((all, chain) => {
        if (chain && chain[0]) {
          if (chain[0].getPreviousHash() === candidate.getHash()) {
            all++
            chain.unshift(candidate)
          }
        }

        return all
      }, 0)

      if (matches === 0) { // this must be it's own chain
        list.push([candidate])
      }
    })

    // Cycle through keys
    if (keys.length > 0) {
      return this.getHighestBlock(depth, keys, list)
    }

    const minimumDepthChains = list.reduce((all, chain) => {
      if (chain.length >= depth && validateBlockSequence(chain) === true) {
        all.push(chain)
      }

      return all
    }, [])

    if (minimumDepthChains === undefined) {
      // Any new block is the highest
      return true
    }

    if (minimumDepthChains !== undefined && minimumDepthChains.length === 0) {
      const performance = list.reduce((order, chain) => {
        const totalDistance = chain.reduce((all, b) => {
          all = new BN(b.getTotalDistance()).add(new BN(all))
          return all
        }, 1)
        if (order.length === 0) {
          order.push([chain, totalDistance])
        } else if (order.length > 0 && order[0] !== undefined && order[0][1] < totalDistance) {
          order.unshift([chain, totalDistance])
        }
        return order
      }, [])

      const results = performance.sort((a, b) => {
        if (a[1] > b[1]) {
          return 1
        }

        if (a[1] < b[1]) {
          return -1
        }

        return 0
      }).reverse()

      return results[0][0].pop()
    }

    if (minimumDepthChains && minimumDepthChains.length === 1) {
      return minimumDepthChains[0][0]
    }

    const performance = minimumDepthChains.reduce((order, chain) => {
      const totalDistance = chain.reduce((all, b) => {
        all = new BN(b.getTotalDistance()).add(all)
        all.push(b)
      }, 1)

      if (order.length === 0) {
        order.push([chain, totalDistance])
      } else if (order.length > 0 && order[0] !== undefined && order[0][1] < totalDistance) {
        order.unshift([chain, totalDistance])
      }

      return order
    }, [])

    const results = performance.sort((a, b) => {
      if (a[1] < b[1]) {
        return 1
      }

      if (a[1] > b[1]) {
        return -1
      }

      return 0
    }).reverse()

    return results[0][0].pop()
  }

  /**
   * Get lowest block by block key
   * @returns {*}
   */
  getLowestBlock (): ?BcBlock {
    const keys = Object.keys(this._blocks)
    if (keys.length < 1) {
      return null
    }

    const last = keys.shift()
    return this._blocks[last][0]
  }

  /**
   * Check if block should be broadcasted
   * @param block New block
   * @param force Force broadcast flag
   * @returns {boolean}
   */
  shouldBroadcastBlock (block: BcBlock, force: boolean = false): boolean {
    const highestBlock = this.getHighestBlock()
    if (!highestBlock) {
      return false
    }

    if (this.addBlock(block, force) === true) {
      // $FlowFixMe
      const height = highestBlock.getHeight()
      if (block.getHeight() >= height) {
        return true
      }
    }

    // NOTE: Should we broadcast if addBlock() returned false?
    return true
  }

  /**
   * Get multiverse as nested `BcBlock` array
   * @returns {*}
   */
  toArray (): Array<Array<BcBlock>> {
    return this._blocks.toarray()
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
