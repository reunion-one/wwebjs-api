const axios = require('axios')
const { logger } = require('./logger')

const INTERNAL_EVENT = 'catchup_source_state_changed'
const SIGNAL_BINDING = 'onReunionCatchupSourceSignal'
const DELIVERY_ATTEMPTS = 5
const DELIVERY_DELAYS_MS = [100, 250, 500, 1000]
const DELIVERY_TIMEOUT_MS = 2000
const NOTIFICATION_RETRY_DELAY_MS = 250

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const bindingQueues = new WeakMap()

const bindingVisible = async (page, name) => {
  return await page.evaluate(bindingName => typeof window[bindingName] === 'function', name)
}

const withBindingLock = async (page, name, operation) => {
  let locks = bindingQueues.get(page)
  if (!locks) {
    locks = new Map()
    bindingQueues.set(page, locks)
  }
  const previous = locks.get(name) || Promise.resolve()
  const current = previous.catch(() => {}).then(operation)
  locks.set(name, current)
  try {
    return await current
  } finally {
    if (locks.get(name) === current) locks.delete(name)
    if (locks.size === 0) bindingQueues.delete(page)
  }
}

const exposeReunionSignalBinding = async (page, fn) => {
  return await withBindingLock(page, SIGNAL_BINDING, async () => {
    if (await bindingVisible(page, SIGNAL_BINDING)) return

    if (typeof page.removeExposedFunction === 'function') {
      await page.removeExposedFunction(SIGNAL_BINDING).catch(() => {})
    }

    try {
      await page.exposeFunction(SIGNAL_BINDING, fn)
      return
    } catch (error) {
      if (!String(error && error.message).includes('already exists')) throw error
      if (await bindingVisible(page, SIGNAL_BINDING).catch(() => false)) return
      if (typeof page.removeExposedFunction !== 'function') throw error
    }

    await page.removeExposedFunction(SIGNAL_BINDING).catch(() => {})
    try {
      await page.exposeFunction(SIGNAL_BINDING, fn)
    } catch (error) {
      if (
        String(error && error.message).includes('already exists') &&
        await bindingVisible(page, SIGNAL_BINDING).catch(() => false)
      ) {
        return
      }
      throw error
    }
  })
}
const rawHistorySyncState = async client => {
  if (!client || !client.pupPage || client.pupPage.isClosed?.()) {
    return {
      ready: false,
      hasSynced: false,
      connectionState: null,
      recentCompleted: false,
      isOfflineDeliveryEnd: false,
      isResumeComplete: false,
      hasMessagesToDownload: null,
      offlineProgress: null,
      providerCatchupSourceReady: false
    }
  }

  return await client.pupPage.evaluate(() => {
    const safeRead = (read, fallback) => {
      try {
        return read()
      } catch {
        return fallback
      }
    }
    const Socket = safeRead(() => window.require('WAWebSocketModel')?.Socket, null)
    const BackendEventBus = safeRead(() => window.require('WAWebBackendEventBus')?.BackendEventBus, null)
    const OfflineMessageHandler = safeRead(() => window.require('WAWebOfflineHandler')?.OfflineMessageHandler, null)
    const HistorySync = safeRead(() => window.require('WAWebUserPrefsHistorySync'), null)
    const historyStatus = safeRead(() => HistorySync?.getHistorySyncStatus?.() ?? null, null)
    const hasSynced = safeRead(() => Socket?.hasSynced === true, false)
    const connectionState = safeRead(() => Socket?.state ?? null, null)
    const recentCompleted = safeRead(() => historyStatus?.recentCompleted === true, false)
    const isOfflineDeliveryEnd = safeRead(() => BackendEventBus?.isOfflineDeliveryEnd === true, false)

    return {
      ready: hasSynced && connectionState === 'CONNECTED' && typeof window.WWebJS !== 'undefined',
      hasSynced,
      connectionState,
      recentCompleted,
      isOfflineDeliveryEnd,
      isResumeComplete: safeRead(() => OfflineMessageHandler?.isResumeComplete?.() === true, false),
      hasMessagesToDownload: safeRead(() => OfflineMessageHandler?.getHasMessagesToDownload?.() ?? null, null),
      offlineProgress: safeRead(() => OfflineMessageHandler?.getOfflineDeliveryProgress?.() ?? null, null),
      providerCatchupSourceReady: recentCompleted && isOfflineDeliveryEnd
    }
  })
}

const installProviderObservers = async (client, signal) => {
  if (!client?.pupPage || client.pupPage.isClosed?.()) {
    throw new Error('WWebJS page is unavailable for catch-up source observation')
  }

  await exposeReunionSignalBinding(client.pupPage, signal)
  await client.pupPage.evaluate(bindingName => {
    if (window.WWebJS?.__reunionCatchupSourceObserversAttached === true) {
      return
    }

    const BackendEventBus = window.require('WAWebBackendEventBus')?.BackendEventBus
    if (!BackendEventBus) {
      throw new Error('WAWebBackendEventBus is unavailable')
    }

    const signalStateChanged = () => {
      const callback = window[bindingName]
      if (typeof callback === 'function') {
        Promise.resolve(callback()).catch(() => {})
      }
    }

    const registrations = [
      ['onRecentChatHistorySynced', BackendEventBus.onRecentChatHistorySynced],
      ['onOfflineDeliveryEnd', BackendEventBus.onOfflineDeliveryEnd],
      ['onOfflineDeliveryStateReset', BackendEventBus.onOfflineDeliveryStateReset]
    ]
    for (const [name, register] of registrations) {
      if (typeof register !== 'function') {
        throw new Error('Backend event observer ' + name + ' is unavailable')
      }
      register.call(BackendEventBus, signalStateChanged)
    }

    if (typeof window.WWebJS !== 'undefined') {
      window.WWebJS.__reunionCatchupSourceObserversAttached = true
    }
  }, SIGNAL_BINDING)
}

const isRetryableDeliveryError = error => {
  const status = error?.response?.status
  if (Number.isInteger(status)) return status >= 500 && status < 600
  const code = error?.code || error?.cause?.code
  return new Set([
    'ECONNABORTED',
    'ECONNREFUSED',
    'ECONNRESET',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ERR_NETWORK'
  ]).has(code)
}

const deliverStateChange = async (internalLifecycleURL, sessionId, catchupSourceReady) => {
  if (!internalLifecycleURL) {
    throw new Error('Internal COMM lifecycle URL is not configured')
  }

  let lastError = null
  for (let attempt = 1; attempt <= DELIVERY_ATTEMPTS; attempt++) {
    try {
      await axios.post(
        internalLifecycleURL,
        {
          event: INTERNAL_EVENT,
          sessionId,
          catchupSourceReady
        },
        {
          timeout: DELIVERY_TIMEOUT_MS
        }
      )
      return
    } catch (error) {
      lastError = error
      const retryable = isRetryableDeliveryError(error)
      if (!retryable || attempt === DELIVERY_ATTEMPTS) {
        break
      }
      await sleep(DELIVERY_DELAYS_MS[attempt - 1] ?? DELIVERY_DELAYS_MS.at(-1))
    }
  }

  throw lastError || new Error('Internal COMM lifecycle notification failed')
}

const lifecycleStates = new Map()

const stateFor = sessionId => {
  let state = lifecycleStates.get(sessionId)
  if (!state) {
    state = {
      catchupSourceReady: false,
      invalidationAccepted: false,
      blocked: true,
      token: null,
      pendingSignal: false,
      notificationDirty: false,
      notificationRetryTimer: null,
      deliveryChain: Promise.resolve()
    }
    lifecycleStates.set(sessionId, state)
  }
  return state
}

const getCatchupSourceReady = sessionId => {
  const state = lifecycleStates.get(sessionId)
  return Boolean(
    state &&
    state.blocked === false &&
    state.invalidationAccepted === true &&
    state.catchupSourceReady === true
  )
}

const clearCatchupSourceState = sessionId => {
  const state = lifecycleStates.get(sessionId)
  if (state) {
    state.token = null
    state.blocked = true
    state.invalidationAccepted = false
    state.notificationDirty = false
    state.pendingSignal = false
    if (state.notificationRetryTimer) {
      clearTimeout(state.notificationRetryTimer)
      state.notificationRetryTimer = null
    }
  }
  lifecycleStates.delete(sessionId)
}

const enqueue = (state, operation) => {
  state.deliveryChain = state.deliveryChain.then(operation, operation)
  return state.deliveryChain
}

const createLifecycleController = ({ client, sessionId, internalLifecycleURL }) => {
  const state = stateFor(sessionId)

  const cancelNotificationRetry = () => {
    if (!state.notificationRetryTimer) return
    clearTimeout(state.notificationRetryTimer)
    state.notificationRetryTimer = null
  }

  const scheduleNotificationRetry = token => {
    if (
      state.token !== token ||
      !state.invalidationAccepted ||
      state.blocked ||
      !state.notificationDirty ||
      state.notificationRetryTimer
    ) {
      return
    }

    const timer = setTimeout(() => {
      if (state.notificationRetryTimer === timer) {
        state.notificationRetryTimer = null
      }
      if (
        state.token !== token ||
        !state.invalidationAccepted ||
        state.blocked ||
        !state.notificationDirty
      ) {
        return
      }
      enqueue(state, async () => {
        await reconcile(token)
      }).catch(error => {
        logger.error(
          { sessionId, err: error },
          'Failed to retry WWebJS catch-up source notification reconciliation'
        )
      })
    }, NOTIFICATION_RETRY_DELAY_MS)
    timer.unref?.()
    state.notificationRetryTimer = timer
  }

  const reconcile = async token => {
    if (state.token !== token || !state.invalidationAccepted || state.blocked) return

    let observed
    try {
      observed = await rawHistorySyncState(client)
    } catch (error) {
      if (state.token === token) {
        state.catchupSourceReady = false
      }
      logger.warn({ sessionId, err: error }, 'Could not reconcile WWebJS catch-up source state')
      return
    }

    if (state.token !== token || !state.invalidationAccepted || state.blocked) return
    const nextReady = observed.providerCatchupSourceReady === true
    const readinessChanged = nextReady !== state.catchupSourceReady
    if (readinessChanged) {
      state.catchupSourceReady = nextReady
      state.notificationDirty = true
    }
    if (!state.notificationDirty) return
    if (state.notificationRetryTimer && !readinessChanged) return

    const notificationValue = state.catchupSourceReady
    try {
      await deliverStateChange(internalLifecycleURL, sessionId, notificationValue)
    } catch (error) {
      if (state.token !== token || !state.invalidationAccepted || state.blocked) return
      logger.error(
        { sessionId, catchupSourceReady: notificationValue, err: error },
        'Failed to deliver WWebJS catch-up source state change'
      )
      state.notificationDirty = true
      scheduleNotificationRetry(token)
      return
    }

    if (state.token !== token || !state.invalidationAccepted || state.blocked) return
    if (state.catchupSourceReady === notificationValue) {
      state.notificationDirty = false
      cancelNotificationRetry()
    } else {
      state.notificationDirty = true
      scheduleNotificationRetry(token)
    }
  }

  const signal = () => {
    const token = state.token
    if (!token || !state.invalidationAccepted || state.blocked) {
      state.pendingSignal = true
      return
    }
    enqueue(state, async () => {
      await reconcile(token)
    }).catch(error => {
      logger.error({ sessionId, err: error }, 'Failed to reconcile WWebJS catch-up source signal')
    })
  }

  const begin = async () => {
    const token = {}
    cancelNotificationRetry()
    state.token = token
    state.blocked = true
    state.invalidationAccepted = false
    state.pendingSignal = false
    state.notificationDirty = false

    try {
      await installProviderObservers(client, signal)
    } catch (error) {
      logger.error({ sessionId, err: error }, 'Failed to install WWebJS catch-up source observers')
      state.catchupSourceReady = false
      return
    }

    if (state.token !== token) return
    state.catchupSourceReady = false

    await enqueue(state, async () => {
      if (state.token !== token) return
      try {
        await deliverStateChange(internalLifecycleURL, sessionId, false)
      } catch (error) {
        logger.error(
          { sessionId, err: error },
          'Failed to deliver mandatory WWebJS catch-up source invalidation'
        )
        return
      }

      if (state.token !== token) return
      state.invalidationAccepted = true
      state.blocked = false
      const hadPendingSignal = state.pendingSignal
      state.pendingSignal = false
      await reconcile(token)
      if (hadPendingSignal) {
        await reconcile(token)
      }
    })
  }

  return {
    begin,
    signal,
    get ready () {
      return getCatchupSourceReady(sessionId)
    }
  }
}

module.exports = {
  INTERNAL_EVENT,
  SIGNAL_BINDING,
  exposeReunionSignalBinding,
  rawHistorySyncState,
  installProviderObservers,
  deliverStateChange,
  createLifecycleController,
  getCatchupSourceReady,
  clearCatchupSourceState
}
