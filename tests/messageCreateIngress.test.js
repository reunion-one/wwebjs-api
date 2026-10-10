const packageJson = require('../package.json')
const packageLock = require('../package-lock.json')
const { emitCanonicalMessageCreate } = require('../src/messageCreateIngress')

const UPSTREAM_SHA = '064a3d5a5a3dce1281a6a12740b5a7051339d154'
const HTTPS_DEPENDENCY =
  `git+https://github.com/wwebjs/whatsapp-web.js.git#${UPSTREAM_SHA}`

const setup = () => ({
  triggerWebhook: jest.fn(async () => undefined),
  triggerWebSocket: jest.fn(),
  logger: { error: jest.fn() }
})

const mediaMessage = (fromMe, bytes = Buffer.from('fixture-media')) => ({
  id: { id: fromMe ? 'outbound-media' : 'inbound-media', fromMe },
  fromMe,
  hasMedia: true,
  downloadMedia: jest.fn(async () => ({
    mimetype: 'image/png',
    data: bytes.toString('base64'),
    filename: 'fixture.png'
  }))
})

describe('complete message_create ingress', () => {
  test.each([false, true])(
    'acquires media before one complete message_create callback (fromMe=%s)',
    async fromMe => {
      const runtime = setup()
      const message = mediaMessage(fromMe)

      const emitted = await emitCanonicalMessageCreate({
        message,
        sessionId: 'primary',
        sessionWebhook: 'http://127.0.0.1/webhook',
        maxAttachmentSize: 10_000,
        ...runtime
      })

      expect(emitted).toBe(true)
      expect(message.downloadMedia).toHaveBeenCalledTimes(1)
      expect(runtime.triggerWebhook).toHaveBeenCalledTimes(1)
      const webhookData = runtime.triggerWebhook.mock.calls[0][3]
      expect(webhookData.message).toBe(message)
      expect(webhookData.messageMedia.data).toBeTruthy()
      expect(runtime.triggerWebSocket).toHaveBeenCalledWith(
        'primary',
        'message_create',
        webhookData
      )
      expect(message.downloadMedia.mock.invocationCallOrder[0])
        .toBeLessThan(runtime.triggerWebhook.mock.invocationCallOrder[0])
    }
  )

  test('downloadMedia failure emits no partial event', async () => {
    const runtime = setup()
    const message = mediaMessage(false)
    message.downloadMedia.mockRejectedValueOnce(new Error('media unavailable'))

    const emitted = await emitCanonicalMessageCreate({
      message,
      sessionId: 'primary',
      sessionWebhook: 'http://127.0.0.1/webhook',
      maxAttachmentSize: 10_000,
      ...runtime
    })

    expect(emitted).toBe(false)
    expect(runtime.triggerWebhook).not.toHaveBeenCalled()
    expect(runtime.triggerWebSocket).not.toHaveBeenCalled()
    expect(runtime.logger.error).toHaveBeenCalledTimes(1)
  })

  test.each([
    undefined,
    null,
    { data: '' },
    { data: 'not-base64' },
    { data: Buffer.alloc(8).toString('base64') }
  ])('unusable media payload %p emits no partial event', async messageMedia => {
    const runtime = setup()
    const message = mediaMessage(false)
    message.downloadMedia.mockResolvedValueOnce(messageMedia)

    const emitted = await emitCanonicalMessageCreate({
      message,
      sessionId: 'primary',
      sessionWebhook: 'http://127.0.0.1/webhook',
      maxAttachmentSize: 8,
      ...runtime
    })

    expect(emitted).toBe(false)
    expect(runtime.triggerWebhook).not.toHaveBeenCalled()
    expect(runtime.triggerWebSocket).not.toHaveBeenCalled()
  })

  test('non-media message_create emits directly without downloadMedia', async () => {
    const runtime = setup()
    const message = {
      id: { id: 'plain-message', fromMe: false },
      fromMe: false,
      hasMedia: false,
      downloadMedia: jest.fn()
    }

    const emitted = await emitCanonicalMessageCreate({
      message,
      sessionId: 'primary',
      sessionWebhook: 'http://127.0.0.1/webhook',
      maxAttachmentSize: 10_000,
      ...runtime
    })

    expect(emitted).toBe(true)
    expect(message.downloadMedia).not.toHaveBeenCalled()
    expect(runtime.triggerWebhook).toHaveBeenCalledWith(
      'http://127.0.0.1/webhook',
      'primary',
      'message_create',
      { message }
    )
  })

  test('public upstream pin uses HTTPS at the exact reviewed SHA', () => {
    expect(packageJson.dependencies['whatsapp-web.js']).toBe(HTTPS_DEPENDENCY)
    expect(packageLock.packages[''].dependencies['whatsapp-web.js']).toBe(
      HTTPS_DEPENDENCY
    )
    expect(packageLock.packages['node_modules/whatsapp-web.js'].resolved).toBe(
      HTTPS_DEPENDENCY
    )
    expect(JSON.stringify(packageLock)).not.toContain(
      'git+ssh://git@github.com/wwebjs/whatsapp-web.js.git'
    )
  })
})
