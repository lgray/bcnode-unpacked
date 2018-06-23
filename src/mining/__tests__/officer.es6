/*
 * Copyright (c) 2017-present, Block Collider developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
const { MiningOfficer } = require('../officer')

const { Block } = require('../../protos/core_pb')
const PersistenceRocksDb = require('../../persistence/rocksdb').default
const { PubSub } = require('../../engine/pubsub')
const { getGenesisBlock } = require('../../bc/genesis')
const { fork } = require('child_process')

jest.mock('../../engine/pubsub')
jest.mock('../../persistence/rocksdb')
jest.mock('child_process')

describe(MiningOfficer, () => {
  beforeEach(() => {
    // $FlowFixMe
    PersistenceRocksDb.mockClear()
    // $FlowFixMe
    PubSub.mockClear()
  })

  it('runs miner when all blocks collected', async () => {
    const minedBlock = new Block(['btc', 'bbb', 'aaa', 1234, 1001, 'ccc'])
    const persistence = new PersistenceRocksDb()
    persistence.get.mockResolvedValueOnce(minedBlock) // btc.block.latest
    persistence.get.mockResolvedValueOnce(getGenesisBlock()) // bc.block.latest

    const mockPid = 9887
    const mockChildProcess = { on: jest.fn(), send: jest.fn(), pid: mockPid }
    fork.mockReturnValue(mockChildProcess)
    const officer = new MiningOfficer(new PubSub(), persistence, { minerKey: 'a', rovers: ['btc'] })
    const result = await officer.newRoveredBlock(['btc'], minedBlock)

    expect(result).toBe(mockPid)
    expect(mockChildProcess.on).toHaveBeenCalledTimes(3)
    expect(mockChildProcess.send).toHaveBeenCalledTimes(1)
  })
})
