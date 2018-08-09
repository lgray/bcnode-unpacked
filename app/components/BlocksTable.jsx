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

  if(previous.length > 5){
    previous.shift()
  }

  if(previous.length > 0) {
    old = previous[previous.length - 1]
  } else {
    previous.push(Object.keys(block.blockchainHeaders).reduce((all, k)=> {
      all[k] = block.blockchainHeaders[k].map((a) => {
        return a.hash
      })
      return all
    }, {}))
    return "" 
  }

  const btc = old.btcList.reduce((all, b) => {
    block.blockchainHeaders.btcList.map((a) => {
      if(b !== a.hash){
        all = all + 1 
      }
    })
    return all
  }, 0)
  const eth = old.ethList.reduce((all, b) => {
    block.blockchainHeaders.ethList.map((a) => {
      if(b !== a.hash){
        all = all + 1 
      }
    })
    return all
  }, 0)
  const neo = old.neoList.reduce((all, b) => {
    block.blockchainHeaders.neoList.map((a) => {
      if(b !== a.hash){
        all = all + 1 
      }
    })
    return all
  }, 0)
  const lsk = old.lskList.reduce((all, b) => {
    block.blockchainHeaders.lskList.map((a) => {
      if(b !== a.hash){
        all = all + 1 
      }
    })
    return all
  }, 0)
  const wav = old.wavList.reduce((all, b) => {
    block.blockchainHeaders.wavList.map((a) => {
      if(b !== a.hash){
        all = all + 1 
      }
    })
    return all
  }, 0)

  previous.push(next)

  const stack = []

  const glassBlock = '<div id="glasscolor"></div>' 
  const btcBlock = '<div id="btccolor"></div>' 
  const ethBlock = '<div id="ethcolor"></div>' 
  const neoBlock = '<div id="neocolor"></div>' 
  const lskBlock = '<div id="lskcolor"></div>' 
  const wavBlock = '<div id="wavcolor"></div>' 

  if(btc < 1){ 
    stack.push(glassBlock) 
  } else {
    for(let i = 0;i<btc;i++){
       stack.push(btcBlock)
    }
  }
  if(eth < 1){ 
    stack.push(glassBlock) 
  } else {
    for(let i = 0;i<btc;i++){
       stack.push(ethBlock)
    }
  }
  if(neo < 1){ 
    stack.push(glassBlock) 
  } else {
    for(let i = 0;i<neo;i++){
       stack.push(neoBlock)
    }
  }
  if(lsk < 1){ 
    stack.push(glassBlock) 
  } else {
    for(let i = 0;i<lsk;i++){
       stack.push(lskBlock)
    }
  }
  if(wav < 1){ 
    stack.push(glassBlock) 
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
      let table = [] 
      if (this.props.blocks[idx + 1]) {
        Object.keys(this.props.blocks[idx].blockchainHeaders).map((k) => {
          const a = this.props.blocks[idx + 1].blockchainHeaders[k].map((a) => { return a.hash }).join('')
          const b = this.props.blocks[idx].blockchainHeaders[k].map((a) => { return a.hash }).join('')
          if(a !== b) {
            table.push('<div id="' + k + '"></div>') 
          } else {
            table.push('<div id="glassList"></div>') 
          }
        })
      }
      // { wrongPrevHash && <i style={{paddingLeft: 3, filter: 'invert(100%)', color: 'red'}} className='fas fa-exclamation-circle' /> }

      return (
        <tr key={block.hash}>
          <th scope='row'>{i++}</th>
          <td>{Parser(table.join(""))}</td>
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
