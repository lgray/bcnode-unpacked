const
	bindings = require('bindings'),
	blake2_gpu   = bindings('blake2_gpu'),
	P        = require('p-promise')
	;

function doWork(miner_key, merkle_root, timestamp, difficulty)
{
    if ( !Buffer.isBuffer(miner_key) || !Buffer.isBuffer(merkle_root) ||
	 !Buffer.isBuffer(timestamp) || !Buffer.isBuffer(difficulty) )
	{
		throw new TypeError('One of the things you passed as input is not a buffer');
	}

    return blake2_gpu.do_bc_work(miner_key,merkle_root,timestamp,difficulty);
}



module.exports =
{
	// convenience wrappers
	doWork,
	
	// exposing the implementations
	blake2_gpu:       function(miner_key,merkle_root,timestamp) { return doWork(miner_key,merkle_root,timestamp); }
};
