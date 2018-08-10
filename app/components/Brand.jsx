/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import React, { Component } from 'react'


const STYLE = {
  height: '35px',
  width: '35px',
  padding: 0
}

const FIELD_STYLE = {
  marginLeft: '10px',
  color: 'black'
}

const VERSION = require('../../.version.json')

const linkGithub = `https://github.com/blockcollider/bcnode/tree/0.7.7`

export class Brand extends Component<*> {
  render () {
    return (
      <div className='navbar-brand'>
        <a href='https://blockcollider.org'>
          <img src='/img/bc-black.png' style={STYLE} />
        </a>
        <a href='/#/' style={FIELD_STYLE}>
          BLOCK COLLIDER 
        </a>
        <a style={FIELD_STYLE} href={linkGithub}>
          0.7.6/PREINSTALL
        </a>

        {this.props.children}
      </div>
    )
  }
}

export default Brand
