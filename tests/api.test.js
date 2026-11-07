const request = require('supertest')


jest.mock('../src/sessions', () => ({
  sessions: new Map(),
  initializingSessions: new Map(),
  setupSession: jest.fn(),
  deleteSession: jest.fn(),
  reloadSession: jest.fn(),
  validateSession: jest.fn(),
  validateSendSession: jest.fn(),
  flushSessions: jest.fn(),
  destroySession: jest.fn()
}))

const sessionsModule = require('../src/sessions')
const { basePath, globalApiKey } = require('../src/config')
const app = require('../src/app')

const basePrefix = basePath === '/' ? '' : basePath.replace(/\/$/, '')
const configuredPath = pathname => basePrefix + pathname
const configuredRequest = (method, pathname) => {
  const configured = request(app)[method](configuredPath(pathname))
  return globalApiKey ? configured.set('x-api-key', globalApiKey) : configured
}

beforeEach(() => {
  sessionsModule.sessions.clear()
  sessionsModule.initializingSessions.clear()
  jest.clearAllMocks()
  sessionsModule.validateSession.mockResolvedValue({
    success: false,
    state: null,
    message: 'session_not_found'
  })
  sessionsModule.validateSendSession.mockResolvedValue({
    success: false,
    state: null,
    message: 'session_not_found'
  })
})

if (globalApiKey) {
  describe('API authentication under maintained configuration', () => {
    it.each([
      ['missing', undefined],
      ['wrong', 'intentionally-wrong-api-key']
    ])('rejects %s API credentials before lifecycle code', async (_label, credential) => {
      let configured = request(app).get(configuredPath('/session/start/unit-test'))
      if (credential !== undefined) configured = configured.set('x-api-key', credential)

      const response = await configured

      expect(response.status).toBe(403)
      expect(response.body).toEqual({ success: false, error: 'Invalid API key' })
      expect(sessionsModule.setupSession).not.toHaveBeenCalled()
    })
  })
}

describe('API health checks', () => {
  it('returns the in-process ping contract without binding a listener', async () => {
    const response = await configuredRequest('get', '/ping')
    expect(response.status).toBe(200)
    expect(response.body).toEqual({ message: 'pong', success: true })
  })
})

describe('API session route/controller contracts with mocked lifecycle boundaries', () => {
  it('rejects invalid sessionId before touching lifecycle code', async () => {
    const response = await configuredRequest('get', '/session/start/ABCD1@')

    expect(response.status).toBe(422)
    expect(response.body).toEqual({
      success: false,
      error: 'Session should be alphanumerical or -'
    })
    expect(sessionsModule.setupSession).not.toHaveBeenCalled()
  })

  it('maps successful setupSession to the public start response', async () => {
    sessionsModule.setupSession.mockResolvedValue({
      success: true,
      message: 'Session initiated successfully',
      client: { pupPage: {} }
    })

    const response = await configuredRequest('get', '/session/start/unit-test')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      message: 'Session initiated successfully'
    })
    expect(sessionsModule.setupSession).toHaveBeenCalledWith('unit-test')
  })

  it('maps setupSession rejection to the public 422 response', async () => {
    sessionsModule.setupSession.mockResolvedValue({
      success: false,
      message: 'mock setup failure',
      client: null
    })

    const response = await configuredRequest('get', '/session/start/unit-test')

    expect(response.status).toBe(422)
    expect(response.body).toEqual({ success: false, error: 'mock setup failure' })
  })

  it('delegates stop to destroySession without owning a browser', async () => {
    sessionsModule.destroySession.mockResolvedValue(undefined)

    const response = await configuredRequest('get', '/session/stop/unit-test')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      message: 'Session stopped successfully'
    })
    expect(sessionsModule.destroySession).toHaveBeenCalledWith('unit-test')
  })

  it('returns the validateSession status result unchanged', async () => {
    sessionsModule.validateSession.mockResolvedValue({
      success: true,
      state: 'CONNECTED',
      message: 'session_connected'
    })

    const response = await configuredRequest('get', '/session/status/unit-test')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      state: 'CONNECTED',
      message: 'session_connected'
    })
  })

  it('returns mocked in-memory session names', async () => {
    sessionsModule.sessions.set('one', {})
    sessionsModule.sessions.set('two', {})

    const response = await configuredRequest('get', '/session/getSessions')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true, result: ['one', 'two'] })
  })

  it('serves QR from a session that is still initializing', async () => {
    sessionsModule.initializingSessions.set('unit-test', { qr: 'test-qr-value' })

    const response = await configuredRequest('get', '/session/qr/unit-test')

    expect(response.status).toBe(200)
    expect(response.body).toEqual({ success: true, qr: 'test-qr-value' })
  })

  it('returns session_not_found for read-only QR/status-like routes with no session', async () => {
    const qr = await configuredRequest('get', '/session/qr/nonexistent')
    expect(qr.status).toBe(200)
    expect(qr.body).toEqual({ success: false, message: 'session_not_found' })

    const screenshot = await configuredRequest('get', '/session/getPageScreenshot/nonexistent')
    expect(screenshot.status).toBe(200)
    expect(screenshot.body).toEqual({ success: false, message: 'session_not_found' })
  })

  it('delegates inactive/all flush operations to the mocked lifecycle boundary', async () => {
    sessionsModule.flushSessions.mockResolvedValue(undefined)

    const inactive = await configuredRequest('get', '/session/terminateInactive')
    expect(inactive.status).toBe(200)
    expect(inactive.body).toEqual({ success: true, message: 'Flush completed successfully' })
    expect(sessionsModule.flushSessions).toHaveBeenNthCalledWith(1, true)

    const all = await configuredRequest('get', '/session/terminateAll')
    expect(all.status).toBe(200)
    expect(all.body).toEqual({ success: true, message: 'Flush completed successfully' })
    expect(sessionsModule.flushSessions).toHaveBeenNthCalledWith(2, false)
  })
})

describe('Send route readiness boundary', () => {
  it.each([
    ['/client/sendMessage/unit-test', { chatId: '123@c.us', contentType: 'string', content: 'hello' }],
    ['/message/reply/unit-test', { chatId: '123@c.us', messageId: 'message-id', content: 'hello' }],
    ['/channel/sendMessage/unit-test', { chatId: '123@c.us', contentType: 'string', content: 'hello' }]
  ])('uses send-session readiness for %s', async (pathname, body) => {
    sessionsModule.validateSendSession.mockResolvedValue({
      success: false,
      state: 'CONNECTED',
      message: 'session_send_not_ready'
    })

    const response = await configuredRequest('post', pathname).send(body)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ success: false, error: 'session_send_not_ready' })
    expect(sessionsModule.validateSendSession).toHaveBeenCalledWith('unit-test')
    expect(sessionsModule.validateSession).not.toHaveBeenCalled()
  })
})

describe('Session validation - 404 for non-existent session', () => {
  it.each([
    ['GET', '/client/getContacts/nonexistent'],
    ['POST', '/client/sendMessage/nonexistent'],
    ['POST', '/chat/getClassInfo/nonexistent'],
    ['POST', '/chat/fetchMessages/nonexistent'],
    ['POST', '/groupChat/getClassInfo/nonexistent'],
    ['POST', '/groupChat/leave/nonexistent'],
    ['POST', '/message/getClassInfo/nonexistent'],
    ['POST', '/message/react/nonexistent'],
    ['POST', '/contact/getClassInfo/nonexistent'],
    ['POST', '/contact/getAbout/nonexistent'],
    ['POST', '/channel/getClassInfo/nonexistent'],
    ['POST', '/channel/sendMessage/nonexistent']
  ])('%s %s returns 404 session_not_found', async (method, url) => {
    const response = await configuredRequest(method.toLowerCase(), url)

    expect(response.status).toBe(404)
    expect(response.body).toEqual({ success: false, error: 'session_not_found' })
  })
})
