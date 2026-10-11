const mockHandlers = {}
const mockTriggerWebhook = jest.fn()
const mockTriggerWebSocket = jest.fn()
const mockLogger = { debug: jest.fn(), error: jest.fn(), warn: jest.fn(), info: jest.fn() }
const mockClient = {
  on: jest.fn((event, handler) => { mockHandlers[event] = handler }),
  once: jest.fn((event, handler) => { mockHandlers[event] = handler }),
  initialize: jest.fn(async () => {}),
  qr: null
}

jest.mock('whatsapp-web.js', () => ({
  Client: jest.fn(() => mockClient),
  LocalAuth: jest.fn(() => ({ logout: jest.fn() }))
}))
jest.mock('../src/config', () => ({
  baseWebhookURL: 'http://127.0.0.1:8000/whatsapp-webhook',
  sessionFolderPath: './sessions_test',
  maxAttachmentSize: 10000000,
  setMessagesAsSeen: false,
  webVersion: null,
  webVersionCacheType: 'none',
  recoverSessions: false,
  chromeBin: undefined,
  headless: true,
  releaseBrowserLock: false,
  proxyUrl: null,
  proxyUsername: null,
  proxyPassword: null
}))
jest.mock('../src/utils', () => ({
  triggerWebhook: (...args) => mockTriggerWebhook(...args),
  waitForNestedObject: jest.fn(async () => {}),
  isEventEnabled: jest.fn(() => true),
  sendMessageSeenStatus: jest.fn(),
  sleep: jest.fn(async () => {}),
  patchWWebLibrary: jest.fn(async () => {})
}))
jest.mock('../src/logger', () => ({ logger: mockLogger }))
jest.mock('../src/websocket', () => ({
  initWebSocketServer: jest.fn(),
  terminateWebSocketServer: jest.fn(async () => {}),
  triggerWebSocket: (...args) => mockTriggerWebSocket(...args)
}))

const { sessions, setupSession } = require('../src/sessions')

describe('complete message_create canonical ingress', () => {
  beforeEach(async () => {
    sessions.clear()
    Object.keys(mockHandlers).forEach(key => delete mockHandlers[key])
    mockClient.on.mockClear()
    mockClient.once.mockClear()
    mockClient.initialize.mockClear()
    mockTriggerWebhook.mockClear()
    mockTriggerWebSocket.mockClear()
    mockLogger.error.mockClear()

    const result = await setupSession('primary')
    expect(result.success).toBe(true)
    expect(typeof mockHandlers.message_create).toBe('function')
  })

  afterEach(() => sessions.clear())

  test('emits a non-media create once without waiting for media', async () => {
    const message = {
      id: { id: 'text-1', _serialized: 'false_chat_text-1' },
      fromMe: false,
      hasMedia: false,
      downloadMedia: jest.fn()
    }
    await mockHandlers.message_create(message)
    expect(message.downloadMedia).not.toHaveBeenCalled()
    expect(mockTriggerWebhook).toHaveBeenCalledWith(
      expect.any(String), 'primary', 'message_create', { message }
    )
    expect(mockTriggerWebSocket).toHaveBeenCalledWith(
      'primary', 'message_create', { message }
    )
  })

  test.each([false, true])(
    'awaits and embeds usable media before emitting message_create (fromMe=%s)',
    async (fromMe) => {
      const messageMedia = {
        mimetype: 'application/pdf',
        data: Buffer.from('provider-bytes').toString('base64'),
        filename: 'statement.pdf',
        filesize: 14
      }
      const message = {
        id: { id: 'media-1', _serialized: `${fromMe}_chat_media-1` },
        fromMe,
        hasMedia: true,
        _data: { size: 14 },
        downloadMedia: jest.fn(async () => messageMedia)
      }
      await mockHandlers.message_create(message)
      expect(message.downloadMedia).toHaveBeenCalledTimes(1)
      expect(mockTriggerWebhook).toHaveBeenCalledWith(
        expect.any(String), 'primary', 'message_create', { message, messageMedia }
      )
      expect(mockTriggerWebSocket).toHaveBeenCalledWith(
        'primary', 'message_create', { message, messageMedia }
      )
    }
  )

  test('download failure produces no partial canonical event', async () => {
    const message = {
      id: { id: 'failed-media' },
      fromMe: false,
      hasMedia: true,
      downloadMedia: jest.fn(async () => { throw new Error('download unavailable') })
    }
    await mockHandlers.message_create(message)
    expect(mockTriggerWebhook).not.toHaveBeenCalled()
    expect(mockTriggerWebSocket).not.toHaveBeenCalled()
    expect(mockLogger.error).toHaveBeenCalledTimes(1)
  })

  test('unusable downloaded media produces no partial canonical event', async () => {
    const message = {
      id: { id: 'empty-media' },
      fromMe: true,
      hasMedia: true,
      downloadMedia: jest.fn(async () => ({
        mimetype: 'image/png', data: '', filename: 'empty.png'
      }))
    }
    await mockHandlers.message_create(message)
    expect(mockTriggerWebhook).not.toHaveBeenCalled()
    expect(mockTriggerWebSocket).not.toHaveBeenCalled()
  })

  test('ordinary message callback never downloads or emits legacy media', async () => {
    const message = {
      id: { id: 'ordinary-media' },
      hasMedia: true,
      _data: { size: 10 },
      downloadMedia: jest.fn()
    }
    await mockHandlers.message(message)
    expect(message.downloadMedia).not.toHaveBeenCalled()
    expect(mockTriggerWebhook).toHaveBeenCalledWith(
      expect.any(String), 'primary', 'message', { message }
    )
    expect(mockTriggerWebhook.mock.calls.some(call => call[2] === 'media')).toBe(false)
    expect(mockTriggerWebhook.mock.calls.some(call => call[2] === 'message_create')).toBe(false)
  })
})
