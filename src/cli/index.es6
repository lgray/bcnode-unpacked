// @flow

import program from 'commander'

const pkg = require('../../package.json')

// eslint-disable-next-line import/prefer-default-export
export function main () {
  // concat(1, 2);

  program
    .version(pkg.version)
    .option('--rpc', 'Start RPC Server')
    .option('--ws', 'Start WebSocket Server')
    .parse(process.argv)
}