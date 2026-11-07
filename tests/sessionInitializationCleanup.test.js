const mockDestroy = jest.fn(async () => {})
const mockRemoveAllListeners = jest.fn()
const mockTerminateWebSocketServer = jest.fn(async () => {})
const mockInitialize = jest.fn(async () => {
  throw new Error('initialize failed')
})

const mockClient = {
  once: jest.fn(),
  on: jest.fn(),
  initialize: mockInitialize,
  destroy: mockDestroy,
  pupPage: {
    removeAllListeners: mockRemoveAllListeners
  }
}

jest.mock('whatsapp-web.js', () => ({
  Client: jest.fn(() => mockClient),
  LocalAuth: jest.fn(() => ({ logout: jest.fn() }))
}))

jest.mock('../src/config', () => ({
  baseWebhookURL: '',
  sessionFolderPath: '/tmp/wwebjs-session-cleanup-test',
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
  sleep: jest.fn(async () => {}),
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
  terminateWebSocketServer: mockTerminateWebSocketServer,
  triggerWebSocket: jest.fn()
}))

const { sessions, initializingSessions, setupSession } = require('../src/sessions')

describe('session initialization cleanup', () => {
  beforeEach(() => {
    sessions.clear()
    initializingSessions.clear()
    jest.clearAllMocks()
  })

  test('failed initialize destroys the client and releases session-owned resources', async () => {
    const result = await setupSession('broken-session')

    expect(result).toEqual({
      success: false,
      message: 'initialize failed',
      client: null
    })
    expect(mockInitialize).toHaveBeenCalledTimes(1)
    expect(initializingSessions.has('broken-session')).toBe(false)
    expect(mockRemoveAllListeners).toHaveBeenCalledWith('close')
    expect(mockRemoveAllListeners).toHaveBeenCalledWith('error')
    expect(mockTerminateWebSocketServer).toHaveBeenCalledWith('broken-session')
    expect(mockDestroy).toHaveBeenCalledTimes(1)
    expect(sessions.has('broken-session')).toBe(false)
  })
})
