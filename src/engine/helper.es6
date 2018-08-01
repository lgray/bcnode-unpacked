/**
 * Copyright (c) 2017-present, BlockCollider developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type Multiverse from '../bc/multiverse'
import type BcBlock from '../protos/core_pb'

const BN = require('bn.js')
const bitPony = require('bitpony')
const dns = require('bdns')

/**
 * High-level functions
 */
export const shouldBlockBeAddedToMultiverse = (newBlock: BcBlock, multiverse: Multiverse, triggerSync: Function): bool => {
  if (timestampIsSignificantSecondsBelowLocalTime(newBlock)) {
    triggerSync()
    return false
  }

  if (doesNewBlockPreviousHashReferenceBlockInMultiverse(newBlock, multiverse)) {
    multiverse.addNextBlock(newBlock)
    return true
  }

  if (isNewBlockHeightLowerThanLowestInMultiverse(newBlock, multiverse)) {
    triggerSync()
    return false
  }

  if (isNewBlockTimestampGreaterThanHighestInMultiverse(newBlock, multiverse)) {
    triggerSync()
    return false
  }

  multiverse.addNextBlock(newBlock)
  return true
}

const isTimestampWithin = (newBlock: BcBlock, seconds: number): boolean => {
  return (Date.now() * 0.001 - newBlock.getTimestamp()) < seconds
}

export const timestampIsSignificantSecondsBelowLocalTime = (newBlock: BcBlock): boolean => {
  return isTimestampWithin(newBlock, 12) === false
}

export const doesNewBlockPreviousHashReferenceBlockInMultiverse = (newBlock: BcBlock, multiverse: Multiverse): boolean => {
  return multiverse.addNextBlock(newBlock)
}

export const stringToHex = (str) => {
  return bitPony.string.write(str).toString('hex')
}

export const anyDns = async () => {
  try {
    return await dns.getIPv4()
  } catch (err) {
    return new Error('unable to determine exteral IP address')
  }
}

export const utf8ArrayToString = (array): string => {
  var out, i, len, c
  var char2, char3

  out = ''
  len = array.length
  i = 0
  while (i < len) {
    c = array[i++]
    switch (c >> 4) {
      case 0: case 1: case 2: case 3: case 4: case 5: case 6: case 7:
        // 0xxxxxxx
        out += String.fromCharCode(c)
        break
      case 12: case 13:
        // 110x xxxx   10xx xxxx
        char2 = array[i++]
        out += String.fromCharCode(((c & 0x1F) << 6) | (char2 & 0x3F))
        break
      case 14:
        // 1110 xxxx  10xx xxxx  10xx xxxx
        char2 = array[i++]
        char3 = array[i++]
        out += String.fromCharCode(((c & 0x0F) << 12) |
                       ((char2 & 0x3F) << 6) |
                       ((char3 & 0x3F) << 0))
        break
    }
  }

  return out
}

export const isNewBlockHeightLowerThanLowestInMultiverse = (newBlock: BcBlock, multiverse: Multiverse): boolean => {
  multiverse.toFlatArray().forEach((block) => {
    if (block.getHeight() <= newBlock.getHeight()) {
      return false
    }
  })

  return true
}

export const isNewBlockTimestampGreaterThanHighestInMultiverse = (newBlock: BcBlock, multiverse: Multiverse): boolean => {
  multiverse.toFlatArray().forEach((block) => {
    if (block.getTimestamp() >= newBlock.getTimestamp()) {
      return false
    }
  })

  return true
}

export const blockByTotalDistanceSorter = (a: BcBlock, b: BcBlock) => {
  const aTotalDistance = new BN(a.getTotalDistance())
  const bTotalDistance = new BN(b.getTotalDistance())
  // a > b
  if (aTotalDistance.gt(bTotalDistance)) {
    return 1
  }

  // b > a
  if (aTotalDistance.lt(bTotalDistance)) {
    return -1
  }

  return 0
}
