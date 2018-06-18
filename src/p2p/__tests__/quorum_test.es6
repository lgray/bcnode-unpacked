/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

const { PEER_QUORUM_SIZE } = require('../quorum')

describe('quorum', () => {
  it('PEER_QUORUM_SIZE', () => {
    expect(PEER_QUORUM_SIZE).toEqual(16)
  })
})
