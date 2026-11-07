const clientController = require('../src/controllers/clientController')
const messageController = require('../src/controllers/messageController')
const { sessions } = require('../src/sessions')

function responseDouble () {
  const res = {
    json: jest.fn(),
    status: jest.fn()
  }
  res.status.mockImplementation(() => res)
  return res
}

describe('production-consumed WWebJS controller success contracts', () => {
  afterEach(() => {
    sessions.clear()
    delete global.window
  })

  test('getHistorySyncState returns the page readiness fields COMM consumes', async () => {
    global.window = {
      WWebJS: {},
      require: name => {
        if (name === 'WAWebSocketModel') {
          return { Socket: { hasSynced: true, state: 'CONNECTED' } }
        }
        if (name === 'WAWebBackendEventBus') {
          return { BackendEventBus: { isOfflineDeliveryEnd: true } }
        }
        if (name === 'WAWebOfflineHandler') {
          return {
            OfflineMessageHandler: {
              isResumeComplete: () => true,
              getHasMessagesToDownload: () => false,
              getOfflineDeliveryProgress: () => 100
            }
          }
        }
        throw new Error(`Unexpected module: ${name}`)
      }
    }
    const evaluate = jest.fn(async fn => await fn())
    sessions.set('test', { pupPage: { evaluate } })
    const res = responseDouble()

    await clientController.getHistorySyncState({ params: { sessionId: 'test' } }, res)

    expect(evaluate).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({
      success: true,
      state: {
        ready: true,
        hasSynced: true,
        connectionState: 'CONNECTED',
        isOfflineDeliveryEnd: true,
        isResumeComplete: true,
        hasMessagesToDownload: false,
        offlineProgress: 100
      }
    })
  })

  test('POST getChats forwards searchOptions and preserves chat response shape', async () => {
    const chats = [{ id: { _serialized: 'chat-1@g.us' }, timestamp: 123 }]
    const getChats = jest.fn(async () => chats)
    sessions.set('test', { getChats })
    const res = responseDouble()

    await clientController.getChatsWithSearch(
      {
        params: { sessionId: 'test' },
        body: { searchOptions: { since: 100, unread: true } }
      },
      res
    )

    expect(getChats).toHaveBeenCalledWith({ since: 100, unread: true })
    expect(res.json).toHaveBeenCalledWith({ success: true, chats })
  })

  test('getNumberId forwards the requested number and preserves nullable result shape', async () => {
    const result = { _serialized: '15550100123@c.us', user: '15550100123' }
    const getNumberId = jest.fn(async () => result)
    sessions.set('test', { getNumberId })
    const res = responseDouble()

    await clientController.getNumberId(
      { params: { sessionId: 'test' }, body: { number: '15550100123' } },
      res
    )

    expect(getNumberId).toHaveBeenCalledWith('15550100123')
    expect(res.json).toHaveBeenCalledWith({ success: true, result })
  })

  test('getChatById forwards provider identity and preserves the chat object', async () => {
    const chat = { id: { _serialized: 'group-fixture@g.us' }, isGroup: true }
    const getChatById = jest.fn(async () => chat)
    sessions.set('test', { getChatById })
    const res = responseDouble()

    await clientController.getChatById(
      { params: { sessionId: 'test' }, body: { chatId: 'group-fixture@g.us' } },
      res
    )

    expect(getChatById).toHaveBeenCalledWith('group-fixture@g.us')
    expect(res.json).toHaveBeenCalledWith({ success: true, chat })
  })

  test('downloadMedia finds the exact message and returns provider media unchanged', async () => {
    const messageMedia = {
      mimetype: 'application/pdf',
      data: 'cHJvdmlkZXItYnl0ZXM=',
      filename: 'statement.pdf',
      filesize: 14
    }
    const message = {
      hasMedia: true,
      downloadMedia: jest.fn(async () => messageMedia)
    }
    const fetchMessages = jest.fn(async () => [message])
    const getChatById = jest.fn(async () => ({ fetchMessages }))
    sessions.set('test', { getChatById })
    const res = responseDouble()

    await messageController.downloadMedia(
      {
        params: { sessionId: 'test' },
        body: { chatId: 'chat-fixture@c.us', messageId: 'provider-message-1' }
      },
      res
    )

    expect(getChatById).toHaveBeenCalledWith('chat-fixture@c.us')
    expect(fetchMessages).toHaveBeenCalledWith({ messageId: 'provider-message-1', limit: 1 })
    expect(message.downloadMedia).toHaveBeenCalledTimes(1)
    expect(res.json).toHaveBeenCalledWith({ success: true, messageMedia })
  })

  test('sendMessage forwards mentions/media options, waits for acceptance, and returns provider identity', async () => {
    const providerMessage = { id: { id: 'provider-send-1' }, fromMe: true }
    const sendMessage = jest.fn(async () => providerMessage)
    sessions.set('test', { sendMessage })
    const res = responseDouble()
    const mentions = ['15550100123@c.us']

    await clientController.sendMessage(
      {
        params: { sessionId: 'test' },
        body: {
          chatId: 'group-fixture@g.us',
          contentType: 'MessageMedia',
          content: {
            mimetype: 'application/pdf',
            data: 'cHJvdmlkZXItYnl0ZXM=',
            filename: 'statement.pdf',
            filesize: 14
          },
          options: { mentions, sendMediaAsDocument: true }
        }
      },
      res
    )

    expect(sendMessage).toHaveBeenCalledTimes(1)
    const [chatId, media, options] = sendMessage.mock.calls[0]
    expect(chatId).toBe('group-fixture@g.us')
    expect(media).toMatchObject({
      mimetype: 'application/pdf',
      data: 'cHJvdmlkZXItYnl0ZXM=',
      filename: 'statement.pdf',
      filesize: 14
    })
    expect(options).toEqual({
      waitUntilMsgSent: true,
      mentions,
      sendMediaAsDocument: true
    })
    expect(options.mentions).toBe(mentions)
    expect(res.json).toHaveBeenCalledWith({ success: true, message: providerMessage })
  })

  test('reply resolves the exact parent and forwards mention/media options unchanged', async () => {
    const repliedMessage = { id: { id: 'provider-reply-1' }, fromMe: true }
    const reply = jest.fn(async () => repliedMessage)
    const fetchMessages = jest.fn(async () => [{ reply }])
    const getChatById = jest.fn(async () => ({ fetchMessages }))
    sessions.set('test', { getChatById })
    const res = responseDouble()
    const mentions = ['15550100123@c.us']
    const options = { mentions, sendMediaAsDocument: true }

    await messageController.reply(
      {
        params: { sessionId: 'test' },
        body: {
          chatId: 'group-fixture@g.us',
          messageId: 'provider-parent-1',
          contentType: 'MessageMedia',
          content: {
            mimetype: 'application/pdf',
            data: 'cHJvdmlkZXItYnl0ZXM=',
            filename: 'statement.pdf',
            filesize: 14
          },
          options
        }
      },
      res
    )

    expect(getChatById).toHaveBeenCalledWith('group-fixture@g.us')
    expect(fetchMessages).toHaveBeenCalledWith({ messageId: 'provider-parent-1', limit: 1 })
    expect(reply).toHaveBeenCalledTimes(1)
    const [media, destinationChatId, forwardedOptions] = reply.mock.calls[0]
    expect(destinationChatId).toBe('group-fixture@g.us')
    expect(media).toMatchObject({
      mimetype: 'application/pdf',
      data: 'cHJvdmlkZXItYnl0ZXM=',
      filename: 'statement.pdf',
      filesize: 14
    })
    expect(forwardedOptions).toBe(options)
    expect(forwardedOptions.mentions).toBe(mentions)
    expect(res.json).toHaveBeenCalledWith({ success: true, repliedMessage })
  })
})
