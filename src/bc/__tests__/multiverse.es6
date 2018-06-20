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

const range = (to: number): number[] => [...Array(to).keys()]

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
    block.setPreviousHash(previousBlock.getHash())
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

  describe.skip('addBlock', () => {
    it('adds two blocks', () => {
      const block1 = createMockBlock(1)

      const m = new Multiverse()
      m.addBlock(block1)
      expect(getHighestBlock(m).getHash()).toBe('aaa')

      const block2 = createMockBlock(2, block1)

      m.addBlock(block2)
      expect(getHighestBlock(m).getHash()).toBe('bbb')
    })

    it('holds maximum of 7 blocks', () => {
      const blocks = range(8).reduce((blocks, height) => {
        blocks.push(createMockBlock(height, blocks[height - 1]))
        return blocks
      }, [])

      const m = new Multiverse()
      blocks.map(b => m.addBlock(b))
      expect(blocks[7].getHash()).toBe('ggg')
      expect(getHighestBlock(m).getHash()).toBe('fff')
    })

    it('add sorts blocks by total distance', () => {
      const blocks = range(7).reduce((blocks, height) => {
        blocks.push(createMockBlock(height, blocks[height - 1]))
        return blocks
      }, [])

      const m = new Multiverse()
      blocks.map(b => m.addBlock(b))

      const extraTopBlock = new BcBlock()
      extraTopBlock.setHash('abc')
      extraTopBlock.setPreviousHash(blocks[5].getHash())
      extraTopBlock.setHeight(6)
      extraTopBlock.setTotalDistance('10000') // higher than blocks[7]
      extraTopBlock.setBlockchainHeaders(new BlockchainHeaders())
      extraTopBlock.setDistance(101)
      m.addBlock(extraTopBlock)

      expect(getHighestBlock(m).getHash()).not.toBe('fff')
      expect(getHighestBlock(m).getHash()).toBe('abc')
    })
  })
})
