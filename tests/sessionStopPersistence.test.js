const fs = require('fs')
const os = require('os')
const path = require('path')

const mockSessionRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wwebjs-stop-persistence-'))

jest.mock('whatsapp-web.js', () => ({
  Client: jest.fn(),
  LocalAuth: jest.fn()
}))

jest.mock('../src/config', () => ({
  baseWebhookURL: '',
  sessionFolderPath: mockSessionRoot,
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

const mockTerminateWebSocketServer = jest.fn(async () => {})
jest.mock('../src/websocket', () => ({
  initWebSocketServer: jest.fn(),
  terminateWebSocketServer: mockTerminateWebSocketServer,
  triggerWebSocket: jest.fn()
}))

const {
  sessions,
  initializingSessions,
  destroySession,
  deleteSession
} = require('../src/sessions')

const makeClient = () => ({
  pupPage: {
    removeAllListeners: jest.fn()
  },
  pupBrowser: {
    isConnected: jest.fn(() => false)
  },
  destroy: jest.fn(async () => {}),
  logout: jest.fn(async () => {})
})

const createSessionDir = sessionId => {
  const dir = path.join(mockSessionRoot, `session-${sessionId}`)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'auth-marker'), 'persisted-auth\n')
  return dir
}

describe('session stop versus terminate persistence', () => {
  beforeEach(() => {
    sessions.clear()
    initializingSessions.clear()
    jest.clearAllMocks()
    for (const entry of fs.readdirSync(mockSessionRoot)) {
      fs.rmSync(path.join(mockSessionRoot, entry), { recursive: true, force: true })
    }
  })

  afterAll(() => {
    fs.rmSync(mockSessionRoot, { recursive: true, force: true })
  })

  test('destroySession stops the browser but preserves the LocalAuth directory for reconnect', async () => {
    const dir = createSessionDir('persistent')
    const client = makeClient()
    sessions.set('persistent', client)

    await destroySession('persistent')

    expect(client.destroy).toHaveBeenCalledTimes(1)
    expect(client.logout).not.toHaveBeenCalled()
    expect(mockTerminateWebSocketServer).toHaveBeenCalledWith('persistent')
    expect(sessions.has('persistent')).toBe(false)
    expect(initializingSessions.has('persistent')).toBe(false)
    expect(fs.existsSync(dir)).toBe(true)
    expect(fs.readFileSync(path.join(dir, 'auth-marker'), 'utf8')).toBe('persisted-auth\n')
  })

  test('deleteSession is the destructive logout path and removes the LocalAuth directory', async () => {
    const dir = createSessionDir('terminated')
    const client = makeClient()
    sessions.set('terminated', client)

    await deleteSession('terminated', {
      success: true,
      state: 'CONNECTED',
      message: 'session_connected'
    })

    expect(client.logout).toHaveBeenCalledTimes(1)
    expect(client.destroy).not.toHaveBeenCalled()
    expect(mockTerminateWebSocketServer).toHaveBeenCalledWith('terminated')
    expect(sessions.has('terminated')).toBe(false)
    expect(fs.existsSync(dir)).toBe(false)
  })
})
