#! /usr/bin/env node

/**
 * Copyright (c) 2017-present, blockcollider.org developers, All rights reserved.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type { Logger } from 'winston'

const colors = require('colors')
const debug = require('debug')('bcnode:cli:main')
const fs = require('fs')
const path = require('path')
const process = require('process')
const program = require('commander')
const semver = require('semver')
const Raven = require('raven')

const uncaughtExceptionHandler = (err) => {
  // eslint-disable-next-line no-console
  console.log(err)
}

process.on('uncaughtException', uncaughtExceptionHandler)

const { config } = require('../config')
const logging = require('../logger')
const { ensureDebugDir } = require('../debug')
const { getVersion, getGitVersion } = require('../helper/version')
const { getOsInfo } = require('../helper/os')
const { cmd: cmdConfig } = require('./cmd/config')
const { cmd: cmdInfo } = require('./cmd/info')
const { cmd: cmdStart } = require('./cmd/start')
const { cmd: cmdBalance } = require('./cmd/balance')
const { MINER_KEY_REGEX } = require('./minerKey')

// $FlowFixMe
const native = require('../../native/index.node')

const LOG_DIR = path.resolve(__dirname, '..', '..', '_logs')
const ROVERS = Object.keys(require('../rover/manager').rovers)

export const main = async (args: string[] = process.argv) => {
  process.title = 'bcnode'

  const version = getVersion()
  const versionString = `${version.npm}#${version.git.short}`

  program
    // $FlowFixMe
    .version(versionString)
    .usage('<cmd>')
    .action((cmd) => {
      // eslint-disable-next-line no-console
      console.log(colors.red(`Invalid command '${cmd}'`))
      return program.help()
    })

  // COMMAND - config
  program
    .command('config')
    .description('Configuration file(s)')
    .usage('[opts]')
    .option('--show', 'Show config file used')
    .action((cmd) => {
      return cmdConfig(cmd)
    })

  // COMMAND - info
  program
    .command('info')
    .description('Various metrics')
    .usage('[opts]')
    .option('--all', 'Show all', false)
    .option('--dirs', 'Path of directories used', false)
    .option('--machine', 'Machine info', false)
    .action((cmd) => {
      return cmdInfo(cmd)
    })

  // COMMAND - balance
  program
    .command('balance <address>')
    .description('Confirmed/unconfirmed address NRG balance')
    .usage('balance <address> <options>')
    .action((address, cmd) => {
      return cmdBalance(cmd, address)
    })

  // COMMAND - start
  program
    .command('start')
    .description('Start Block Collider')
    .usage('[opts]')
    .option('--miner-key [key]', 'Miner key', MINER_KEY_REGEX, process.env.BC_MINER_KEY)
    .option('-n, --node', 'Start P2P node')
    .option('--rovers [items]', 'start rover', ROVERS.join(', '))
    .option('-R, --no-rovers', 'do not start any rover')
    .option('--rpc', 'enable RPC')
    .option('--ui', 'enable Web UI')
    .option('--ws', 'enable WebSocket')
    .action((cmd) => {
      return cmdStart(cmd)
    })

  // Initialize required directories
  initDirs()

  // Initialize JS logger
  const logger = logging.getLogger(__filename)

  // Initialize Rust logger
  native.initLogger()

  if (args.length < 3) {
    logger.log(colors.red('No command specified'))
    return program.help()
  }

  // ---------------------------
  // CORE ERROR HANDLER SECTION
  // ---------------------------

  // Map of error handlers
  const errorHandlers = {
    // Uncaught exception
    uncaughtException: [],

    // Unhadled execption
    unhandledRejection: []
  }

  // Generic console handler
  const consoleErrorHandler = {
    handle: (type, err) => {
      logger.log('consoleErrorHandler', type, err)
    }
  }

  errorHandlers.uncaughtException.push(consoleErrorHandler)
  errorHandlers.unhandledRejection.push(consoleErrorHandler)

  // If sentry.io is enabled add to list of additionalErrorHandlers
  if (config.sentry.enabled) {
    const osInfo = getOsInfo()
    // Create additional error handler object
    const sentryErrorHandler = {
      // Initialization - used for startup, one-time, handler init
      init: () => {
        Raven.config(config.sentry.url, {
          release: version.git.long,
          tags: {
            'package.version': version.npm,
            'os.arch': osInfo.arch,
            'os.cpu': osInfo.cpus[0].model,
            'os.hostname': osInfo.hostname,
            'os.mem': osInfo.mem,
            'os.platform': osInfo.platform,
            'os.release': osInfo.release,
            'os.type': osInfo.type
          }
        }).install()
      },
      // Handle error
      handle: (type, err) => {
        Raven.captureException(err)
      }
    }

    // Add sentry to list of error handlers
    errorHandlers.uncaughtException.push(sentryErrorHandler)
    errorHandlers.unhandledRejection.push(sentryErrorHandler)
  }

  // Initialize error handlers
  initErrorHandlers(logger, errorHandlers)

  // Unregister global handler now
  process.removeListener('uncaughtException', uncaughtExceptionHandler)

  // ---------------------
  // CHECK REMOTE VERSION
  // ---------------------
  return getGitVersion()
    .then((gitVersion) => {
      const versionObj = {
        local: {
          npm: version.npm,
          git: version.git.short
        },
        remote: {
          npm: gitVersion
        }
      }

      debug(`Version: ${JSON.stringify(versionObj, null, 2)}`)
      return Promise.resolve([
        semver.satisfies(versionObj.local.npm, `>=${versionObj.remote.npm}`),
        versionObj.local.npm,
        versionObj.remote.npm
      ])
    })
    .then((res) => {
      const [checkOk, local, remote] = res
      if (checkOk === false) {
        logger.warn(`Version mismatch, local: ${local}, remote: ${remote}`)

        if (config.app.version.strictCheck) {
          logger.error('Strict version check enabled, exiting.')
          return
        }
      }

      // Parse command line
      return program.parse(args)
    })
    .catch((err) => {
      logger.warn(`Unable to get git version, reason: ${err.message}`)

      if (config.app.version.strictCheck) {
        logger.error('Strict version check enabled, exiting.')
        return
      }

      // Parse command line
      return program.parse(args)
    })
}

const initDirs = () => {
  // Debug directory
  ensureDebugDir(true)

  // Log directory
  if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR)
  }
}

const initErrorHandlers = (logger: Logger, errorHandlers: Object = {}) => {
  // Get all error handler names - uncaughtException, unhandledRejection ...
  const errorNames = Object.keys(errorHandlers)

  // Iterate ...
  errorNames.forEach((errorName) => {
    debug(`Initializing ${errorName} handler`)
    const handlers = errorHandlers[errorName].map((handler) => {
      // Initialize handler if init() func is specified
      handler.init && handler.init()

      return handler.handle
    })

    process.on(errorName, (err) => {
      // eslint-disable-next-line no-console
      console.trace(err)
      handlers.forEach((handler) => handler(errorName, err))
    })
  })
}

if (require.main === module) {
  main(process.argv)
}
