/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
const {
  reduce,
  concat
} = require('ramda')

export const concatAll = reduce(concat, [])

export const randRange = (min: number, max: number) => Math.random() * ((max - min) + 1) + min << 0
