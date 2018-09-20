var testminer = require('./build/Release/bcminer_gpu.node')

console.log(testminer)

test = testminer.BCGPUStream()

console.log(test)

test.RunMiner(Buffer.from('0xf34fa87db39d15471bebe997860dcd49fc259318'),
	      Buffer.from('7aff5341ec1a1caa51c74c162c7f2a3946fe28f23b6e630de995f74d5767f865'),
	      '2','3','4')
