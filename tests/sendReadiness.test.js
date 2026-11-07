const mockSleep = jest.fn(async () => {})

jest.mock('whatsapp-web.js', () => ({
  Client: jest.fn(),
  LocalAuth: jest.fn()
}))

jest.mock('../src/config', () => ({
  baseWebhookURL: '',
  sessionFolderPath: '/tmp/wwebjs-send-readiness-test',
  maxAttachmentSize: 1024,
  setMessagesAsSeen: false,
  webVersion: null,
  webVersionCacheType: 'none',
  recoverSessions: false,
  chromeBin: '/usr/bin/chromium',
  headless: true,
  releaseBrowserLock: false,
  proxyUrl: null,
  proxyUsername: null,
  proxyPassword: null
}))

jest.mock('../src/utils', () => ({
  triggerWebhook: jest.fn(),
  waitForNestedObject: jest.fn(async () => {}),
  isEventEnabled: jest.fn(() => false),
  sendMessageSeenStatus: jest.fn(),
  sleep: mockSleep,
  patchWWebLibrary: jest.fn(async () => {})
}))

jest.mock('../src/logger', () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }
}))

jest.mock('../src/websocket', () => ({
  initWebSocketServer: jest.fn(),
  terminateWebSocketServer: jest.fn(async () => {}),
  triggerWebSocket: jest.fn()
}))

const { sessions, initializingSessions, validateSendSession } = require('../src/sessions')

const clientWithReadiness = readiness => {
  const evaluate = jest.fn()
  for (const value of readiness) {
    if (value instanceof Error) {
      evaluate.mockRejectedValueOnce(value)
    } else {
      evaluate.mockResolvedValueOnce(value)
    }
  }
  return {
    pupPage: {
      isClosed: jest.fn(() => false),
      evaluate
    }
  }
}

describe('send-session readiness', () => {
  beforeEach(() => {
    sessions.clear()
    initializingSessions.clear()
    jest.clearAllMocks()
  })

  test('waits for the injected WWebJS send bridge after CONNECTED and then succeeds', async () => {
    const client = clientWithReadiness([
      { state: 'CONNECTED', ready: false },
      { state: 'CONNECTED', ready: false },
      { state: 'CONNECTED', ready: true }
    ])
    sessions.set('send-ready', client)

    await expect(validateSendSession('send-ready')).resolves.toEqual({
      success: true,
      state: 'CONNECTED',
      message: 'session_connected'
    })
    expect(client.pupPage.evaluate).toHaveBeenCalledTimes(3)
    expect(mockSleep).toHaveBeenCalledTimes(2)
  })

  test('survives a navigation-destroyed execution context while reinjection completes', async () => {
    const client = clientWithReadiness([
      new Error('Execution context was destroyed, most likely because of a navigation.'),
      { state: null, ready: false },
      { state: 'CONNECTED', ready: true }
    ])
    sessions.set('send-navigation', client)

    await expect(validateSendSession('send-navigation')).resolves.toEqual({
      success: true,
      state: 'CONNECTED',
      message: 'session_connected'
    })
    expect(mockSleep).toHaveBeenCalledTimes(2)
  })

  test('fails immediately for an explicitly disconnected session', async () => {
    const client = clientWithReadiness([
      { state: 'UNPAIRED_IDLE', ready: false }
    ])
    sessions.set('send-disconnected', client)

    await expect(validateSendSession('send-disconnected')).resolves.toEqual({
      success: false,
      state: 'UNPAIRED_IDLE',
      message: 'session_not_connected'
    })
    expect(mockSleep).not.toHaveBeenCalled()
  })

  test('fails closed when CONNECTED never regains the injected send bridge', async () => {
    const evaluate = jest.fn(async () => ({ state: 'CONNECTED', ready: false }))
    sessions.set('send-stuck', {
      pupPage: {
        isClosed: jest.fn(() => false),
        evaluate
      }
    })

    await expect(validateSendSession('send-stuck')).resolves.toEqual({
      success: false,
      state: 'CONNECTED',
      message: 'session_send_not_ready'
    })
    expect(evaluate).toHaveBeenCalledTimes(150)
    expect(mockSleep).toHaveBeenCalledTimes(149)
  })

  test('does not treat an initializing client as send-ready', async () => {
    initializingSessions.set('send-initializing', { pupPage: {} })

    await expect(validateSendSession('send-initializing')).resolves.toEqual({
      success: false,
      state: null,
      message: 'session_not_connected'
    })
  })
})
