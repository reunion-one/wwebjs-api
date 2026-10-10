const isCanonicalBase64 = (value) => {
  if (typeof value !== 'string') return false
  const normalized = value.trim()
  if (!normalized || normalized.length % 4 !== 0) return false
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized)) {
    return false
  }

  const bytes = Buffer.from(normalized, 'base64')
  return (
    bytes.length > 0 &&
    bytes.toString('base64').replace(/=+$/, '') === normalized.replace(/=+$/, '')
  )
}

const usableMediaBytes = (messageMedia, maxAttachmentSize) => {
  if (!messageMedia || !isCanonicalBase64(messageMedia.data)) return null

  const mediaBytes = Buffer.from(messageMedia.data.trim(), 'base64')
  if (
    Number.isFinite(maxAttachmentSize) &&
    maxAttachmentSize > 0 &&
    mediaBytes.length >= maxAttachmentSize
  ) {
    return null
  }
  return mediaBytes
}

const emitCanonicalMessageCreate = async ({
  message,
  sessionId,
  sessionWebhook,
  maxAttachmentSize,
  triggerWebhook,
  triggerWebSocket,
  logger
}) => {
  let data = { message }

  if (message.hasMedia) {
    let messageMedia
    try {
      messageMedia = await message.downloadMedia()
    } catch (error) {
      logger.error(
        { sessionId, messageId: message.id?.id, err: error },
        'Failed to acquire message_create media; canonical event was not emitted'
      )
      return false
    }

    const mediaBytes = usableMediaBytes(messageMedia, maxAttachmentSize)
    if (!mediaBytes) {
      logger.error(
        { sessionId, messageId: message.id?.id },
        'message_create media was unavailable, invalid, empty, or oversized; canonical event was not emitted'
      )
      return false
    }

    data = { message, messageMedia }
  }

  await triggerWebhook(sessionWebhook, sessionId, 'message_create', data)
  triggerWebSocket(sessionId, 'message_create', data)
  return true
}

module.exports = {
  emitCanonicalMessageCreate,
  usableMediaBytes
}
