#!/bin/bash
docker run --rm --name bcnode2 -d -p 3001:3001 -p 9091:9091 blockcollider/bcnode:0.7.6 start --ws --rovers --ui --node --miner-key 0x879bd664b016326a401d083b33d092293333a830
docker run --rm --name bcnode3 -d -p 3002:3002 -p 9092:9092 blockcollider/bcnode:0.7.6 start --ws --rovers --ui --node --miner-key 0x269bd224b016326a401d083b33d092293333a830
docker run --rm --name bcnode4 -d -p 3003:3003 -p 9093:9093 blockcollider/bcnode:0.7.6 start --ws --rovers --ui --node --miner-key 0x329bd334b016326a401d083b33d092293333a830
docker run --rm --name bcnode5 -d -p 3004:3004 -p 9094:9094 blockcollider/bcnode:0.7.6 start --ws --rovers --ui --node --miner-key 0x919bd774b016326a401d083b33d092293333a830
docker run --rm --name bcnode6 -d -p 3005:3005 -p 9095:9095 blockcollider/bcnode:0.7.6 start --ws --rovers --ui --node --miner-key 0x829bd774b016326a401d083b33d092293333a830
docker run --rm --name bcnode7 -d -p 3006:3006 -p 9096:9096 blockcollider/bcnode:0.7.6 start --ws --rovers --ui --node --miner-key 0x639bd774b016326a401d083b33d092293333a830
docker run --rm --name bcnode8 -d -p 3007:3007 -p 9097:9097 blockcollider/bcnode:0.7.6 start --ws --rovers --ui --node --miner-key 0x689bd774b016326a401d083b33d092293333a830

