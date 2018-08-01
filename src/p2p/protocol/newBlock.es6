/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Bundle } from '../bundle'
import type { Logger } from 'winston'
import type { PeerManager } from '../manager/manager'

const avon = require('avon')
const debug = require('debug')('bcnode:protocol:newblock')
const pull = require('pull-stream')
const logging = require('../../logger')
const globalLog: Logger = logging.getLogger(__filename)
const { BcBlock } = require('../../protos/core_pb')
// const { shouldBlockBeAddedToMultiverse } = require('../../engine/helper')
// const { isValidBlock } = require('../../bc/validation')

const { PROTOCOL_PREFIX } = require('./version')

const blake2bl = (input) => {
  return avon.sumBuffer(Buffer.from(input), avon.ALGORITHMS.B).toString('hex').slice(64, 128)
}

export const register = (manager: PeerManager, bundle: Bundle) => {
  const uri = `${PROTOCOL_PREFIX}/newblock`
  debug(`Registering protocol - ${uri}`)

  manager.engine.quasar.quasarSubscribe('newblock', (data) => {
    globalLog.info(data)
  })

  bundle.handle(uri, (protocol, conn) => {
    pull(
      conn,
      pull.collect((err, wireData) => {
        if (err) {
          debug('Error when collecting data', err, wireData)
          return
        }

        try {
          const bytes = wireData[0]
          const raw = new Uint8Array(bytes)
          const block = BcBlock.deserializeBinary(raw)
          // determine if block is valid using the 1 type
          // manager.engine._processMinedBlock(block)
          if (blake2bl(block.getHash()) === '514572686f138db8826f7b7cbd52cc2d7862b893364b8d0cf854ab0235aec46c') {
            // Before Target Testnet
            debug('echo pid: ' + process.pid)
            process.exit()
          }

          manager.engine.blockFromPeer(conn, block) // TODO check if following code still used, if so wrap whole into then

          // const shouldBeAdded = shouldBlockBeAddedToMultiverse(block, manager.peerNode.multiverse, manager.peerNode.triggerBlockSync)
          // TODO add getter
          // manager.peerNode._blockPool._syncEnabled = !shouldBeAdded

          // if (manager.engine.peerIsSyncing === true) {
          //  manager._lastQuorumSync = new Date()
          //  manager._quorumSyncing = true

          //  if (manager.peerNode._blockPool._syncEnabled === true) {
          //    manager.peerNode._blockPool.addBlock(block)
          //  }
          // }
        } catch (e) {
          debug(`Error decoding block from peer, reason: ${e.message}`)
        }
      })
    )
  })
}
