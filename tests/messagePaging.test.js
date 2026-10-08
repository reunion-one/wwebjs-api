const { Chat } = require('whatsapp-web.js/src/structures')
const chatController = require('../src/controllers/chatController')
const { sessions } = require('../src/sessions')
require('../src/utils')

const message = (timestamp, id) => ({
  id: { id },
  isNotification: false,
  t: timestamp
})

test('seeks without returning messages, then returns bounded pages', async () => {
  expect(typeof Chat.prototype.fetchMessagesPage).toBe('function')
  let models = [message(300, 'm300'), message(290, 'm290')]
  const batches = [
    [message(280, 'm280'), message(270, 'm270')],
    [message(110, 'm110'), message(100, 'cursor')],
    [message(99, 'm99'), message(98, 'm98'), message(97, 'm97')],
    [message(97, 'm97')]
  ]
  let loadCalls = 0
  global.window = {
    WWebJS: {
      getChat: async () => ({
        msgs: { getModelsArray: () => models }
      }),
      getMessageModel: item => ({ id: item.id, timestamp: item.t })
    },
    require: name => {
      if (name === 'WAWebChatLoadMessages') {
        return {
          loadEarlierMsgs: async () => {
            loadCalls++
            const batch = batches.shift()
            models = [...models, ...batch]
            return batch
          }
        }
      }
      throw new Error(`Unexpected module: ${name}`)
    }
  }

  const pupPage = { evaluate: async (fn, ...args) => await fn(...args) }
  const chat = { client: { pupPage }, id: { _serialized: 'chat@g.us' } }
  const options = {
    lowerTimestamp: 1,
    upperTimestamp: 400,
    before: { timestamp: 100, messageId: 'cursor' },
    pageSize: 2
  }

  const seeking = await Chat.prototype.fetchMessagesPage.call(chat, options)
  expect(seeking).toMatchObject({ state: 'SEEKING', messages: [] })
  expect(loadCalls).toBe(1)

  const positioned = await Chat.prototype.fetchMessagesPage.call(chat, options)
  expect(positioned).toMatchObject({ state: 'POSITIONED', messages: [] })
  expect(loadCalls).toBe(2)

  const page = await Chat.prototype.fetchMessagesPage.call(chat, options)
  expect(page).toMatchObject({
    state: 'PAGE',
    done: false,
    nextBefore: { timestamp: 98, messageId: 'm98' }
  })
  expect(page.messages.map(item => item.id.id)).toEqual(['m99', 'm98'])
  expect(loadCalls).toBe(3)

  const finalPage = await Chat.prototype.fetchMessagesPage.call(chat, {
    ...options,
    before: page.nextBefore
  })
  expect(finalPage).toMatchObject({
    state: 'PAGE',
    done: true,
    reason: 'end_of_local_history'
  })
  expect(finalPage.messages.map(item => item.id.id)).toEqual(['m97'])
  expect(loadCalls).toBe(4)

  delete global.window
})

test('returns the latest bounded page when time bounds and cursor are omitted', async () => {
  const models = [message(300, 'm300'), message(290, 'm290'), message(280, 'm280')]
  global.window = {
    WWebJS: {
      getChat: async () => ({ msgs: { getModelsArray: () => models } }),
      getMessageModel: item => ({ id: item.id, timestamp: item.t })
    },
    require: name => {
      if (name === 'WAWebChatLoadMessages') {
        return { loadEarlierMsgs: async () => [] }
      }
      throw new Error(`Unexpected module: ${name}`)
    }
  }

  const pupPage = { evaluate: async (fn, ...args) => await fn(...args) }
  const chat = { client: { pupPage }, id: { _serialized: 'chat@g.us' } }
  const result = await Chat.prototype.fetchMessagesPage.call(chat, { pageSize: 2 })

  expect(result).toMatchObject({
    state: 'PAGE',
    done: false,
    nextBefore: { timestamp: 290, messageId: 'm290' }
  })
  expect(result.messages.map(item => item.id.id)).toEqual(['m300', 'm290'])
  delete global.window
})

test('REST endpoint treats all paging controls as optional', async () => {
  const fetchMessagesPage = jest.fn(async options => ({
    state: 'PAGE',
    messages: [],
    options
  }))
  sessions.set('test', {
    getChatById: async () => ({ fetchMessagesPage })
  })
  const json = jest.fn()
  const res = { json, status: jest.fn(() => res) }

  await chatController.fetchMessagesPage(
    { body: { chatId: 'chat@g.us' }, params: { sessionId: 'test' } },
    res
  )

  expect(fetchMessagesPage).toHaveBeenCalledWith({
    lowerTimestamp: 0,
    upperTimestamp: Number.MAX_SAFE_INTEGER,
    before: null,
    pageSize: 200
  })
  expect(json).toHaveBeenCalledWith(expect.objectContaining({
    success: true,
    state: 'PAGE'
  }))
  sessions.delete('test')
})
