const
	bcminer_gpu   = require('./build/Release/bcminer_gpu.node'),
        P        = require('p-promise'),
        { Mutex } = require('async-mutex')
	;

const thegpuminer = bcminer_gpu.BCGPUStream()

gpu_mutex = new Mutex()

function createMinerMemory() {
    thegpuminer.CreateMemory()
}

function destroyMinerMemory() {
    thegpuminer.DestroyMemory()
}

function runMiner(miner,
		  merkleRoot,
		  work,
		  timestamp,
		  difficulty) {
    const result = thegpuminer.RunMiner(Buffer.from(miner),
					Buffer.from(merkleRoot),
					Buffer.from(work),
					Buffer.from(timestamp.toString()),
					Buffer.from(difficulty.toString()))
    return result
}


module.exports =
{
    gpu_mutex,
    runMiner,
    createMinerMemory,
    destroyMinerMemory
};
