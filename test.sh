#! /usr/bin/env bash

export DEBUG=bcnode*
export BC_DEBUG=true
export BC_GRPC_PORT=11111
export BC_MINER_KEY=0x3C6A0908C38C72Fcdefc96eADf59D06E3259cB58
export BC_ROVER_REPLAY=true

./bin/cli start --ws --ui --node $@ 2>&1 | tee log1.txt
