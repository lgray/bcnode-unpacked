#! /usr/bin/env bash

#export DEBUG=discovery-*
#export BC_DEBUG=true
#export BC_PLUGIN=lib/plugin/fakeBlocks.js
#export BC_DATA_DIR=_tmp/data

export BC_GRPC_PORT=11111
export BC_MINER_KEY=0x12ae6e9e36c8bf75b8707d07856abffca40e10db
export BC_LIMIT_MINER=true
export BC_ROVER_REPLAY=true
export MIN_HEALTH_NET=true
export BC_BOOT_BLOCK="../utils/templates/bc.block.93699.json"
yarn build && rm -Rf log1.txt && ./bin/cli start --ws --ui --node $@ 2>&1 | tee log1.txt
