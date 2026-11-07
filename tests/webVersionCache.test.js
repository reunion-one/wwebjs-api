const mockClientInstance = {
  once: jest.fn(),
  on: jest.fn(),
  initialize: jest.fn(async () => {}),
  pupPage: {
    once: jest.fn(),
    on: jest.fn(function () { return this })
  }
}
const mockClient = jest.fn(() => mockClientInstance)
const mockLocalAuth = jest.fn(() => ({}))

jest.mock('whatsapp-web.js', () => ({
  Client: mockClient,
  LocalAuth: mockLocalAuth
}))
jest.mock('fs', () => {
  const actual = jest.requireActual('fs')
  return {
    ...actual,
    promises: {
      ...actual.promises,
      lstat: jest.fn(async () => {
        const error = new Error('not found')
        error.code = 'ENOENT'
        throw error
      })
    }
  }
})
jest.mock('../src/utils', () => ({
  triggerWebhook: jest.fn(),
  waitForNestedObject: jest.fn(async () => {}),
  isEventEnabled: jest.fn(() => false),
  sendMessageSeenStatus: jest.fn(),
  sleep: jest.fn(),
  patchWWebLibrary: jest.fn(async () => {})
}))
jest.mock('../src/logger', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  }
}))
jest.mock('../src/websocket', () => ({
  initWebSocketServer: jest.fn(),
  terminateWebSocketServer: jest.fn(async () => {}),
  triggerWebSocket: jest.fn()
}))

const config = require('../src/config')
const { setupSession, sessions } = require('../src/sessions')

describe('WhatsApp Web version/cache options from maintained configuration', () => {
  beforeEach(() => {
    sessions.clear()
    jest.clearAllMocks()
  })

  afterEach(() => {
    sessions.clear()
  })

  test('constructs client options from the maintained WWebJS configuration', async () => {
    const sessionId = 'cache-options-contract'
    const result = await setupSession(sessionId)
    expect(result.success).toBe(true)

    expect(mockLocalAuth).toHaveBeenCalledWith({
      clientId: sessionId,
      dataPath: config.sessionFolderPath
    })

    const options = mockClient.mock.calls[0][0]

    if (config.webVersion) {
      expect(options.webVersion).toBe(config.webVersion)
    } else {
      expect(options).not.toHaveProperty('webVersion')
    }

    switch (config.webVersionCacheType.toLowerCase()) {
      case 'local':
        expect(options.webVersionCache).toEqual({ type: 'local' })
        break
      case 'remote':
        expect(options.webVersionCache).toEqual({
          type: 'remote',
          remotePath: 'https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/{version}.html'
        })
        break
      case 'none':
      default:
        expect(options.webVersionCache).toEqual({ type: 'none' })
    }
  })
})
