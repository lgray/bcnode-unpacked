/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
const { flatten } = require('ramda')

const { BcBlock, BlockchainHeader, BlockchainHeaders, Block } = require('../../protos/core_pb')
const { Multiverse } = require('../multiverse')

const PersistenceRocksDb = require('../../persistence/rocksdb').default
jest.mock('../../persistence/rocksdb')

const rndString = () => Number(Math.random().toString().slice(2)).toString(36)
const createMockBlockchainHeader = (blockchain: string, height: number) => new BlockchainHeader([
  blockchain, // string blockchain = 1;
  rndString(), // string hash = 2;
  rndString(), // string previous_hash = 3;
  Date.now() - (Math.random() * 1000 << 0), // uint64 timestamp = 4;
  height, // uint64 height = 5;
  rndString(), // string merkle_root = 6;
  1 // uint64 blockchain_confirmations_in_parent_count = 7;
])

const blockchainHeaderToRoveredBlock = (header: BlockchainHeader): Block => {
  return new Block([
    header.getBlockchain(),
    header.getHash(),
    header.getPreviousHash(),
    header.getTimestamp(),
    header.getHeight(),
    header.getMerkleRoot()
  ])
}

describe('Multiverse', () => {
  beforeEach(() => {
    // $FlowFixMe - flow is unable to properly type mocked module
    PersistenceRocksDb.mockClear()
  })

  test('constructor()', () => {
    const multiverse = new Multiverse(new PersistenceRocksDb())
    expect(multiverse.blocksCount).toEqual(0)
  })

  describe('validateRoveredBlocks', () => {
    let mockPersistence
    let multiverse
    let mockBlockchainHeaders

    beforeAll(() => {
      mockPersistence = new PersistenceRocksDb()
      multiverse = new Multiverse(mockPersistence)
      mockBlockchainHeaders = [
        [createMockBlockchainHeader('btc', 529338)], // btc
        [createMockBlockchainHeader('eth', 5858091)], // eth
        [createMockBlockchainHeader('lsk', 6351117)], // lsk
        [createMockBlockchainHeader('neo', 2435841)], // neo
        [createMockBlockchainHeader('wav', 1057785)] // wav
      ]
    })

    test('resolves as true if all blocks are roveres', async () => {
      // we don't care here about other values in the BcBlock so keep default values
      const mockBlock = new BcBlock()
      mockBlock.setBlockchainHeaders(new BlockchainHeaders(mockBlockchainHeaders))
      mockPersistence.getBulk.mockResolvedValueOnce(flatten(mockBlockchainHeaders).map(blockchainHeaderToRoveredBlock))

      const allAreRovered = await multiverse.validateRoveredBlocks(mockBlock)
      expect(allAreRovered).toBe(true)
    })

    test('resolves as false if some block in BlockchainHeaders was not rovered by node', async () => {
      // we don't care here about other values in the BcBlock so keep default values
      const mockBlock = new BcBlock()
      mockBlock.setBlockchainHeaders(new BlockchainHeaders(mockBlockchainHeaders))
      // mock that persistence returns olny eth, lsk, neo and wav Block from persistence (btc is missing - was not rovered)
      const mockGetBulkReturnValue = flatten(mockBlockchainHeaders).map(blockchainHeaderToRoveredBlock).slice(1)
      mockPersistence.getBulk.mockResolvedValueOnce(mockGetBulkReturnValue)

      const allAreRovered = await multiverse.validateRoveredBlocks(mockBlock)
      expect(allAreRovered).toBe(false)
    })
  })
})
