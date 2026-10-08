jest.mock('axios', () => ({ post: jest.fn() }))
jest.mock('../src/config', () => ({
  globalApiKey: 'test-key',
  disabledCallbacks: [],
  enableWebHook: true
}))
jest.mock('../src/logger', () => ({
  logger: {
    debug: jest.fn(),
    error: jest.fn(),
    warn: jest.fn()
  }
}))
jest.mock('whatsapp-web.js', () => ({ Client: class Client {} }))
jest.mock('whatsapp-web.js/src/factories/ChatFactory', () => ({ create: jest.fn() }))
jest.mock('whatsapp-web.js/src/structures', () => ({
  Chat: class Chat {},
  Message: class Message {}
}))
jest.mock('whatsapp-web.js/src/util/Constants', () => ({
  Events: { DISCONNECTED: 'disconnected' }
}))

const axios = require('axios')
const { triggerWebhook } = require('../src/utils')

const sendCallback = () => triggerWebhook(
  'http://127.0.0.1:8000/whatsapp-webhook',
  'primary',
  'message_create',
  { id: 'message-1' }
)

describe('triggerWebhook bounded delivery retry', () => {
  beforeEach(() => {
    axios.post.mockReset()
  })

  test('retries transient local delivery failures at most three attempts', async () => {
    const error = Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' })
    axios.post.mockRejectedValue(error)

    await sendCallback()

    expect(axios.post).toHaveBeenCalledTimes(3)
  })

  test('retries HTTP 5xx and stops immediately after a successful acknowledgement', async () => {
    axios.post
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ status: 200 })

    await sendCallback()

    expect(axios.post).toHaveBeenCalledTimes(2)
  })

  test('does not retry deterministic HTTP 4xx rejection', async () => {
    axios.post.mockRejectedValue({ response: { status: 400 } })

    await sendCallback()

    expect(axios.post).toHaveBeenCalledTimes(1)
  })

  test('a successful durable-inbox acknowledgement has no producer-side replay', async () => {
    axios.post.mockResolvedValue({ status: 200 })

    await sendCallback()

    expect(axios.post).toHaveBeenCalledTimes(1)
  })
})
