#! /usr/bin/env bash

export BC_GRPC_PORT=11111
export BC_MINER_KEY=0x09254c21040dc81cab1583beb03338caca2e526c
export BC_LIMIT_MINER=true
export BC_ROVER_REPLAY=true
export MIN_HEALTH_NET=true
export BC_BOOT_BLOCK="../utils/templates/bc.block.93699.json"
yarn build && rm -Rf log1.txt && ./bin/cli start --ws --ui --node $@ 2>&1 | tee log1.txt


