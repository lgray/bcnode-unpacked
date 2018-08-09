/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import Parser from 'html-react-parser'
import React, { Component } from 'react'

import moment from 'moment'

import { Ellipsis } from '../components'

const previous = []

const BlockLink = (props: Object) => {
  const block = props.block
  const linkProps = {
    href: `/#/block/${block.height}`,
    onClick: (e) => {
      e.preventDefault()
      props.onClick(block)
    },
    style: {
      color: 'black'
    }
  }

  if (props.style) {
    linkProps.style = props.style
  }

  return (
    <a {...linkProps}>{props.children}</a>
  )
}

const BlockColor = (block: Object) => {

  const next = {
    btcList: [],
    ethList: [],
    neoList: [],
    lskList: [],
    wavList: []
  }

  let old = next 

  if(previous.length > 0) {
    old = previous[previous.length - 1]
  }

  const btc = block.blockchainHeaders.btcList.reduce((all, b) => {
    if(old.btcList.indexOf(b.hash) > -1){
      all = all + 1 
    }
    next.btcList.push(b.hash)
    return all
  }, 0)
  const eth = block.blockchainHeaders.ethList.reduce((all, b) => {
    if(old.ethList.indexOf(b.hash) > -1){
      all = all + 1 
    }
    next.ethList.push(b.hash)
    return all
  }, 0)
  const neo = block.blockchainHeaders.neoList.reduce((all, b) => {
    if(old.neoList.indexOf(b.hash) > -1){
      all = all + 1 
    }
    next.neoList.push(b.hash)
    return all
  }, 0)
  const lsk = block.blockchainHeaders.lskList.reduce((all, b) => {
    if(old.lskList.indexOf(b.hash) > -1){
      all = all + 1 
    }
    next.lskList.push(b.hash)
    return all
  }, 0)
  const wav = block.blockchainHeaders.wavList.reduce((all, b) => {
    if(old.wavList.indexOf(b.hash) > -1){
      all = all + 1 
    }
    next.wavList.push(b.hash)
    return all
  }, 0)

  previous.push(next)

  const stack = []

  const btcBlock = '<div id="btccolor"></div>' 
  const ethBlock = '<div id="ethcolor"></div>' 
  const neoBlock = '<div id="neocolor"></div>' 
  const lskBlock = '<div id="lskcolor"></div>' 
  const wavBlock = '<div id="wavcolor"></div>' 

  if(btc < 1){ 
    stack.push(btcBlock) 
  } else {
    for(let i = 0;i<btc;i++){
       stack.push(btcBlock)
    }
  }
  if(eth < 1){ 
    stack.push(ethBlock) 
  } else {
    for(let i = 0;i<btc;i++){
       stack.push(ethBlock)
    }
  }
  if(neo < 1){ 
    stack.push(neoBlock) 
  } else {
    for(let i = 0;i<neo;i++){
       stack.push(neoBlock)
    }
  }
  if(lsk < 1){ 
    stack.push(lskBlock) 
  } else {
    for(let i = 0;i<lsk;i++){
       stack.push(lskBlock)
    }
  }
  if(wav < 1){ 
    stack.push(wavBlock) 
  } else {
    for(let i = 0;i<wav;i++){
       stack.push(wavBlock)
    }
  }

  const total = Object.keys(block.blockchainHeaders).reduce((all, k) => {
     all = all + block.blockchainHeaders[k].length
     return all
  }, 0)

  return stack.join("")

}

class BlocksTable extends Component<*> {
  render () {
    let i = 0
    const blocks = this.props.blocks.map((block, idx) => {
      const extraFields = (this.props.extraCols || []).map(
        (colName, idx) => {
          const val = typeof colName[1] === 'function' ? colName[1](block) : block[colName[1]]
          return (
            <td key={idx}>{val}</td>
          )
        }
      )

      const fixedStyle = {
        fontFamily: 'monospace'
      }
      // let wrongPrevHash = false
      if (this.props.blocks[idx]) {

         const a = this.props.blocks[idx]
         console.log(a)
         //const b = this.props.blocks[idx].previousHash
         //wrongPrevHash = (a !== b)
       }
      // { wrongPrevHash && <i style={{paddingLeft: 3, filter: 'invert(100%)', color: 'red'}} className='fas fa-exclamation-circle' /> }

      // let wrongPrevHash = false
      // if (this.props.blocks[idx + 1]) {
      //   const a = this.props.blocks[idx + 1].hash
      //   const b = this.props.blocks[idx].previousHash
      //   wrongPrevHash = (a !== b)
      // }
      // { wrongPrevHash && <i style={{paddingLeft: 3, filter: 'invert(100%)', color: 'red'}} className='fas fa-exclamation-circle' /> }

      return (
        <tr key={block.hash}>
          <th scope='row'>{i++}</th>
          <td>{Parser(BlockColor(block))}</td>
          <td>
            <BlockLink block={block} onClick={this.props.onClick}>{block.height}</BlockLink>
          </td>
          <td>
            <BlockLink block={block} onClick={this.props.onClick} >
              <Ellipsis text={block.hash} />
            </BlockLink>
          </td>
          <td>
            <Ellipsis text={block.previousHash} />
          </td>
          <td>
            <Ellipsis text={block.miner} />
          </td>
          <td style={fixedStyle}>{block.difficulty}</td>
          <td style={fixedStyle}>{block.distance}</td>
          <td>{block.nonce}</td>
          {extraFields}
          <td>{moment(block.timestamp * 1000).format('HH:mm:ss')}</td>
        </tr>
      )
    })

    const extraHeaders = (this.props.extraCols || []).map((colName, idx) => (<th key={idx} scope='col'>{colName[0]}</th>))

    return (
      <div className='table-responsive'>
        <table className='table table-light table-striped '>
          <thead className='thead-light'>
            <tr>
              <th scope='col'>#</th>
              <th scope='col'></th>
              <th scope='col'>Height</th>
              <th scope='col'>Hash</th>
              <th scope='col'>Previous Hash</th>
              <th scope='col'>Miner</th>
              <th scope='col'>Difficulty</th>
              <th scope='col'>Distance</th>
              <th scope='col'>Nonce</th>
              {extraHeaders}
              <th scope='col'>Timestamp</th>
            </tr>
          </thead>
          <tbody>{blocks}</tbody>
        </table>
      </div>
    )
  }
}

export default BlocksTable
