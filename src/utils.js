const axios = require('axios')
const { globalApiKey, disabledCallbacks, enableWebHook } = require('./config')
const { logger } = require('./logger')
const ChatFactory = require('whatsapp-web.js/src/factories/ChatFactory')
const Client = require('whatsapp-web.js').Client
const { Chat, Message } = require('whatsapp-web.js/src/structures')

// Trigger webhook endpoint
const WEBHOOK_MAX_ATTEMPTS = 3
const WEBHOOK_RETRY_DELAYS_MS = [100, 300]
const WEBHOOK_REQUEST_TIMEOUT_MS = 5000
const TRANSIENT_WEBHOOK_ERROR_CODES = new Set([
  'ECONNABORTED',
  'ECONNREFUSED',
  'ECONNRESET',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ETIMEDOUT',
  'EAI_AGAIN',
  'ERR_NETWORK'
])

const isRetryableWebhookError = error => {
  const status = error && error.response && error.response.status
  if (Number.isInteger(status)) return status >= 500 && status < 600
  const code = error && (error.code || (error.cause && error.cause.code))
  return TRANSIENT_WEBHOOK_ERROR_CODES.has(code)
}

const waitForWebhookRetry = ms => new Promise(resolve => setTimeout(resolve, ms))

const triggerWebhook = async (webhookURL, sessionId, dataType, data) => {
  if (!enableWebHook) return

  for (let attempt = 1; attempt <= WEBHOOK_MAX_ATTEMPTS; attempt++) {
    try {
      await axios.post(
        webhookURL,
        { dataType, data, sessionId },
        {
          headers: { 'x-api-key': globalApiKey },
          timeout: WEBHOOK_REQUEST_TIMEOUT_MS
        }
      )
      logger.debug({ sessionId, dataType, data: data || '' }, `Webhook message sent to ${webhookURL}`)
      return
    } catch (error) {
      const retryable = isRetryableWebhookError(error)
      if (!retryable || attempt === WEBHOOK_MAX_ATTEMPTS) {
        logger.error(
          { sessionId, dataType, attempt, err: error, data: data || '' },
          `Failed to send webhook message to ${webhookURL}`
        )
        return
      }
      logger.warn(
        { sessionId, dataType, attempt, err: error },
        `Transient webhook delivery failure; retrying ${webhookURL}`
      )
      await waitForWebhookRetry(WEBHOOK_RETRY_DELAYS_MS[attempt - 1])
    }
  }
}

// Function to send a response with error status and message
const sendErrorResponse = (res, status, error) => {
  const message = error instanceof Error ? error.message : error
  if (error instanceof Error) {
    logger.error({ err: error }, message)
  }
  res.status(status).json({ success: false, error: message })
}

// Function to wait for a specific item not to be null
const waitForNestedObject = (rootObj, nestedPath, maxWaitTime = 10000, interval = 100) => {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const checkObject = () => {
      const nestedObj = nestedPath.split('.').reduce((obj, key) => obj ? obj[key] : undefined, rootObj)
      if (nestedObj) {
        // Nested object exists, resolve the promise
        resolve()
      } else if (Date.now() - start > maxWaitTime) {
        // Maximum wait time exceeded, reject the promise
        logger.error('Timed out waiting for nested object')
        reject(new Error('Timeout waiting for nested object'))
      } else {
        // Nested object not yet created, continue waiting
        setTimeout(checkObject, interval)
      }
    }
    checkObject()
  })
}

const isEventEnabled = (event) => {
  return !disabledCallbacks.includes(event)
}

const sendMessageSeenStatus = async (message) => {
  try {
    const chat = await message.getChat()
    await chat.sendSeen()
  } catch (error) {
    logger.error(error, 'Failed to send seen status')
  }
}

const decodeBase64 = function * (base64String) {
  const chunkSize = 1024
  for (let i = 0; i < base64String.length; i += chunkSize) {
    const chunk = base64String.slice(i, i + chunkSize)
    yield Buffer.from(chunk, 'base64')
  }
}

const sleep = function (ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const exposeFunctionIfAbsent = async (page, name, fn) => {
  const exist = await page.evaluate((name) => {
    return !!window[name]
  }, name)
  if (exist) {
    return
  }
  await page.exposeFunction(name, fn)
}

Chat.prototype.fetchMessagesPage = async function (options) {
  const pagingOptions = {
    lowerTimestamp: 0,
    upperTimestamp: Number.MAX_SAFE_INTEGER,
    before: null,
    pageSize: 200,
    ...options
  }
  return await this.client.pupPage.evaluate(async (chatId, options) => {
    const loader = window.require('WAWebChatLoadMessages')
    const chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
    const messageId = message => String(message.id.id)
    const timestamp = message => Number(message.t)
    const messageKey = message => `${timestamp(message)}:${messageId(message)}`
    const models = () => chat.msgs.getModelsArray().filter(message => !message.isNotification)
    const mergeEarlier = earlier => {
      const unique = new Map()
      for (const message of [...models(), ...(earlier || [])]) {
        if (!message.isNotification) unique.set(messageKey(message), message)
      }
      return [...unique.values()]
    }
    const oldestTimestamp = messages => {
      let oldest = null
      for (const message of messages) {
        oldest = oldest === null ? timestamp(message) : Math.min(oldest, timestamp(message))
      }
      return oldest
    }
    const isOlderThanCursor = message => (
      timestamp(message) < options.before.timestamp ||
      (timestamp(message) === options.before.timestamp && messageId(message) < options.before.messageId)
    )
    const isPositioned = messages => options.before
      ? messages.some(message => (
        (timestamp(message) === options.before.timestamp && messageId(message) === options.before.messageId) ||
        timestamp(message) < options.before.timestamp
      ))
      : messages.some(message => timestamp(message) <= options.upperTimestamp)

    let loaded = models()
    if (!isPositioned(loaded)) {
      const earlier = await loader.loadEarlierMsgs({ chat })
      loaded = mergeEarlier(earlier)
      if (!isPositioned(loaded)) {
        if (!earlier || !earlier.length) {
          if (!options.before) {
            return {
              state: 'PAGE',
              messages: [],
              nextBefore: null,
              done: true,
              reason: 'end_of_local_history'
            }
          }
          return {
            state: 'CURSOR_UNREACHABLE',
            messages: [],
            progressOldestTimestamp: oldestTimestamp(loaded)
          }
        }
        return {
          state: 'SEEKING',
          messages: [],
          progressOldestTimestamp: oldestTimestamp(loaded)
        }
      }
      return {
        state: 'POSITIONED',
        messages: [],
        progressOldestTimestamp: oldestTimestamp(loaded)
      }
    }

    const candidates = messages => messages
      .filter(message => (
        timestamp(message) >= options.lowerTimestamp &&
        timestamp(message) <= options.upperTimestamp &&
        (!options.before || isOlderThanCursor(message))
      ))
      .sort((left, right) => (
        timestamp(right) - timestamp(left) || messageId(right).localeCompare(messageId(left))
      ))

    let eligible = candidates(loaded)
    let providerStalled = false
    let crossedLowerBound = loaded.some(message => timestamp(message) < options.lowerTimestamp)
    if (eligible.length < options.pageSize && !crossedLowerBound) {
      const loadedKeys = new Set(loaded.map(messageKey))
      const earlier = await loader.loadEarlierMsgs({ chat })
      providerStalled = !earlier || !earlier.length
      loaded = mergeEarlier(earlier)
      if (!providerStalled && !loaded.some(message => !loadedKeys.has(messageKey(message)))) {
        providerStalled = true
      }
      eligible = candidates(loaded)
      crossedLowerBound = loaded.some(message => timestamp(message) < options.lowerTimestamp)
    }

    const page = eligible.slice(0, options.pageSize)
    const cursorMessage = page.at(-1)
    const done = eligible.length <= page.length && (crossedLowerBound || providerStalled)
    return {
      state: 'PAGE',
      messages: page.map(message => window.WWebJS.getMessageModel(message)),
      nextBefore: cursorMessage
        ? { timestamp: timestamp(cursorMessage), messageId: messageId(cursorMessage) }
        : null,
      done,
      reason: done
        ? crossedLowerBound ? 'lower_bound' : 'end_of_local_history'
        : 'page_full'
    }
  }, this.id._serialized, pagingOptions)
}

const patchWWebLibrary = async (client) => {
  // MUST be run after the 'ready' event fired
  Client.prototype.getChats = async function (searchOptions = {}) {
    const chats = await this.pupPage.evaluate(async (searchOptions) => {
      return await window.WWebJS.getChats({ ...searchOptions })
    }, searchOptions)

    return chats.map(chat => ChatFactory.create(this, chat))
  }

  Chat.prototype.fetchMessages = async function (searchOptions) {
    const messages = await this.client.pupPage.evaluate(async (chatId, searchOptions) => {
      const msgFilter = (m) => {
        if (m.isNotification) {
          return false
        }
        if (searchOptions && searchOptions.fromMe !== undefined && m.id.fromMe !== searchOptions.fromMe) {
          return false
        }
        if (searchOptions && searchOptions.since !== undefined && Number.isFinite(searchOptions.since) && m.t < searchOptions.since) {
          return false
        }
        if (searchOptions && searchOptions.messageId !== undefined && m.id.id !== searchOptions.messageId) {
          return false
        }
        return true
      }

      const chat = await window.WWebJS.getChat(chatId, { getAsModel: false })
      let msgs = chat.msgs.getModelsArray().filter(msgFilter)

      if (searchOptions && searchOptions.limit > 0) {
        while (msgs.length < searchOptions.limit) {
          const loadedMessages = await (window.require('WAWebChatLoadMessages')).loadEarlierMsgs({ chat })

          if (!loadedMessages || !loadedMessages.length) break
          msgs = [...loadedMessages.filter(msgFilter), ...msgs]
        }

        if (msgs.length > searchOptions.limit) {
          msgs.sort((a, b) => (a.t > b.t) ? 1 : -1)
          msgs = msgs.splice(msgs.length - searchOptions.limit)
        }
      }

      return msgs.map(m => window.WWebJS.getMessageModel(m))
    }, this.id._serialized, searchOptions)

    return messages.map(m => new Message(this.client, m))
  }

  await client.pupPage.evaluate(() => {
    // hotfix for https://github.com/pedroslopez/whatsapp-web.js/pull/3643
    window.WWebJS.getChats = async (searchOptions = {}) => {
      const chatFilter = (c) => {
        if (searchOptions && searchOptions.unread === true && c.unreadCount === 0) {
          return false
        }
        if (searchOptions && searchOptions.since !== undefined && Number.isFinite(searchOptions.since) && c.t < searchOptions.since) {
          return false
        }
        return true
      }

      const allChats = window.require('WAWebCollections').Chat.getModelsArray()

      const filteredChats = allChats.filter(chatFilter)

      return await Promise.all(
        filteredChats.map(chat => window.WWebJS.getChatModel(chat))
      )
    }
  })
}

module.exports = {
  triggerWebhook,
  sendErrorResponse,
  waitForNestedObject,
  isEventEnabled,
  sendMessageSeenStatus,
  decodeBase64,
  sleep,
  exposeFunctionIfAbsent,
  patchWWebLibrary
}
