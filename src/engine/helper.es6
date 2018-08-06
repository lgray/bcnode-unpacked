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
const getIP = require('external-ip')()

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

export const peerify = (peer, channel): Object => {
  if (typeof peer === 'number') peer = {port: peer}
  if (!peer.host) peer.host = '127.0.0.1'
  peer.id = peer.host + ':' + peer.port + '@' + (channel ? channel.toString('hex') : '')
  peer.retries = 0
  peer.channel = channel
  return peer
}

export const doesNewBlockPreviousHashReferenceBlockInMultiverse = (newBlock: BcBlock, multiverse: Multiverse): boolean => {
  return multiverse.addNextBlock(newBlock)
}

export const stringToHex = (str) => {
  return bitPony.string.write(str).toString('hex')
}

export const hexToString = (str) => {
  return bitPony.string.read(str).toString()
}

export const anyDns = async () => {
  try {
    const ip = await dns.getIPv4()
    return Promise.resolve(ip)
  } catch (err) {
    return new Promise((resolve, reject) => {
      getIP((err, ip) => {
        if (err) { reject(err) } else {
          resolve(ip)
        }
      })
    })
  }
}

export const protocolBits = {
  '0000R01': '[*]', // introduction
  '0001R01': '[*]', // reserved
  '0002W01': '[*]', // reserved
  '0003R01': '[*]', // reserved
  '0004W01': '[*]', // reserved
  '0005R01': '[*]', // list services
  '0006R01': '[*]', // read block heights (full sync)
  '0007W01': '[*]', // write block heights
  '0008R01': '[*]', // read highest block
  '0008W01': '[*]', // write highest block
  '0009R01': '[*]', // read multiverse (selective sync)
  '0010W01': '[*]' // write multiverse (selective sync)
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
