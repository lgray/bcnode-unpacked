/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Bundle } from './../bundle'

const debug = require('debug')('bcnode:p2p:manager')
const { mergeDeepRight } = require('ramda')
const PeerInfo = require('peer-info')
const pull = require('pull-stream')

const { ManagedPeerBook } = require('../book/book')
// const { toObject } = require('../../helper/debug')
const { Peer } = require('../peer')
const { PeerNode } = require('../node')
const { registerProtocols } = require('../protocol')
const logging = require('../../logger')
const { config } = require('../../config')

const { PROTOCOL_PREFIX } = require('../protocol/version')

const BC_P2P_PASSIVE = !!process.env.BC_P2P_PASSIVE
export const QUORUM_SIZE: number = config.p2p.quorum.size

export const DATETIME_STARTED_AT = Date.now()

const { PEER_QUORUM_SIZE } = require('../quorum')

export class PeerManager {
  _logger: Object // eslint-disable-line no-undef
  _statsInterval: IntervalID // eslint-disable-line no-undef
  _peerBook: ManagedPeerBook // eslint-disable-line no-undef
  _peerNotes: Object // eslint-disable-line no-undef
  _peerBookConnected: ManagedPeerBook // eslint-disable-line no-undef
  _peerBookDiscovered: ManagedPeerBook // eslint-disable-line no-undef
  _peerBookSchedule: Object // eslint-disable-line no-undef
  _peerNode: PeerNode // eslint-disable-line no-undef
  _lastQuorumSync: ?Date
  _quorumSyncing: boolean
  _peerBookStale: Object

  constructor (node: PeerNode) {
    debug('constructor()')
    this._logger = logging.getLogger(__filename)
    this._peerNode = node
    this._peerNotes = {}
    this._peerBookSchedule = {}
    this._peerBook = new ManagedPeerBook(this, 'main')
    this._peerBookConnected = new ManagedPeerBook(this, 'connected')
    this._peerBookDiscovered = new ManagedPeerBook(this, 'discovered')
    this._peerBookStale = {}
    this._lastQuorumSync = null
    this._quorumSyncing = false

    this._statsInterval = setInterval(() => {
      const stats = this.peerNode.bundle && this.peerNode.bundle.stats
      const peers = (stats && stats.peers()) || []
      if (peers.length < 1) {
        return
      }

      const data = peers.reduce((acc, el) => {
        const peerStats = stats.forPeer(el)
        if (peerStats) {
          acc[el] = {
            snapshot: {
              dataReceived: parseInt(peerStats.snapshot.dataReceived, 10),
              dataSent: parseInt(peerStats.snapshot.dataSent, 10)
            },
            avg: peerStats.movingAverages
          }
        }
        return acc
      }, {})

      if (this.engine.server) {
        this.engine.server._wsBroadcast({
          type: 'peer.stats',
          data
        })
      }
    }, 30 * 1000)

    // this.engine.pubsub.subscribe('update.block.latest', '<engine>', (block) => {
    //  self.engine.restartMiner(block)
    // })
    // this.pubsub.publish('block.mined', { type: 'block.mined', data: newBlockObj })
  }

  get bundle (): Bundle {
    return this._peerNode.bundle
  }

  get engine (): Object {
    return this.peerNode._engine
  }

  get peerBook (): ManagedPeerBook {
    return this._peerBook
  }

  get peerBookConnected (): ManagedPeerBook {
    return this._peerBookConnected
  }

  get peerBookDiscovered (): ManagedPeerBook {
    return this._peerBookDiscovered
  }

  get peerNode (): PeerNode {
    return this._peerNode
  }

  get hasQuorum (): bool {
    return this._peerBookConnected.getPeersCount() >= QUORUM_SIZE
  }

  putPeerEvent (peerId: string, eventId: Number): void {
  // logs peer event
  // peerId string
  // eventId number // the event type which occured
  // 1 - peer disconnected
  // 2 - peer slow
  // 3 - peer sent invalid data
    if (peerId === undefined) { return false }
    if (this._peerNotes[peerId] === undefined) {
      this._peerNotes[peerId] = {}
    }
    if (this._peerNotes[peerId][eventId] === undefined) {
      this._peerNotes[peerId][eventId] = 1
    } else {
      this._peerNotes[peerId][eventId]++
    }
  }

  getPeerEvent (peerId: string, eventId: Number): Number {
    if (peerId === undefined) { return false }
    if (this._peerNotes[peerId] === undefined) {
      this._peerNotes[peerId] = {}
    }
    if (this._peerNotes[peerId][eventId] === undefined) {
      this._peerNotes[peerId][eventId] = 0
    }
    return this._peerNotes[peerId][eventId]
  }

  removePeer (peer: Object): void {
    this.bundle.hangup(peer, (err) => {
      if (err) {
        this._logger.warn('unable to hangup  with peer')
        this._logger.error(err)
      }

      if (this.peerBookConnected.has(peer)) {
        this.peerBookConnected.remove(peer)
      }

      if (this.peerBookDiscovered.has(peer)) {
        this.peerBookDiscovered.remove(peer)
      }

      if (peer.isConnected()) {
        peer.disconnect()
      }
    })
  }

  checkPeerSchedule (): void {
    const now = Math.floor(Date.now() * 0.001)
    const keys = Object.keys(this._peerBookSchedule)
    if (keys.length < 1) {
      return false
    }
    const expiredPeers = keys.filter((k) => {
      if (now >= k) {
        return k
      }
    })

    const expiredCount = expiredPeers.reduce((all, key) => {
      this._peerBookSchedule[key].map((peer, i) => {
        this.removePeer(peer)
        all++
      })
      delete this._peerBookSchedule[key]
      return all
    }, 0)
    this._logger.info('expired peers: ' + expiredCount)
    return true
  }

  createPeer (peerId: PeerInfo): Peer {
    return new Peer(this.bundle, peerId)
  }

  isQuorumSynced (): boolean {
    // TODO: Fix
    return this._quorumSyncing === false
    // return false
  }

  onPeerDiscovery (peer: PeerInfo): Promise<bool> {
    const peerId = peer.id.toB58String()
    debug('Event - peer:discovery', peerId)

    if (!this.peerBookDiscovered.has(peer)) {
      // TODO: Meta info ???
      this.peerBookDiscovered.put(peer)
      debug(`Adding newly discovered peer '${peerId}' to discoveredPeerBook, count: ${this.peerBookDiscovered.getPeersCount()}`)
    } else {
      debug(`Discovered peer ${peerId} already in discoveredPeerBook`)
    }

    if (!BC_P2P_PASSIVE && !this.peerBookConnected.has(peer) && (this.peerBookConnected.getPeersCount() < QUORUM_SIZE)) {
      debug(`Dialing newly discovered peer ${peerId}`)
      return new Promise((resolve, reject) => {
        this.bundle.dial(peer, (err) => {
          if (err) {
            const errMsg = `Dialing discovered peer '${peerId}' failed, reason: '${err.message}' - peer will be redialed`
            debug(errMsg)
            this._logger.debug(errMsg)

            // Throwing error is not needed, peer will be dialed once circuit is enabled
            if (this.peerBookDiscovered.has(peer)) {
              this.peerBookDiscovered.remove(peer)
            }

            return reject(err)
          }

          this._logger.debug(`Discovered peer successfully dialed ${peerId}`)
          resolve(true)
        })
      })
    }

    return Promise.resolve(false)
  }

  onPeerConnect (peer: PeerInfo): Promise<bool> {
    const peerId = peer.id.toB58String()
    debug('Event - peer:connect', peerId)

    const count = this.peerBookConnected.getPeersCount()

    const disconnectPeer = () => {
      if (this.peerBookConnected.has(peer)) {
        this.peerBookConnected.remove(peer)
      }

      if (this.peerBookDiscovered.has(peer)) {
        this.peerBookDiscovered.remove(peer)
      }

      if (peer.isConnected()) {
        peer.disconnect()
      }
    }

    if (this.peerBookConnected.has(peer)) {
      debug(`Peer '${peerId}', already in connectedPeerBook`)
      return Promise.resolve(false)
    }

    // Check if QUORUM_SIZE is reached
    if (this.peerBookConnected.getPeersCount() > QUORUM_SIZE) {
      debug(`Peer '${peerId}', quorum already reached`)

      disconnectPeer()
      return Promise.resolve(false)
    }

    debug(`Connected new peer '${peerId}', adding to connectedPeerBook, count: ${this.peerBookConnected.getPeersCount()}`)

    if (!this._lastQuorumSync && this.peerBookConnected.getPeersCount() >= PEER_QUORUM_SIZE) {
      this._quorumSyncing = true
      this._lastQuorumSync = new Date()

      // this.peerNode.triggerBlockSync()
    }

    if (count > 0 && count > Math.floor(QUORUM_SIZE / 2)) {
      const now = Math.floor(Date.now() * 0.001)
      const bound = Math.floor(Math.random() * 600) - 180
      const l = now + bound

      if (this._peerBookSchedule[l] === undefined) {
        this._peerBookSchedule[l] = []
      }
      this._peerBookSchedule[l].push(peer)
    }

    this.peerBookConnected.put(peer)

    return this._checkPeerStatus(peer)
      .then((peer) => {
        return this.createPeer(peer)
          .getLatestHeader()
          .then((header) => {
            return Promise.resolve(header)
          })
          .catch((err) => {
            return Promise.reject(err)
          })
      })
      .catch((err) => {
        debug(`Unable to check peer status`, err)
        disconnectPeer()
      })
  }

  onPeerDisconnect (peer: PeerInfo): Promise<bool> {
    const peerId = peer.id.toB58String()
    debug('Event - peer:disconnect', peerId)

    if (this.peerBookConnected.has(peer)) {
      this.peerBookConnected.remove(peer)
      this.engine._emitter.emit('peerDisconnected', { peer })

      debug(`Peer disconnected '${peerId}', removing from connectedPeerBook, count: ${this.peerBookConnected.getPeersCount()}`)
    } else {
      debug(`Peer '${peerId}', already removed from connectedPeerBook`)
    }

    if (this._peerBookDiscovered.has(peer)) {
      this._peerBookDiscovered.remove(peer)
    }

    return Promise.resolve(true)
  }

  registerProtocols (bundle: Bundle) {
    registerProtocols(this, bundle)
  }

  _checkPeerStatus (peer: PeerInfo) {
    const peerId = peer.id.toB58String()
    debug('Checking peer status', peerId)

    const disconnectPeer = () => {
      if (this.peerBookConnected.has(peer)) {
        this.peerBookConnected.remove(peer)
      }

      if (this.peerBookDiscovered.has(peer)) {
        this.peerBookDiscovered.remove(peer)
      }

      if (peer.isConnected()) {
        peer.disconnect()
      }
    }

    const meta = {
      ts: {
        connectedAt: Date.now()
      }
    }

    debug('Dialing /status protocol', peerId)
    return new Promise((resolve, reject) => {
      const expireRequest = setTimeout(() => {
        return reject(new Error('peer failed health check'))
      }, 5000)
      this.bundle.dialProtocol(peer, `${PROTOCOL_PREFIX}/status`, (err, conn) => {
        const peerId = peer.id.toB58String()
        clearTimeout(expireRequest)

        if (err) {
          debug('Error dialing /status protocol', peerId, err)
          this._logger.error('Error dialing /status protocol', peerId)
          // FIXME: Propagate corectly
          // throw err
          disconnectPeer()
          return reject(err)
        }

        debug('Pulling latest /status', peerId)
        pull(
          conn,
          pull.collect((err, wireData) => {
            if (err) {
              debug('Error pulling latest /status', peerId, err)

              // FIXME: Propagate corectly
              // throw err

              return reject(err)
            }

            debug('Getting latest peer info', peerId)
            conn.getPeerInfo((err, peerInfo) => {
              if (err) {
                debug('Error getting latest peer info', peerId, err)

                // FIXME: Propagate corectly
                // throw err

                return reject(err)
              }

              if (this.peerBookConnected.has(peer)) {
                debug('Updating peer with meta/status', peerId)
                const existingPeer = this.peerBookConnected.get(peer)

                const status = JSON.parse(wireData[0])
                existingPeer.meta = mergeDeepRight(meta, status)
              } else {
                debug('Unable to update peer meta/status, not in peerBookConnected', peerId)
              }

              this.engine._emitter.emit('peerConnected', { peer })
              return resolve(peer)
            })
          })
        )
      })
    })
  }
}
