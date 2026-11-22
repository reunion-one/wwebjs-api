const axios = require('axios')

jest.mock('axios')

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}))

const {
  SIGNAL_BINDING,
  exposeReunionSignalBinding,
  rawHistorySyncState,
  installProviderObservers,
  deliverStateChange,
  createLifecycleController,
  getCatchupSourceReady,
  clearCatchupSourceState
} = require('../src/catchupSource')

const flushAsync = async () => {
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
}

const browserFixture = ({
  hasSynced = true,
  connectionState = 'CONNECTED',
  recentCompleted = false,
  offlineDeliveryEnd = false
} = {}) => {
  const handlers = {
    recent: [],
    offlineEnd: [],
    offlineReset: []
  }
  const Socket = {
    hasSynced,
    state: connectionState
  }
  const historyStatus = { recentCompleted }
  const BackendEventBus = {
    isOfflineDeliveryEnd: offlineDeliveryEnd,
    onRecentChatHistorySynced: handler => handlers.recent.push(handler),
    onOfflineDeliveryEnd: handler => handlers.offlineEnd.push(handler),
    onOfflineDeliveryStateReset: handler => handlers.offlineReset.push(handler)
  }
  const OfflineMessageHandler = {
    isResumeComplete: () => BackendEventBus.isOfflineDeliveryEnd,
    getHasMessagesToDownload: () => !BackendEventBus.isOfflineDeliveryEnd,
    getOfflineDeliveryProgress: () => BackendEventBus.isOfflineDeliveryEnd ? 100 : 50
  }
  const fakeWindow = {
    WWebJS: {},
    require: name => {
      if (name === 'WAWebSocketModel') return { Socket }
      if (name === 'WAWebBackendEventBus') return { BackendEventBus }
      if (name === 'WAWebOfflineHandler') return { OfflineMessageHandler }
      if (name === 'WAWebUserPrefsHistorySync') {
        return { getHistorySyncStatus: () => historyStatus }
      }
      throw new Error('Unexpected module: ' + name)
    }
  }

  const withWindow = async (fn, args) => {
    const previous = global.window
    global.window = fakeWindow
    try {
      return await fn(...args)
    } finally {
      global.window = previous
    }
  }

  const exposed = new Set()
  const page = {
    isClosed: jest.fn(() => false),
    evaluate: jest.fn(async (fn, ...args) => await withWindow(fn, args)),
    exposeFunction: jest.fn(async (name, fn) => {
      if (exposed.has(name)) {
        throw new Error('Failed to add page binding with name ' + name + ': already exists')
      }
      exposed.add(name)
      fakeWindow[name] = fn
    }),
    removeExposedFunction: jest.fn(async name => {
      exposed.delete(name)
      delete fakeWindow[name]
    })
  }

  return {
    client: { pupPage: page },
    page,
    exposed,
    Socket,
    historyStatus,
    BackendEventBus,
    handlers,
    fakeWindow,
    async fireRecent () {
      for (const handler of handlers.recent) await withWindow(handler, [])
      await flushAsync()
    },
    async fireOfflineEnd () {
      for (const handler of handlers.offlineEnd) await withWindow(handler, [])
      await flushAsync()
    },
    async fireOfflineReset () {
      for (const handler of handlers.offlineReset) await withWindow(handler, [])
      await flushAsync()
    }
  }
}

describe('WWebJS catch-up source readiness', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    axios.post.mockResolvedValue({ status: 200 })
  })

  afterEach(() => {
    for (const sessionId of [
      'already-ready',
      'startup-pending',
      'new-profile',
      'reset-cycle',
      'socket-only',
      'delivery-disabled',
      'navigation-gap',
      'reinitialized',
      'invalidation-failed',
      'positive-delivery-retry',
      'positive-coalesces-false',
      'false-delivery-retry',
      'single-retry-timer',
      'stale-retry-token',
      'reinitialized-retry-token'
    ]) {
      clearCatchupSourceState(sessionId)
    }
  })

  test('CONNECTED and Client-ready diagnostics are insufficient before RECENT completion', async () => {
    const fixture = browserFixture({
      hasSynced: true,
      connectionState: 'CONNECTED',
      recentCompleted: false,
      offlineDeliveryEnd: true
    })

    const state = await rawHistorySyncState(fixture.client)

    expect(state.ready).toBe(true)
    expect(state.recentCompleted).toBe(false)
    expect(state.isOfflineDeliveryEnd).toBe(true)
    expect(state.providerCatchupSourceReady).toBe(false)
    expect(fixture.page.evaluate).toHaveBeenCalledTimes(1)
  })

  test('listener registration followed by reconciliation recognizes an already-synchronized profile', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'already-ready',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()

    expect(fixture.handlers.recent).toHaveLength(1)
    expect(fixture.handlers.offlineEnd).toHaveLength(1)
    expect(fixture.handlers.offlineReset).toHaveLength(1)
    expect(axios.post.mock.calls.map(call => call[1])).toEqual([
      {
        event: 'catchup_source_state_changed',
        sessionId: 'already-ready',
        catchupSourceReady: false
      },
      {
        event: 'catchup_source_state_changed',
        sessionId: 'already-ready',
        catchupSourceReady: true
      }
    ])
    expect(getCatchupSourceReady('already-ready')).toBe(true)
  })

  test('persisted RECENT state waits for current startup pending-message completion', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: false
    })
    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'startup-pending',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    expect(getCatchupSourceReady('startup-pending')).toBe(false)
    expect(axios.post).toHaveBeenCalledTimes(1)

    fixture.BackendEventBus.isOfflineDeliveryEnd = true
    await fixture.fireOfflineEnd()

    expect(getCatchupSourceReady('startup-pending')).toBe(true)
    expect(axios.post).toHaveBeenLastCalledWith(
      'http://127.0.0.1:5000/internal/wwebjs-lifecycle',
      {
        event: 'catchup_source_state_changed',
        sessionId: 'startup-pending',
        catchupSourceReady: true
      },
      { timeout: 2000 }
    )
  })

  test('newly paired profile cannot become ready before RECENT synchronization completes', async () => {
    const fixture = browserFixture({
      recentCompleted: false,
      offlineDeliveryEnd: true
    })
    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'new-profile',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    expect(getCatchupSourceReady('new-profile')).toBe(false)
    expect(axios.post).toHaveBeenCalledTimes(1)

    fixture.historyStatus.recentCompleted = true
    await fixture.fireRecent()

    expect(getCatchupSourceReady('new-profile')).toBe(true)
    expect(axios.post).toHaveBeenCalledTimes(2)
  })

  test('offline delivery reset invalidates readiness and completion restores it', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'reset-cycle',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    axios.post.mockClear()

    fixture.BackendEventBus.isOfflineDeliveryEnd = false
    await fixture.fireOfflineReset()
    expect(getCatchupSourceReady('reset-cycle')).toBe(false)
    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([false])

    fixture.BackendEventBus.isOfflineDeliveryEnd = true
    await fixture.fireOfflineEnd()
    expect(getCatchupSourceReady('reset-cycle')).toBe(true)
    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([false, true])
  })

  test('reinitialized client lifecycle force-invalidates before recomputing the same ready state', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'reinitialized',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    expect(getCatchupSourceReady('reinitialized')).toBe(true)
    axios.post.mockClear()

    await lifecycle.begin()

    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([false, true])
    expect(getCatchupSourceReady('reinitialized')).toBe(true)
  })

  test('failed mandatory invalidation keeps positive readiness fail-closed', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    axios.post.mockRejectedValueOnce({
      response: { status: 400 }
    })
    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'invalidation-failed',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()

    expect(axios.post).toHaveBeenCalledTimes(1)
    expect(axios.post.mock.calls[0][1].catchupSourceReady).toBe(false)
    expect(getCatchupSourceReady('invalidation-failed')).toBe(false)
  })

  test('failed positive delivery keeps provider-derived readiness true and retries the wake-up', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    axios.post
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce({ status: 200 })

    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'positive-delivery-retry',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()

    expect(getCatchupSourceReady('positive-delivery-retry')).toBe(true)
    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([false, true])

    await new Promise(resolve => setTimeout(resolve, 325))
    await flushAsync()

    expect(getCatchupSourceReady('positive-delivery-retry')).toBe(true)
    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([
      false,
      true,
      true
    ])
  })

  test('a pending positive retry coalesces to current false instead of replaying stale true', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    axios.post
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce({ status: 200 })

    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'positive-coalesces-false',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    expect(getCatchupSourceReady('positive-coalesces-false')).toBe(true)

    fixture.BackendEventBus.isOfflineDeliveryEnd = false
    await fixture.fireOfflineReset()

    expect(getCatchupSourceReady('positive-coalesces-false')).toBe(false)
    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([
      false,
      true,
      false
    ])

    await new Promise(resolve => setTimeout(resolve, 325))
    await flushAsync()
    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([
      false,
      true,
      false
    ])
  })

  test('failed later false delivery keeps exported readiness false and retries false', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'false-delivery-retry',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    axios.post.mockClear()
    axios.post
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce({ status: 200 })

    fixture.BackendEventBus.isOfflineDeliveryEnd = false
    await fixture.fireOfflineReset()

    expect(getCatchupSourceReady('false-delivery-retry')).toBe(false)
    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([false])

    await new Promise(resolve => setTimeout(resolve, 325))
    await flushAsync()

    expect(getCatchupSourceReady('false-delivery-retry')).toBe(false)
    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([
      false,
      false
    ])
  })

  test('delivery failure schedules only one retry while repeated signals arrive', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    axios.post
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValue({ response: { status: 400 } })

    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'single-retry-timer',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    lifecycle.signal()
    lifecycle.signal()
    lifecycle.signal()
    await flushAsync()

    expect(getCatchupSourceReady('single-retry-timer')).toBe(true)
    expect(axios.post).toHaveBeenCalledTimes(2)

    axios.post.mockResolvedValue({ status: 200 })
    await new Promise(resolve => setTimeout(resolve, 325))
    await flushAsync()

    expect(axios.post).toHaveBeenCalledTimes(3)
    expect(axios.post.mock.calls.at(-1)[1].catchupSourceReady).toBe(true)
  })

  test('a new lifecycle token cancels pending retry work before mandatory false reinitialization', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    axios.post
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValueOnce({ response: { status: 400 } })
      .mockResolvedValueOnce({ status: 200 })
      .mockResolvedValueOnce({ status: 200 })

    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'reinitialized-retry-token',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    expect(getCatchupSourceReady('reinitialized-retry-token')).toBe(true)

    await lifecycle.begin()
    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([
      false,
      true,
      false,
      true
    ])

    await new Promise(resolve => setTimeout(resolve, 325))
    await flushAsync()

    expect(axios.post.mock.calls.map(call => call[1].catchupSourceReady)).toEqual([
      false,
      true,
      false,
      true
    ])
    expect(getCatchupSourceReady('reinitialized-retry-token')).toBe(true)
  })

  test('clearing a lifecycle cancels stale pending notification retry work', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    axios.post
      .mockResolvedValueOnce({ status: 200 })
      .mockRejectedValueOnce({ response: { status: 400 } })

    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'stale-retry-token',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    expect(getCatchupSourceReady('stale-retry-token')).toBe(true)
    const callsAtClear = axios.post.mock.calls.length

    clearCatchupSourceState('stale-retry-token')
    axios.post.mockResolvedValue({ status: 200 })
    await new Promise(resolve => setTimeout(resolve, 325))
    await flushAsync()

    expect(axios.post).toHaveBeenCalledTimes(callsAtClear)
    expect(getCatchupSourceReady('stale-retry-token')).toBe(false)
  })

  test('pure socket reconnect with unchanged synchronization state emits no readiness cycle', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })
    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'socket-only',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })

    await lifecycle.begin()
    axios.post.mockClear()

    fixture.Socket.state = 'OPENING'
    fixture.Socket.state = 'PAIRING'
    fixture.Socket.state = 'CONNECTED'
    await flushAsync()

    expect(getCatchupSourceReady('socket-only')).toBe(true)
    expect(axios.post).not.toHaveBeenCalled()
  })

  test('internal lifecycle delivery does not depend on public webhook callback settings', async () => {
    await deliverStateChange(
      'http://127.0.0.1:5000/internal/wwebjs-lifecycle',
      'delivery-disabled',
      false
    )

    expect(axios.post).toHaveBeenCalledWith(
      'http://127.0.0.1:5000/internal/wwebjs-lifecycle',
      {
        event: 'catchup_source_state_changed',
        sessionId: 'delivery-disabled',
        catchupSourceReady: false
      },
      { timeout: 2000 }
    )
  })

  test('navigation reconciliation failure cannot publish positive readiness', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: false
    })
    const lifecycle = createLifecycleController({
      client: fixture.client,
      sessionId: 'navigation-gap',
      internalLifecycleURL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    })
    await lifecycle.begin()
    axios.post.mockClear()

    fixture.BackendEventBus.isOfflineDeliveryEnd = true
    fixture.page.evaluate.mockRejectedValueOnce(
      new Error('Execution context was destroyed, most likely because of a navigation.')
    )
    await fixture.fireOfflineEnd()

    expect(getCatchupSourceReady('navigation-gap')).toBe(false)
    expect(axios.post).not.toHaveBeenCalled()
  })

  test('Reunion signal binding recovers a stale Puppeteer registration without changing global helpers', async () => {
    const fixture = browserFixture()
    const signal = jest.fn()
    fixture.exposed.add(SIGNAL_BINDING)
    delete fixture.fakeWindow[SIGNAL_BINDING]

    await exposeReunionSignalBinding(fixture.page, signal)

    expect(fixture.page.removeExposedFunction).toHaveBeenCalledWith(SIGNAL_BINDING)
    expect(fixture.fakeWindow[SIGNAL_BINDING]).toBe(signal)
  })

  test('concurrent Reunion binding installation serializes and never double-exposes the signal', async () => {
    const fixture = browserFixture()
    const signal = jest.fn()

    await Promise.all([
      exposeReunionSignalBinding(fixture.page, signal),
      exposeReunionSignalBinding(fixture.page, signal)
    ])

    expect(fixture.page.exposeFunction).toHaveBeenCalledTimes(1)
    expect(fixture.fakeWindow[SIGNAL_BINDING]).toBe(signal)
  })
  test('observer installation is idempotent on the same injected page', async () => {
    const fixture = browserFixture()
    const signal = jest.fn()

    await installProviderObservers(fixture.client, signal)
    await installProviderObservers(fixture.client, signal)

    expect(fixture.handlers.recent).toHaveLength(1)
    expect(fixture.handlers.offlineEnd).toHaveLength(1)
    expect(fixture.handlers.offlineReset).toHaveLength(1)
  })

  test('readiness observation never invokes on-demand chat history', async () => {
    const fixture = browserFixture({
      recentCompleted: true,
      offlineDeliveryEnd: true
    })

    await rawHistorySyncState(fixture.client)

    const requiredModules = fixture.fakeWindow.require
    expect(requiredModules).toBeDefined()
    expect(fixture.page.evaluate).toHaveBeenCalledTimes(1)
  })
})
