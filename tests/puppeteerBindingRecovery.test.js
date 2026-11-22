const { exposeFunctionIfAbsent } = require('whatsapp-web.js/src/util/Puppeteer')

test('stale Puppeteer binding is removed and safely re-exposed after navigation', async () => {
  const fakeWindow = {}
  const registered = new Set(['onReaction'])
  let exposeAttempts = 0
  const page = {
    evaluate: jest.fn(async (fn, ...args) => {
      const previous = global.window
      global.window = fakeWindow
      try { return await fn(...args) } finally { global.window = previous }
    }),
    removeExposedFunction: jest.fn(async name => {
      registered.delete(name)
      delete fakeWindow[name]
    }),
    exposeFunction: jest.fn(async (name, fn) => {
      exposeAttempts += 1
      if (exposeAttempts === 1 || registered.has(name)) {
        throw new Error('Failed to add page binding with name ' + name + ': already exists')
      }
      registered.add(name)
      fakeWindow[name] = fn
    })
  }

  const callback = jest.fn()
  await exposeFunctionIfAbsent(page, 'onReaction', callback)

  expect(page.removeExposedFunction).toHaveBeenCalledWith('onReaction')
  expect(fakeWindow.onReaction).toBe(callback)
})

test('binding recovery accepts another injector winning the final race', async () => {
  const fakeWindow = {}
  let exposeAttempts = 0
  const winner = jest.fn()
  const page = {
    evaluate: jest.fn(async (fn, ...args) => {
      const previous = global.window
      global.window = fakeWindow
      try { return await fn(...args) } finally { global.window = previous }
    }),
    removeExposedFunction: jest.fn(async name => { delete fakeWindow[name] }),
    exposeFunction: jest.fn(async name => {
      exposeAttempts += 1
      if (exposeAttempts === 1) {
        throw new Error('Failed to add page binding with name ' + name + ': already exists')
      }
      fakeWindow[name] = winner
      throw new Error('Failed to add page binding with name ' + name + ': already exists')
    })
  }

  await expect(exposeFunctionIfAbsent(page, 'onReaction', jest.fn())).resolves.toBeUndefined()
  expect(fakeWindow.onReaction).toBe(winner)
})
