#!/bin/bash
BC_MAX_CONNECTIONS=1000
while true; do
    logname=log_`date +%s`.log
    timeout -s 9 1h ./bin/cli start --rovers --ws --ui --node --miner-key 0xf34fa87db39d15471bebe997860dcd49fc259318 &> $logname
    gzip $logname
done
