/**
 * Copyright (c) 2017-present, Block Collider developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
/* eslint-disable */
const { inspect } = require('util')
const BN = require('bn.js')
const {
  all,
  aperture,
  equals,
  flatten,
  fromPairs,
  head,
  identity,
  last,
  reject,
  sort,
  sum
} = require('ramda')

const { getLogger } = require('../logger')
const { blake2bl } = require('../utils/crypto')
const { concatAll } = require('../utils/ramda')
const { BcBlock, BlockchainHeader, Block } = require('../protos/core_pb')
const {
  getExpFactorDiff,
  getNewBlockCount,
  getDiff,
  getChildrenBlocksHashes,
  getChildrenRootHash,
  blockchainMapToList,
  createMerkleRoot,
  prepareWork,
  distance
} = require('../mining/primitives')
const GENESIS_DATA = require('./genesis.raw')
const FINGERPRINTS_TEMPLATE = require('../utils/templates/blockchain_fingerprints.json')
const MINIMAL_DIFFICULTY = new BN(290112262029012, 16)

export type DfConfig = {
  [chain: string]: {dfNumerator: number, dfDenominator: number, dfVoid: number, dfBound: number}
}
export const DF_CONFIG: DfConfig = fromPairs(FINGERPRINTS_TEMPLATE.blockchainHeaders.map(
  ({name, dfNumerator, dfDenominator, dfVoid, dfBound}) => ([name, {dfNumerator, dfDenominator, dfVoid, dfBound}])
))

const logger = getLogger(__filename)

export function isValidBlock (newBlock: BcBlock, type: number = 0): bool {
  if (newBlock === undefined) {
    return false
  }
  // if (!theBlockChainFingerPrintMatchGenesisBlock(newBlock)) {
  //  logger.warn('failed: theBlockChainFingerPrintMatchGenesisBlock')
  //  return false
  // } // DISABLED UNTIL AT
  if (!numberOfBlockchainsNeededMatchesChildBlock(newBlock)) {
    logger.warn('failed: numberOfBlockchainsNeededMatchesChildBlock')
    return false
  }
  if (!ifMoreThanOneHeaderPerBlockchainAreTheyOrdered(newBlock)) {
    logger.warn('failed: ifMoreThanOneHeaderPerBlockchainAreTheyOrdered')
    return false
  }
  if (!isChainRootCorrectlyCalculated(newBlock)) {
    logger.warn('failed: isChainRootCorrectlyCalculated')
    return false
  }
  if (!isFieldLengthBounded(newBlock)) {
    logger.warn('failed: isFieldLengthBounded')
    return false
  }
  if (!isMerkleRootCorrectlyCalculated(newBlock)) {
    logger.warn('failed: isMerkleRootCorrectlyCalculated')
    return false
  }
  if (!isValidChildAge(newBlock)) {
    return false
  }
  if (!isDistanceAboveDifficulty(newBlock)) {
    logger.warn('failed: isDistanceAboveDifficulty')
    return false
  }
  if (!isDistanceCorrectlyCalculated(newBlock)) {
    logger.warn('failed: isDistanceCorrectlyCalculated')
    return false
  }
  if (type === 0) {
    //if (!areDarkFibersValid(newBlock)) {
    //  logger.warn('failed: areDarkFibersValid')
    //  return false
    //}
  }
  return true
}

export function isValidChildAge (newBlock: BcBlock, type: number = 0): bool {
  const newestHeader = getNewestHeader(newBlock)

  logger.info('confirming valid child ages for new block')
  if (newestHeader === false) {
    logger.warn('failed: validChildAge no upper limit child header found')
    return false
  }

  // add the offset for dark fiber
  const bcBlockTimestamp = new BN(newBlock.getTimestamp()).mul(new BN(1000)).toNumber()
  const highRangeLimit = 38 * 1000
  const lowRangeLimit = 12 * 1000
  const newestHeaderDFBound = DF_CONFIG[newestHeader.blockchain].dfBound * 1000
  const newestHeaderTimestamp = new BN(newestHeader.timestamp).add(new BN(newestHeaderDFBound)).toNumber()
  const upperTimestampLimit = new BN(newestHeaderTimestamp).add(new BN(highRangeLimit)).toNumber()
  const lowerTimestampLimit = new BN(newestHeaderTimestamp).sub(new BN(lowRangeLimit)).toNumber()

  logger.info('bcblocktimestamp timestamp: ' + bcBlockTimestamp)
  logger.info('newest header timestamp: ' + newestHeader.timestamp)
  logger.info('upperTimestampLimit: ' + upperTimestampLimit)
  logger.info('lowerTimestampLimit: ' + lowerTimestampLimit)
  /* eslint-enable */
  if (new BN(bcBlockTimestamp).gt(new BN(upperTimestampLimit)) === true) {
    logger.warn('failed: isValidChildAge upper limit')
    return false
  }

  if (new BN(bcBlockTimestamp).lt(new BN(lowerTimestampLimit)) === true) {
    logger.warn('failed: isValidChildAge lower limit')
    return false
  }
  return true
}

export async function isValidBlockCached (persistence: Object, newBlock: BcBlock, type: number = 0): Promise<boolean> {
  try {
    if (new BN(newBlock.getHeight()).lt(new BN(151500)) === true) {
      return Promise.resolve(true)
    }
    const cached = await persistence.get('valid_' + newBlock.getHash())
    // if of type: string 'false' it means the block is invalid
    return Promise.resolve(cached === 'true')
  } catch (_) {
    try {
      const valid = isValidBlock(newBlock, type)
      await persistence.put('valid_' + newBlock.getHash(), String(valid))
      // return this block in wrhatever state it was validated
      return Promise.resolve(valid)
    } catch (err) {
      // error attempting to parse this as a block, reject
      logger.error(err)
      return Promise.resolve(false)
    }
  }
}

export function getNewestHeader (newBlock: BcBlock): bool {
  logger.info('getting block height ' + newBlock.getHeight())
  if (newBlock === undefined) {
    logger.warn('failed: isValidChildAge new block could not be found')
    return false
  }

  const headers = newBlock.getBlockchainHeaders().toObject()
  const newestHeader = Object.keys(headers).reduce((newest, key) => {
    const sorted = headers[key].sort((a, b) => {
      /* eslint-disable */
      if (new BN(a.timestamp).gt(new BN(b.timestamp)) === true) {
        return 1
      }
      if (new BN(a.timestamp).lt(new BN(b.timestamp)) === true) {
        return -1
      }
      return 0
    })

    const header = sorted.pop()

    if (newest === false) {
      newest = header
    } else {
      if (new BN(newest.timestamp).lt(new BN(header.timestamp))) {
        newest = header
      }
    }
    return newest
  }, false)

  if (newestHeader === false) {
    return false
  }

  return newestHeader
}

// function theBlockChainFingerPrintMatchGenesisBlock (newBlock: BcBlock): bool {
//  logger.info('theBlockChainFingerPrintMatchGenesisBlock validation running')
//  return newBlock.getBlockchainFingerprintsRoot() === GENESIS_DATA.blockchainFingerprintsRoot
// }

function numberOfBlockchainsNeededMatchesChildBlock (newBlock: BcBlock): bool {
  logger.debug('numberOfBlockchainsNeededMatchesChildBlock validation running')
  // skip for genesis block - it chas no blockchain blocks embedded
  if (newBlock.getHeight() === GENESIS_DATA.hash && newBlock.getHeight() === 1) {
    return true
  }
  // verify that all blockain header lists are non empty and that there is childBlockchainCount of them
  const headerValues = Object.values(newBlock.getBlockchainHeaders().toObject())
  logger.debug(inspect(headerValues, {depth: 3}))
  // $FlowFixMe
  const headerValuesWithLengthGtZero = headerValues.filter(headersList => headersList.length > 0)
  logger.debug(inspect(headerValuesWithLengthGtZero, {depth: 3}))
  // logger.info(GENESIS_DATA.childBlockchainCount)
  return headerValuesWithLengthGtZero.length === GENESIS_DATA.childBlockchainCount
}

function ifMoreThanOneHeaderPerBlockchainAreTheyOrdered (newBlock: BcBlock): bool {
  logger.debug('ifMoreThanOneHeaderPerBlockchainAreTheyOrdered validation running')
  const headersMap = newBlock.getBlockchainHeaders()

  // gather true/false for each chain signalling if either there is only one header
  // (most common case) or headers maintain ordering
  const chainsConditions = Object.keys(headersMap.toObject()).map(listName => {
    const getMethodName = `get${listName[0].toUpperCase()}${listName.slice(1)}`
    const chainHeaders = headersMap[getMethodName]()
    if (chainHeaders.length === 1) {
      logger.debug(`ifMoreThanOneHeaderPerBlockchainAreTheyOrdered ${listName} single and valid`)
      return true
    }

    // return true if left height < right height condition is valid
    // for all pairs ([[a, b], [b, c], [c, d]]) of chain headers ([a, b, c, d])
    // (in other words if ordering is maintained)
    // TODO
    const orderingCorrect = all(
      equals(true),
      aperture(2, chainHeaders).map(([a, b]) => a.getHeight() < b.getHeight())
    )
    logger.debug(`ifMoreThanOneHeaderPerBlockchainAreTheyOrdered ${listName} multiple and valid: ${orderingCorrect.toString()}`)
    if (!orderingCorrect) {
      logger.debug(`ifMoreThanOneHeaderPerBlockchainAreTheyOrdered ${inspect(headersMap.toObject())}`)
    }
    return orderingCorrect
  })

  // check if all chain conditions are true
  logger.debug(`ifMoreThanOneHeaderPerBlockchainAreTheyOrdered all chain conditions: ${inspect(chainsConditions)}`)
  return all(equals(true), chainsConditions)
}

function isChainRootCorrectlyCalculated (newBlock: BcBlock): bool {
  logger.debug('isChainRootCorrectlyCalculated validation running')
  const receivedChainRoot = newBlock.getChainRoot()

  const expectedBlockHashes = getChildrenBlocksHashes(blockchainMapToList(newBlock.getBlockchainHeaders()))
  const expectedChainRoot = blake2bl(getChildrenRootHash(expectedBlockHashes).toString())
  return receivedChainRoot === expectedChainRoot
}

function isFieldLengthBounded (newBlock: BcBlock): bool {
  logger.debug('isFieldLengthBounded validation running')
  return Object.keys(newBlock.toObject()).reduce((all, k) => {
    if (all[k] !== undefined && all[k].length > 128) {
      all = false
    }
    return all
  }, true)
}

function areDarkFibersValid (newBlock: BcBlock): bool {
  logger.debug('areDarkFibersValid validation running')
  const newBlockTimestampMs = newBlock.getTimestamp() * 1000
  const blockchainHeadersList = blockchainMapToList(newBlock.getBlockchainHeaders())
  const dfBoundHeadersChecks = blockchainHeadersList.map(header => {
    // e.g. NEO 1000 (rovered ts)  <=    1400 (mined time) -   300 (dfBound for NEO)
    return header.getTimestamp() <= newBlockTimestampMs - DF_CONFIG[header.getBlockchain()].dfBound * 1000
  })
  logger.debug(`dfBoundHeadersChecks: ${inspect(dfBoundHeadersChecks)}`)

  const dfVoidHeadersChecks = blockchainHeadersList.map(header => {
    const { dfVoid } = DF_CONFIG[header.getBlockchain()]
    return dfVoid === 0 || newBlockTimestampMs < header.getTimestamp() + dfVoid * 1000
  })
  logger.debug(`dfVoidHeadersChecks: ${inspect(dfVoidHeadersChecks)}`)
  return all(equals(true), dfBoundHeadersChecks) && all(equals(true), dfVoidHeadersChecks)
}

function isMerkleRootCorrectlyCalculated (newBlock: BcBlock): bool {
  logger.debug('isMerkleRootCorrectlyCalculated validation running')
  const receivedMerkleRoot = newBlock.getMerkleRoot()

  const blockHashes = getChildrenBlocksHashes(blockchainMapToList(newBlock.getBlockchainHeaders()))
  const expectedMerkleRoot = createMerkleRoot(concatAll([
    blockHashes,
    newBlock.getTxsList(),
    [
      newBlock.getDifficulty(),
      newBlock.getMiner(),
      newBlock.getHeight(),
      newBlock.getVersion(),
      newBlock.getSchemaVersion(),
      newBlock.getNrgGrant(),
      GENESIS_DATA.blockchainFingerprintsRoot
    ]
  ]))

  return receivedMerkleRoot === expectedMerkleRoot
}

function isDistanceAboveDifficulty (newBlock: BcBlock): bool {
  logger.debug('isDistanceCorrectlyCalculated validation running')
  const receivedDistance = newBlock.getDistance()
  const recievedDifficulty = newBlock.getDifficulty() // !! NOTE: This is the difficulty for THIS block and not for the parent.
	logger.debug('recievedDistance ' + receivedDistance)
	logger.debug('recievedDifficulty ' + recievedDifficulty)

  return new BN(receivedDistance, 16).gt(new BN(recievedDifficulty, 16))
}

function isDistanceCorrectlyCalculated (newBlock: BcBlock): bool {
  logger.debug('isDistanceCorrectlyCalculated validation running')
  const receivedDistance = newBlock.getDistance()

  const expectedWork = prepareWork(newBlock.getPreviousHash(), newBlock.getBlockchainHeaders())
  const expectedDistance = distance(
    expectedWork,
    blake2bl(
      newBlock.getMiner() +
      newBlock.getMerkleRoot() +
      blake2bl(newBlock.getNonce()) +
      newBlock.getTimestamp()
    )
  ).toString()
  return receivedDistance === expectedDistance
}

export function blockchainHeadersAreChain (childHeaderList: BlockchainHeader[]|Block[], parentHeaderList: BlockchainHeader[]|Block[], block: BcBlock) {
  const firstChildHeader = head(childHeaderList)
  const lastParentHeader = last(parentHeaderList)

  // check if both parent and child have at least one header
  if (!firstChildHeader || !lastParentHeader) {
    const nonEmpty = firstChildHeader || lastParentHeader
    if (nonEmpty) {
      logger.warn(`first child header or last parent header were empty for chain ${nonEmpty.getBlockchain()}`)
    } else {
      logger.warn(`both first child header and last parent header were missing`)
    }
    return false
  }

  // check if either the header is the same one or first child header is actual child of last parent header
  let check = firstChildHeader.getPreviousHash() === lastParentHeader.getHash() ||
    firstChildHeader.getHash() === lastParentHeader.getHash()

  if (!check) {
    logger.debug(`chain: "${firstChildHeader.getBlockchain()}" first child header ${inspect(firstChildHeader.toObject())} is not a child of last parent header ${inspect(lastParentHeader.toObject())}`)
    // return check // Disabled until AT
  }

  // if more than one child header check if child headers form a chain
  // if (childHeaderList.length > 1) {
  //  check = aperture(2, childHeaderList).reduce((result, [a, b]) => a.getHash() === b.getPreviousHash() && result, true)

  //  if (!check) {
  //    logger.info(`child headers do not form a chain`)
  //    // return check // Disabled until AT
  //  }
  // }

  // if more than one parent header check if parent headers form a chain
  if (parentHeaderList.length > 1) {
    check = aperture(2, parentHeaderList).reduce((result, [a, b]) => a.getHash() === b.getPreviousHash() && result, true)

    if (!check) {
      logger.debug(`parent headers do not form a chain`)
      // return check // Disabled until AT
    }
  }

  return true
}

export function validateRoveredSequences (blocks: BcBlock[]): boolean {
  const sortedBlocks = sort((a, b) => b.getHeight() - a.getHeight(), blocks)
  const checks = aperture(2, sortedBlocks).map(([child, parent]) => {
    return parent.getHeight() === GENESIS_DATA.height || validateChildHeadersSequence(child, parent)
  })

  logger.debug(`validateRoveredSequences: ${inspect(checks)}`)

  return all(equals(true), flatten(checks))
}

export function validateSequenceDifficulty (previousBlock: BcBlock, newBlock: BcBlock): boolean {
  logger.info('comparing difficulties prevBlock: ' + previousBlock.getHeight() + ' with next block ' + newBlock.getHeight())
  const newBlockCount = getNewBlockCount(previousBlock.getBlockchainHeaders(), newBlock.getBlockchainHeaders())
  const preExpDiff = getDiff(newBlock.getTimestamp(), previousBlock.getTimestamp(), previousBlock.getDifficulty(), MINIMAL_DIFFICULTY, newBlockCount, getNewestHeader(newBlock))
  const finalDifficulty = getExpFactorDiff(preExpDiff, previousBlock.getHeight()).toString()

  logger.info('comparing difficulties prevBlock: ' + previousBlock.getHeight() + ' (' +  previousBlock.getDifficulty() + ') with next block ' + newBlock.getHeight() + ' (' + newBlock.getDifficulty() + ') ')
  logger.info('difficulty should be ' + finalDifficulty)

  return newBlock.getDifficulty() === finalDifficulty
}

function validateChildHeadersSequence (childBlock, parentBlock): bool[] {
  const childBlockchainHeaders = childBlock.getBlockchainHeaders()
  const parentBlockchainHeaders = parentBlock.getBlockchainHeaders()
  // TODO this should be a map over all members of BlockchainHeaders instance to prevent error after adding another chain to Collider
  return [
    blockchainHeadersAreChain(childBlockchainHeaders.getBtcList(), parentBlockchainHeaders.getBtcList()),
    blockchainHeadersAreChain(childBlockchainHeaders.getEthList(), parentBlockchainHeaders.getEthList()),
    blockchainHeadersAreChain(childBlockchainHeaders.getLskList(), parentBlockchainHeaders.getLskList()),
    blockchainHeadersAreChain(childBlockchainHeaders.getNeoList(), parentBlockchainHeaders.getNeoList()),
    blockchainHeadersAreChain(childBlockchainHeaders.getWavList(), parentBlockchainHeaders.getWavList())
  ]
}

export function validateBlockSequence (blocks: BcBlock[]): bool {
  // if any of the submissions are undefined reject the sequence
  if (reject(identity, blocks).length > 0) {
    logger.debug('undefined members in set')
    return false
  }
  // BC: 10 > BC: 9 > BC: 8 ...
  const sortedBlocks = sort((a, b) => b.getHeight() - a.getHeight(), blocks)
  const sortedBlocksTopDown = sort((a, b) => a.getHeight() - b.getHeight(), blocks)

  logger.debug(`validateBlockSequence sorted blocks ${sortedBlocks.map(b => b.getHeight()).toString()}`)
  // validate that Bc blocks are all in the same chain
  const validPairs = aperture(2, sortedBlocks).map(([a, b]) => {
    return a.getPreviousHash() === b.getHash()
  })

  logger.debug(`validateBlockSequence sorted blocks ${inspect(aperture(2, sortedBlocks.map(b => b.getHeight())))}`)
  if (!all(equals(true), validPairs)) {
    logger.debug(`validateBlockSequence validPairs: ${validPairs}`)
    return false
  }

  /* eslint-disable */
  const validDifficulties = aperture(2, sortedBlocksTopDown).map(([a, b]) => {
    return validateSequenceDifficulty(a, b)
  })

  logger.debug(`validateBlockSequence sorted blocks ${inspect(aperture(2, sortedBlocks.map(b => b.getHeight())))}`)
  if (!all(equals(true), validDifficulties)) {
    logger.debug('validateBlockSequence invalid Difficulties')
    //return false
  }
  // validate that highest header from each blockchain list from each block maintains ordering
  // [[BC10, BC9], [BC9, BC8]]
  const pairs = aperture(2, sortedBlocks)
  const heights = pairs.map((a) => {
    logger.debug(a)
    return [a[0].getHeight(), a[1].getHeight()]
  })
  logger.debug('pairs printed after this --> ' + JSON.stringify(heights, null, 2))
  // now create:
  // [[btcOrdered, ethOrdered, lskOrdered, neoOrdered, wavOrdered], [btcOrderder, ethOrdered, lskOrdered, neoOrdered, wavOrdered]]
  //                                e.g. BC10, BC9
  const validPairSubchains = pairs.map(([child, parent]) => {
    return parent.getHeight() === GENESIS_DATA.height || validateChildHeadersSequence(child, parent)
  })
  // flatten => [btc10_9Ordered, eth10_9Ordered, lsk10_9Ordered, neo10_9Ordered, wav10_9Ordered, btc9_8Orderded, eth9_8Ordered, lsk9_8Ordered, neo9_8Ordered, wav9_8Ordered]
  logger.debug(`validateBlockSequence validPairSubchains ${inspect(validPairSubchains)}`)
  if (!all(equals(true), flatten(validPairSubchains))) {
    logger.debug('failed test of rovers')
    // return false // TODO: AT -> is enabled in validation
  }

  return true
}

export function childrenHighestBlock (block: BcBlock): number {

  const highest = Object.values(block.getBlockchainHeaders().toObject()).reduce((all, headers) => {
		const top = headers.sort((a, b) => {
			if(a.height > b.height) {
				return 1
			}
			if(a.height < b.height) {
				return -1
			}
			return 0
	  }).pop()
		all[top.blockchain] = top
	  return all
	}, {})

	return Object.values(highest)
}

export function childrenHeightSum (block: BcBlock): number {
  return sum(
      childrenHighestBlock(block).map((header) => Number(header.height))
  )
}
