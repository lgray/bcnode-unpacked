/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
import { ManagedPeerBook } from './book'

const debug = require('debug')('bcnode:bundle')
const libp2p = require('libp2p')
const KadDHT = require('libp2p-kad-dht')
const Mplex = require('libp2p-mplex')
const MDNS = require('libp2p-mdns')
const SECIO = require('libp2p-secio')
const SPDY = require('libp2p-spdy')
const PeerInfo = require('peer-info')
const TCP = require('libp2p-tcp')
const WebSockets = require('libp2p-websockets')

export class Bundle extends libp2p {
  peerInfo: ManagedPeerBook
  peerBook: ?ManagedPeerBook
  options: Object
  _discoveryEnabled: bool

  constructor (peerInfo: PeerInfo, peerBook: ManagedPeerBook, opts: Object) {
    /* eslint-disable */
    /* eslint-enable */
    const signaling = opts.signaling
    const broadcastInterval = (270 + Math.floor(Math.random() * 45) - 30) * 1000
    const modules = {
      transport: [
        new TCP(),
        signaling,
        new WebSockets()
      ],
      connection: {
        muxer: [
          Mplex,
          SPDY
        ],
        crypto: [ SECIO ]
      },
      discovery: [
        new MDNS(peerInfo, { interval: broadcastInterval, broadcast: true }),
        signaling.discovery
      ],
      DHT: KadDHT
    }

    super(modules, peerInfo, peerBook, opts)
    this._discoveryEnabled = true
  }

  get discoveryEnabled (): bool {
    return this._discoveryEnabled
  }

  /**
   * Start discovery services
   *
   * @returns {Promise<boolean>}
   */
  startDiscovery (): Promise<bool> {
    debug('startDiscovery()')

    if (this.discoveryEnabled) {
      debug('startDiscovery() - Discovery already started')
      return Promise.resolve(false)
    }

    const methods = this.modules.discovery || []
    methods.forEach((discovery) => {
      const tag = discovery.tag
      debug('startDiscovery() - starting', tag)
      discovery.start((res) => {
        debug('startDiscovery() - Discovery started', arguments)
      })
    })

    this._discoveryEnabled = true
    return Promise.resolve(true)
  }

  /**
   * Stop discovery services
   *
   * @returns {Promise<boolean>}
   */
  stopDiscovery (): Promise<bool> {
    debug('stopDiscovery()')

    if (!this.discoveryEnabled) {
      debug('startDiscovery() - Discovery already stopped')
      return Promise.resolve(false)
    }

    const methods = this.modules.discovery || []
    methods.forEach((discovery) => {
      const tag = discovery.tag
      debug('stopDiscovery() - stopping', tag)
      discovery.stop((res) => {
        debug('stopDiscovery() - Discovery stopped', arguments)
      })
    })

    this._discoveryEnabled = false
    return Promise.resolve(true)
  }
}

export default Bundle
