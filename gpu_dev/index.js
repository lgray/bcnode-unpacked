const
	bcminer_gpu   = require('./build/Release/bcminer_gpu.node'),
	P        = require('p-promise')
	;

// var thegpuminer = bcminer_gpu.BCGPUStream()

function runMiner(miner,
		  merkleRoot,
		  work,
		  timestamp,
		  difficulty) {

    var thegpuminer = bcminer_gpu.BCGPUStream()
    const result = thegpuminer.RunMiner(Buffer.from(miner),
					Buffer.from(merkleRoot),
					Buffer.from(work),
					Buffer.from(timestamp.toString()),
					Buffer.from(difficulty.toString()))
    return result
}


module.exports =
{
    bcminer_gpu,
    runMiner
};
