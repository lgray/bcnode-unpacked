/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
const { Multiverse } = require('../multiverse')

const { BcBlock, BlockchainHeaders } = require('../../protos/core_pb')

const getHighestBlock = (multiverse: Multiverse): BcBlock => {
  let highest = multiverse.getHighestBlock()
  expect(highest).toBeInstanceOf(BcBlock)
  return highest
}

const createMockBlock = (height: number, previousBlock: ?BcBlock): BcBlock => {
  const block = new BcBlock()
  block.setHash(String.fromCharCode(96 + height).repeat(3))
  block.setHeight(height)
  block.setBlockchainHeaders(new BlockchainHeaders())
  block.setDistance(100)
  if (previousBlock) {
    block.setTotalDistance((Number(previousBlock.getTotalDistance()) + 100).toString())
  } else {
    block.setTotalDistance('101')
  }

  return block
}

describe(Multiverse, () => {
  it('can instantiate', () => {
    const m = new Multiverse()
    expect(m).toBeInstanceOf(Multiverse)
  })

  describe('addBlock', () => {
    it('adds two blocks', () => {
      const block1 = createMockBlock(1)

      const m = new Multiverse()
      m.addBlock(block1)
      expect(getHighestBlock(m).getHash()).toBe('aaa')

      const block2 = createMockBlock(2, block1)

      m.addBlock(block2)
      expect(getHighestBlock(m).getHash()).toBe('bbb')
    })

    it.only('adds series of blocks', () => {
      const blocks = [...Array(8).keys()].reduce((blocks, height) => { // ES6 version of range(from, to)
        blocks.push(createMockBlock(height, blocks[height - 1]))
        return blocks
      }, [])

      const m = new Multiverse()
      blocks.map(b => m.addBlock(b))
      expect(getHighestBlock(m).getHash()).toBe('bbb')
    })
  })
})
