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
		       Buffer.from('313986908089552'))

result_local = blake2bl('0xf34fa87db39d15471bebe997860dcd49fc259318' +
			'7aff5341ec1a1caa51c74c162c7f2a3946fe28f23b6e630de995f74d5767f865' +
			blake2bl(output.nonce.toString()) +
			'1536810114')

console.log(output)
console.log(output.nonce + ' ' + output.iterations)


console.log('replay hash on cpu: ' + result_local.toString())
console.log('replay dist on cpu: ' + distance('0edd781347cfc9c3ff49fdc423c7f1a3deae6501e5cef6b99c45c8901f763320',
					      result_local.toString()) )
