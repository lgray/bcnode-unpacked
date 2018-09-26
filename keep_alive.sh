#!/bin/bash
BC_MAX_CONNECTIONS=1000
while true; do
    timeout -s 9 60m ./bin/cli start --ws --ui --node --miner-key 0xf34fa87db39d15471bebe997860dcd49fc259318 &> log_`date +%s`.log
done
