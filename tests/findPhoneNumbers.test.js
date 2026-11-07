const request = require('supertest')


const app = require('../src/app')
const { sessions } = require('../src/sessions')
const { basePath, globalApiKey } = require('../src/config')

const basePrefix = basePath === '/' ? '' : basePath.replace(/\/$/, '')
const configuredPath = pathname => basePrefix + pathname
const configuredRequest = (method, pathname) => {
  const configured = request(app)[method](configuredPath(pathname))
  return globalApiKey ? configured.set('x-api-key', globalApiKey) : configured
}

function connectedClient(controllerEvaluate) {
  return {
    pupPage: {
      isClosed: () => false,
      evaluate: jest.fn(async (callback, text) => {
        if (callback === '1') return 1
        return controllerEvaluate(callback, text)
      })
    },
    getState: jest.fn(async () => 'CONNECTED')
  }
}

describe('POST /client/findPhoneNumbers/:sessionId', () => {
  beforeEach(() => {
    sessions.clear()
    global.window = {
      require: jest.fn((moduleName) => {
        expect(moduleName).toBe('WAWebHelpersFindPhoneNumbers')
        return {
          findPhoneNumbers: (text) => [
            { phone: '+12025550123', index: 7, canonicalPhone: '+12025550123', ignored: text },
            { phone: '+12025550123', index: 26, canonicalPhone: '+12025550123', ignored: 'extra' }
          ]
        }
      })
    }
  })

  afterEach(() => {
    sessions.clear()
    delete global.window
  })

  if (globalApiKey) {
    test.each([
      ['missing', undefined],
      ['wrong', 'intentionally-wrong-api-key']
    ])('rejects %s API credentials before session/controller execution', async (_label, credential) => {
      let configured = request(app).post(configuredPath('/client/findPhoneNumbers/session-1'))
      if (credential !== undefined) configured = configured.set('x-api-key', credential)

      const response = await configured.send({ text: 'hello' })

      expect(response.status).toBe(403)
      expect(response.body).toEqual({ success: false, error: 'Invalid API key' })
    })
  }

  test('requires an active session', async () => {
    const response = await configuredRequest('post', '/client/findPhoneNumbers/missing')
      .send({ text: 'hello' })
    expect(response.status).toBe(404)
    expect(response.body).toEqual({ success: false, error: 'session_not_found' })
  })

  test.each([undefined, null, 123, {}, []])('rejects non-string text: %p', async (text) => {
    const controllerEvaluate = jest.fn()
    sessions.set('session-1', connectedClient(controllerEvaluate))
    const response = await configuredRequest('post', '/client/findPhoneNumbers/session-1')
      .send(text === undefined ? {} : { text })

    expect(response.status).toBe(400)
    expect(response.body).toEqual({ success: false, error: 'text must be a string' })
    expect(controllerEvaluate).not.toHaveBeenCalled()
  })

  test('runs WAWebHelpersFindPhoneNumbers in page context and preserves repeated UTF-16 indexes', async () => {
    const controllerEvaluate = jest.fn(async (callback, text) => callback(text))
    sessions.set('session-1', connectedClient(controllerEvaluate))

    const text = '😀 text +12025550123 and +12025550123'
    const response = await configuredRequest('post', '/client/findPhoneNumbers/session-1')
      .send({ text })

    expect(response.status).toBe(200)
    expect(response.body).toEqual({
      success: true,
      result: [
        { phone: '+12025550123', index: 7, canonicalPhone: '+12025550123' },
        { phone: '+12025550123', index: 26, canonicalPhone: '+12025550123' }
      ]
    })
    expect(controllerEvaluate).toHaveBeenCalledTimes(1)
    expect(controllerEvaluate.mock.calls[0][1]).toBe(text)
    expect(global.window.require).toHaveBeenCalledWith('WAWebHelpersFindPhoneNumbers')
  })

  test('turns page-evaluate failure into the standard 500 response', async () => {
    sessions.set('session-1', connectedClient(async () => {
      throw new Error('page parser unavailable')
    }))

    const response = await configuredRequest('post', '/client/findPhoneNumbers/session-1')
      .send({ text: 'hello' })

    expect(response.status).toBe(500)
    expect(response.body.success).toBe(false)
  })
})
