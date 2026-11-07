const app = require('./src/app')
const { servicePort, baseWebhookURL, enableWebHook, enableWebSocket, autoStartSessions } = require('./src/config')
const { logger } = require('./src/logger')
const { handleUpgrade } = require('./src/websocket')
const { restoreSessions, sessions, initializingSessions, destroySession } = require('./src/sessions')

// Check if BASE_WEBHOOK_URL environment variable is available when WebHook is enabled
if (!baseWebhookURL && enableWebHook) {
  logger.error('BASE_WEBHOOK_URL environment variable is not set. Exiting...')
  process.exit(1) // Terminate the application with an error code
}

const server = app.listen(servicePort, () => {
  logger.info(`Server running on port ${servicePort}`)
  logger.debug({ configuration: require('./src/config') }, 'Service configuration')
  if (autoStartSessions) {
    logger.info('Starting all sessions')
    restoreSessions()
  }
})

if (enableWebSocket) {
  server.on('upgrade', (request, socket, head) => {
    handleUpgrade(request, socket, head)
  })
}

let shuttingDown = false
const shutdown = async (signal) => {
  if (shuttingDown) return
  shuttingDown = true
  logger.info({ signal }, 'Shutting down WWebJS service')

  for (const sessionId of new Set([
    ...sessions.keys(),
    ...initializingSessions.keys()
  ])) {
    try {
      await destroySession(sessionId)
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to destroy session during shutdown')
    }
  }

  await new Promise(resolve => server.close(resolve))
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    shutdown(signal)
      .then(() => process.exit(0))
      .catch(error => {
        logger.error({ signal, err: error }, 'WWebJS shutdown failed')
        process.exit(1)
      })
  })
}

// puppeteer uses subscriptions to SIGINT, SIGTERM, and SIGHUP to know when to close browser instances
// this disables the warnings when you starts more than 10 browser instances
process.setMaxListeners(0)
