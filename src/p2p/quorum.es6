/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

const { config } = require('../config')

export const PEER_QUORUM_SIZE = config.p2p.quorum.size + Math.floor(Math.random() * 20) - 5
