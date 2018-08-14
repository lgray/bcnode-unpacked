/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import React, { Component } from 'react'

import {
  Circle,
  Map,
  Polyline,
  TileLayer
} from 'react-leaflet'

export class PeersMap extends Component<*> {
  render () {
    const zoom = 3

    const style = {
      marginLeft: -83,
      paddingLeft: 0,
      height: this.props.size.height,
      width: this.props.size.width
    }

    const me = this.props.peer
    const posMe = (me && [
      me.location.latitude,
      me.location.longitude
    ]) || [40.730610, -73.935242]

    const peerPoints = this.props.peers.map((peer, idx) => {
      const posPeer = [
        peer.location.latitude,
        peer.location.longitude
      ]

      return (
        <Circle key={idx} center={posPeer} fillColor='red' radius={300} />
      )
    })

    const peerLines = this.props.peers.map((peer, idx) => {
      const posPeer = [
        peer.location.latitude,
        peer.location.longitude
      ]

      return (
        <Polyline key={idx} color='lime' positions={[posMe, posPeer]} />
      )
    })

    return (
      <Map
        animate={false}
        center={posMe}
        zoom={zoom}
        style={style}
        minZoom={zoom - 1}
      >
        <TileLayer
          url='https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png'
        />

        <Circle center={posMe} fillColor='red' radius={300} />

        { peerPoints }
        { peerLines }
      </Map>
    )
  }
}

export default PeersMap
