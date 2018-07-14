/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
import type Logger from 'winston'
const RocksDb = require('rocksdb')
const BN = require('bn.js')
const debug = require('debug')('bcnode:persistence:rocksdb')
const { BcBlock } = require('../protos/core_pb')
const { serialize, deserialize } = require('./codec')
const { getLogger } = require('../logger')

/**
 * Unified persistence interface
 */
export default class PersistenceRocksDb {
  _db: RocksDb // eslint-disable-line no-undef
  _isOpen: boolean // eslint-disable-line no-undef
  _logger: Logger

  constructor (location: string = '_data') {
    this._db = new RocksDb(location)
    this._isOpen = false
    this._logger = getLogger(__dirname)
  }

  get db (): RocksDb {
    return this._db
  }

  get isOpen (): boolean {
    return this._isOpen
  }

  /**
   * Open database
   * @param opts
   */
  open (opts: Object = {}): Promise<*> {
    return new Promise((resolve, reject) => {
      this.db.open(opts, err => {
        if (err) {
          this._isOpen = false
          return reject(err)
        }

        this._isOpen = true
        return resolve(true)
      })
    })
  }

  /**
   * Close database
   */
  close (): Promise<*> {
    return new Promise((resolve, reject) => {
      this.db.close(err => {
        if (err) {
          return reject(err)
        }

        resolve(true)
      })
    })
  }

  /**
   * Put data into database
   * @param key
   * @param value
   * @param opts
   */
  put (key: string, value: any, opts: Object = {}): Promise<*> {
    debug('put()', key)

    let serialized
    try {
      serialized = serialize(value)
    } catch (e) {
      this._logger.warn(`Could not serialize key: ${key}, value: ${value.toObject()}`)
      throw e
    }
    return new Promise((resolve, reject) => {
      this.db.put(key, serialized, opts, err => {
        if (err) {
          return reject(err)
        }

        return resolve(true)
      })
    })
  }

  /**
   * Get data from database
   * @param key
   * @param opts
   */
  get (key: string, opts: Object = { asBuffer: true }): Promise<Object> {
    debug('get()', key)

    if (Array.isArray(key)) {
      const msg = 'PersistenceRocksDb.get() for bulk gets is deprecated, use PersistenceRocksDb.getBulk() instead'
      this._logger.error(msg)
      return Promise.reject(new Error(msg))
    }

    return new Promise((resolve, reject) => {
      this.db.get(key, opts, (err, value) => {
        if (err) {
          return reject(new Error(`${err.message} - ${key}`))
        }
        try {
          const deserialized = deserialize(value)
          return resolve(deserialized)
        } catch (e) {
          return reject(new Error(`Could not deserialize value`))
        }
      })
    })
  }

  getBulk (key: string[], opts: Object = { asBuffer: true }): Promise<Array<Object>> {
    const promises = key.map((k) => {
      return this.get(k)
    })

    return Promise.all(promises.map((p) => p.catch(e => null)))
      .then((results) => {
        return Promise.all(results.filter(a => a !== null))
      })
  }

  putBulk (key: Array<*>, opts: Object = { asBuffer: true }): Promise<Array<Object>> {
    const valid = key.filter((k) => {
      if (k.length === 2) {
        return k
      }
    })
    const promises = valid.map((k) => {
      return this.put(k[0], k[1])
    })
    return Promise.all(promises.map((p) => p.catch(e => null)))
      .then((results) => {
        return Promise.all(results.filter(a => a !== null))
      })
  }

  /**
   * Sorts the given headers from lowest to highest
   * @param headers
   */
  sortChildHeaders (headers: Object[]): Object[] {
    return headers.sort((a, b) => {
      if (new BN(a.getHeight()).gt(new BN(b.getHeight())) === true) {
        return 1
      }
      if (new BN(a.getHeight()).lt(new BN(b.getHeight())) === true) {
        return -1
      }
      return 0
    })
  }
  /**
   * Write the child headers contained within a BC Block to disk
   * @param block BcBlock containing
   */
  async putChildHeaders (block: BcBlock, opts: Object = {
    btc: true,
    neo: true,
    lsk: true,
    eth: true,
    wav: true
  }): Promise<*> {
    const headers = block.getBlockchainHeaders()
    return Promise.all([]
      .concat(this.sortChildHeaders(headers.getBtcList())
        .map((b) => {
          if (opts.btc) {
            return async () => {
              const latest = await this.get('btc.block.latest')
              return this.get('btc.block.' + b.getHeight() - 1)
                .then((res) => {
                  if (res.getHash() === b.getPreviousHash() &&
                    res.getHash() === latest.getHash()) {
                    return Promise.all([
                      this.put('btc.block.latest', b),
                      this.put('btc.block.' + b.getHeight(), b)
                    ])
                  }
                  return this.put('btc.block.' + b.getHeight(), b)
                })
                .catch((err) => {
                  this._logger.debug(err)
                  return this.put('btc.block.' + b.getHeight(), b)
                })
            }
          }
          return Promise.resolve(true)
        }))
      .concat(this.sortChildHeaders(headers.getEthList())
        .map((b) => {
          if (opts.eth) {
            return async () => {
              const latest = await this.get('eth.block.latest')
              return this.get('eth.block.' + b.getHeight() - 1)
                .then((res) => {
                  if (res.getHash() === b.getPreviousHash() &&
                    res.getHash() === latest.getHash()) {
                    return Promise.all([
                      this.put('eth.block.latest', b),
                      this.put('eth.block.' + b.getHeight(), b)
                    ])
                  }
                  return this.put('eth.block.' + b.getHeight(), b)
                })
                .catch((err) => {
                  this._logger.debug(err)
                  return this.put('eth.block.' + b.getHeight(), b)
                })
            }
          }
          return Promise.resolve(true)
        }))
      .concat(this.sortChildHeaders(headers.getWavList())
        .map((b) => {
          if (opts.wav) {
            return async () => {
              const latest = await this.get('wav.block.latest')
              return this.get('wav.block.' + b.getHeight() - 1)
                .then((res) => {
                  if (res.getHash() === b.getPreviousHash() &&
                    res.getHash() === latest.getHash()) {
                    return Promise.all([
                      this.put('wav.block.latest', b),
                      this.put('wav.block.' + b.getHeight(), b)
                    ])
                  }
                  return this.put('wav.block.' + b.getHeight(), b)
                })
                .catch((err) => {
                  this._logger.debug(err)
                  return this.put('wav.block.' + b.getHeight(), b)
                })
            }
          }
          return Promise.resolve(true)
        }))
      .concat(this.sortChildHeaders(headers.getNeoList())
        .map((b) => {
          if (opts.neo) {
            return async () => {
              const latest = await this.get('neo.block.latest')
              return this.get('neo.block.' + b.getHeight() - 1)
                .then((res) => {
                  if (res.getHash() === b.getPreviousHash() &&
                    res.getHash() === latest.getHash()) {
                    return Promise.all([
                      this.put('neo.block.latest', b),
                      this.put('neo.block.' + b.getHeight(), b)
                    ])
                  }
                  return this.put('neo.block.' + b.getHeight(), b)
                })
                .catch((err) => {
                  this._logger.warn(err)
                  return this.put('neo.block.' + b.getHeight(), b)
                })
            }
          }
          return Promise.resolve(true)
        }))
      .concat(this.sortChildHeaders(headers.getLskList())
        .map((b) => {
          if (opts.lsk) {
            return async () => {
              const latest = await this.get('lsk.block.latest')
              return this.get('lsk.block.' + b.getHeight() - 1)
                .then((res) => {
                  if (res.getHash() === b.getPreviousHash() &&
                    res.getHash() === latest.getHash()) {
                    return Promise.all([
                      this.put('lsk.block.latest', b),
                      this.put('lsk.block.' + b.getHeight(), b)
                    ])
                  }
                  return this.put('lsk.block.' + b.getHeight(), b)
                })
                .catch((err) => {
                  this._logger.debug(err)
                  return this.put('lsk.block.' + b.getHeight(), b)
                })
            }
          }
          return Promise.resolve(true)
        }))
    )
  }

  /**
   * Write pending values to perminent values
   * @param opts
   */
  putPending (blockchain: string = 'bc', opts: Object = { highWaterMark: 100000000, asBuffer: true }): Promise<?boolean> {
    return new Promise((resolve, reject) => {
      let highest = false
      const iter = this.db.iterator(opts)
      const cycle = () => {
        return iter.next((err, key) => {
          if (err) {
            return reject(err)
          } else if (key !== undefined && key.indexOf('pending.' + blockchain) > -1) {
            return this.get(key)
              .then((res) => {
                const stringKey = key.toString().replace('pending.', '')
                if (highest === false) {
                  highest = res
                } else if (res.getHeight() > highest.getHeight()) {
                  highest = res
                }
                return this.put(stringKey, res).then(cycle)
                  .catch((err) => {
                    return reject(err)
                  })
              })
              .catch((err) => {
                return reject(err)
              })
          }
          // set the last complete sync height
          if (highest !== false) {
            return this.put(blockchain + '.block.checkpoint', highest)
              .then(() => {
                return resolve(true)
              })
              .catch((err) => {
                return reject(err)
              })
          }
          return resolve(true)
        })
      }
      return cycle()
    })
  }

  /**
   * Delete data from database
   * @param key
   * @param opts
   */
  del (key: string, opts: Object = {}): Promise<*> {
    debug('del()', key)

    return new Promise((resolve, reject) => {
      this.db.del(key, opts, err => {
        if (err) {
          return reject(err)
        }

        resolve(true)
      })
    })
  }

  /**
   * Scan blocks to return balance of miner address
   * @param address
   * @param startBlock
   * @param endBlock
   */
  async scanBlockGrants (address: string, startBlock: number, endBlock: number): Object {
    const self = this
    const accountBalances = {
      confirmed: 0,
      unconfirmed: 0
    }
    for (let i = startBlock; i < endBlock; i++) {
      try {
        const block: Object = await self.get('bc.block.' + i)
        if (block !== undefined && block.getMiner() === address) {
          if (block.getNrgGrant() !== 1600000000) {
            block.setNrgGrant(1600000000) // Force BT Reward
          }
          if (endBlock - i > 99 && block.getNrgGrant() !== undefined) {
            accountBalances.confirmed += block.getNrgGrant()
          } else if (endBlock - i < 99 && block.getNrgGrant() !== undefined) {
            accountBalances.unconfirmed += block.getNrgGrant()
          }
        }
      } catch (err) {
        return err
      }
    }
    return accountBalances
  }

  /**
   * Get Balance of Address (Before Target)
   * @param address
   * @param opts
   */
  getBtAddressBalance (address: string, opts: Object = { asBuffer: true }): Promise<Object> {
    const self = this
    return new Promise((resolve, reject) => {
      if (address === undefined) {
        return reject(new Error(`no address provided`))
      }
      if (/^(0x){1}[0-9a-fA-F]{40}$/i.test(address) === false) {
        return reject(new Error(`malformed address`))
      }
      this.db.get('bc.block.latest', opts, (err, value) => {
        if (err) {
          return reject(new Error(`${err.message} --> local Block Collider ledger not found, sychronize machine with network`))
        }
        try {
          const latestBlock: BcBlock = deserialize(value)
          if (latestBlock !== undefined && latestBlock.getHeight() !== undefined) {
            const endBlock = latestBlock.getHeight()
            return resolve(self.scanBlockGrants(address, 1, Number(endBlock)))
          } else {
            return reject(new Error(`No blocks stored on disk`))
          }
        } catch (e) {
          return reject(new Error(`Could not deserialize value`))
        }
      })
    })
  }
}
