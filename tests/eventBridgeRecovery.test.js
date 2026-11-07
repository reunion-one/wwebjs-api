'use strict'

const { Client } = require('whatsapp-web.js')
const { Events } = require('whatsapp-web.js/src/util/Constants')

class Emitter {
  constructor() {
    this.handlers = new Map()
    this.hasSynced = true
    this.state = 'CONNECTED'
  }

  on(event, handler) {
    const handlers = this.handlers.get(event) || []
    handlers.push(handler)
    this.handlers.set(event, handlers)
    return this
  }

  off(event, handler) {
    if (!this.handlers.has(event)) return this
    this.handlers.set(
      event,
      this.handlers.get(event).filter(candidate => candidate !== handler)
    )
    return this
  }

  listenerCount(event) {
    return (this.handlers.get(event) || []).length
  }
}

class Handle {
  constructor(value) {
    this.value = value
  }

  async jsonValue() {
    return this.value
  }
}

test('restored session reinjects after partial event attachment without duplicate Msg.add listeners', async () => {
  const Socket = new Emitter()
  const Cmd = new Emitter()
  const Msg = new Emitter()
  const Chat = new Emitter()
  const gatingUtils = {}

  const state = {
    failedOnce: false,
    exposedNames: [],
    readyCount: 0,
    frameHandler: null
  }

  const fakeWindow = {
    Debug: { VERSION: 'test' },
    WWebJS: undefined,
    require(name) {
      if (name === 'WAWebSocketModel') return { Socket }
      if (name === 'WAWebCmd') return { Cmd }
      if (name === 'WAWebCollections') return { Msg, Chat }
      if (name === 'WAWebSyncGatingUtils') return gatingUtils
      if (name === 'WAWebConnModel') return { Conn: new Emitter() }
      if (name === 'WAWebCallCollection') return null
      throw new Error('Unexpected window.require: ' + name)
    }
  }

  const withWindow = async (fn, args = []) => {
    const oldWindow = global.window
    global.window = fakeWindow
    try {
      return await fn(...args)
    } finally {
      global.window = oldWindow
    }
  }

  const page = {
    async waitForFunction(predicate) {
      if (typeof predicate === 'string') return new Handle(true)
      return new Handle(await withWindow(predicate))
    },

    async evaluate(fn, ...args) {
      const source = String(fn)

      if (source.includes('window.WWebJS = {}')) {
        fakeWindow.WWebJS = {
          injectToFunction() {},
          getMessageModel() {
            return {}
          },
          getChatModel() {
            return {}
          }
        }
        return
      }

      if (
        source.includes('WAWebConnModel') &&
        source.includes('getMaybeMePnUser')
      ) {
        return {
          pushname: 'test',
          wid: {
            _serialized: '10000000000@c.us',
            user: '10000000000',
            server: 'c.us'
          }
        }
      }

      return await withWindow(fn, args)
    },

    async exposeFunction(name, fn) {
      if (name === 'onRemoveMessageEvent' && state.failedOnce === false) {
        state.failedOnce = true
        throw new Error('INJECTED_PARTIAL_ATTACH_FAILURE')
      }
      fakeWindow[name] = fn
      state.exposedNames.push(name)
    },

    on(event, handler) {
      if (event === 'framenavigated') state.frameHandler = handler
    }
  }

  const client = new Client()
  client.pupPage = page
  client.setDeviceName = async () => {}
  client.getWWebVersion = async () => 'test-version'
  client.authStrategy.getAuthEventPayload = async () => ({})
  client.authStrategy.afterAuthReady = async () => {}
  client.currentIndexHtml = null

  client.on(Events.READY, () => {
    state.readyCount += 1
  })
  client._registerFramenavigatedHandler()

  await expect(client.inject()).rejects.toThrow('INJECTED_PARTIAL_ATTACH_FAILURE')

  expect(state.failedOnce).toBe(true)
  expect(fakeWindow.WWebJS).toBeDefined()
  expect(fakeWindow.WWebJS.__eventBridgeReady).not.toBe(true)
  expect(Msg.listenerCount('add')).toBe(0)
  expect(state.frameHandler).toBeTruthy()

  const frame = {
    parentFrame: () => null,
    url: () => 'https://web.whatsapp.com/'
  }

  await state.frameHandler(frame)

  expect(fakeWindow.WWebJS.__eventBridgeReady).toBe(true)
  expect(Msg.listenerCount('add')).toBe(1)
  expect(state.readyCount).toBe(1)

  await state.frameHandler(frame)

  expect(Msg.listenerCount('add')).toBe(1)
  expect(state.readyCount).toBe(1)
  expect(state.exposedNames.length).toBeGreaterThan(3)
})
