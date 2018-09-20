var testminer = require('./build/Release/bcminer_gpu.node')

const { distance } = require('../lib/mining/primitives')
const { blake2bl } = require('../lib/utils/crypto')

console.log(testminer)

test = testminer.BCGPUStream()

console.log(test)

output = test.RunMiner(Buffer.from('0xf34fa87db39d15471bebe997860dcd49fc259318'),
		       Buffer.from('7aff5341ec1a1caa51c74c162c7f2a3946fe28f23b6e630de995f74d5767f865'),
		       Buffer.from('0edd781347cfc9c3ff49fdc423c7f1a3deae6501e5cef6b99c45c8901f763320'),
		       Buffer.from('1536810114'),
		       Buffer.from('291112262029012'))

result_local = blake2bl('0xf34fa87db39d15471bebe997860dcd49fc259318' +
			'19862754ee86360284a2a2fb25e1cacf1fdd211651aaf09bb0ad49a87c01ac2f' + // '7aff5341ec1a1caa51c74c162c7f2a3946fe28f23b6e630de995f74d5767f865' +
			blake2bl('2303811531') +
			'1537430685')

console.log(output)
console.log(output.nonce + ' ' + output.iterations)


console.log('replay hash on cpu: ' + result_local.toString())
console.log('replay dist on cpu: ' + distance('c8b5ee9f246fc2c12a39db427e57aea2c54d7f6b45ce907654465a11f790471c',
					      result_local.toString()) )
