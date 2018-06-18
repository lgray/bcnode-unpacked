/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

const crypto = require('crypto')
const Backoff = require('backo')

/**
 * Generate private key using random bytes
 */
export function getPrivateKey (length: number = 32) {
  return crypto.randomBytes(length)
}

export function getBackoff (opts: { min: number, max: number, jitter: number, factor: number } = { min: 5000, max: 20000, factor: 1.3, jitter: 2 }) {
  return new Backoff(opts)
}
