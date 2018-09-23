var testminer = require('./build/Release/bcminer_gpu.node')

const { distance } = require('../lib/mining/primitives')
const { blake2bl } = require('../lib/utils/crypto')

console.log(testminer)

test = testminer.BCGPUStream()

console.log(test)

test.CreateMemory()

output = test.RunMiner(Buffer.from('0xf34fa87db39d15471bebe997860dcd49fc259318'),
		       Buffer.from('0128174cd979e79d67d094fad6aac63d57352b058cbafbb5060f6a9359125105'),
		       Buffer.from('2e06bfa5e91d96e0cff610ed3ced04d3b53bb41780b1a5f6d41710f902090721'),
		       Buffer.from('1537632558'),
		       Buffer.from('303810187437540'))

result_local = blake2bl('0xf34fa87db39d15471bebe997860dcd49fc259318' +
			'0128174cd979e79d67d094fad6aac63d57352b058cbafbb5060f6a9359125105' +
			blake2bl(output.nonce.toString()) +
			'1537632558')

console.log(output)
console.log(output.nonce + ' ' + output.iterations)


console.log('replay hash on cpu: ' + result_local.toString())
console.log('replay dist on cpu: ' + distance('2e06bfa5e91d96e0cff610ed3ced04d3b53bb41780b1a5f6d41710f902090721',
					      result_local.toString()) )

test.DestroyMemory()
