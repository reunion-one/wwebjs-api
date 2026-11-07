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
jest.mock('../src/utils', () => {
  const { disabledCallbacks } = jest.requireActual('../src/config')
  return {
    triggerWebhook: (...args) => mockTriggerWebhook(...args),
    waitForNestedObject: jest.fn(async () => {}),
    isEventEnabled: jest.fn(event => !disabledCallbacks.includes(event)),
    sendMessageSeenStatus: jest.fn(),
    sleep: jest.fn(async () => {}),
    patchWWebLibrary: jest.fn(async () => {})
  }
})
jest.mock('../src/logger', () => ({ logger: mockLogger }))
jest.mock('../src/websocket', () => ({
  initWebSocketServer: jest.fn(),
  terminateWebSocketServer: jest.fn(async () => {}),
  triggerWebSocket: (...args) => mockTriggerWebSocket(...args)
}))

const { disabledCallbacks, maxAttachmentSize } = require('../src/config')
const { sessions, setupSession } = require('../src/sessions')
const messageCreateEnabled = !disabledCallbacks.includes('message_create')
const messageEnabled = !disabledCallbacks.includes('message')
const describeMessageCreate = messageCreateEnabled ? describe : describe.skip

describeMessageCreate('complete message_create canonical ingress', () => {
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
    if (messageEnabled) {
      expect(mockTriggerWebhook).toHaveBeenCalledWith(
        expect.any(String), 'primary', 'message', { message }
      )
    } else {
      expect(mockTriggerWebhook).not.toHaveBeenCalled()
    }
    expect(mockTriggerWebhook.mock.calls.some(call => call[2] === 'media')).toBe(false)
    expect(mockTriggerWebhook.mock.calls.some(call => call[2] === 'message_create')).toBe(false)
  })
})

describeMessageCreate('message_create media size boundary', () => {
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

  test('includes media whose declared size is exactly maxAttachmentSize', async () => {
    const messageMedia = {
      mimetype: 'application/pdf',
      data: Buffer.from('boundary-media').toString('base64'),
      filename: 'boundary.pdf',
      filesize: maxAttachmentSize
    }
    const message = {
      id: { id: 'boundary-media', _serialized: 'false_chat_boundary-media' },
      fromMe: false,
      hasMedia: true,
      _data: { size: maxAttachmentSize },
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
  })

  test('suppresses media one byte above maxAttachmentSize without emitting a partial canonical event', async () => {
    const message = {
      id: { id: 'oversize-media', _serialized: 'false_chat_oversize-media' },
      fromMe: false,
      hasMedia: true,
      _data: { size: maxAttachmentSize + 1 },
      downloadMedia: jest.fn(async () => ({
        mimetype: 'application/pdf',
        data: Buffer.from('oversize-media').toString('base64'),
        filename: 'oversize.pdf',
        filesize: maxAttachmentSize + 1
      }))
    }

    await mockHandlers.message_create(message)

    expect(message.downloadMedia).toHaveBeenCalledTimes(1)
    expect(mockTriggerWebhook).not.toHaveBeenCalled()
    expect(mockTriggerWebSocket).not.toHaveBeenCalled()
    expect(mockLogger.error).toHaveBeenCalledTimes(1)
  })
})
