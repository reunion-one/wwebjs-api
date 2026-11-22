const net = require('node:net')
const { URL } = require('node:url')
const config = require('../src/config')

const fail = (message) => { throw new Error(message) }

if (net.isIP(config.serviceHost) === 0) fail('HOST must be a literal loopback IP address')
if (config.serviceHost !== '::1' && !config.serviceHost.startsWith('127.')) {
  fail('HOST must be loopback only')
}

const port = Number(config.servicePort)
if (!Number.isInteger(port) || port < 1 || port > 65535) fail('PORT must be in range 1-65535')

for (const name of ['HEADLESS']) {
  if (process.env[name] !== undefined && !['true', 'false'].includes(process.env[name].toLowerCase())) {
    fail(`${name} must be true or false`)
  }
}

if (config.enableSwaggerEndpoint) fail('ENABLE_SWAGGER_ENDPOINT must be false for production bootstrap')
if (config.enableWebUI) fail('ENABLE_WEB_UI must be false for production bootstrap')

const proxyUser = process.env.PROXY_USERNAME || ''
const proxyPassword = process.env.PROXY_PASSWORD || ''
if (Boolean(proxyUser) !== Boolean(proxyPassword)) {
  fail('PROXY_USERNAME and PROXY_PASSWORD must both be set or both be empty')
}
if ((proxyUser || proxyPassword) && !config.proxyUrl) fail('PROXY_URL is required with proxy credentials')
if (config.proxyUrl) {
  const proxy = new URL(config.proxyUrl)
  if (!['http:', 'https:', 'socks5:'].includes(proxy.protocol) || !proxy.hostname) {
    fail('PROXY_URL must use http, https, or socks5 with a hostname')
  }
}

if (!config.baseWebhookURL) fail('BASE_WEBHOOK_URL is required')
const callback = new URL(config.baseWebhookURL)
if (!['127.0.0.1', '::1', 'localhost'].includes(callback.hostname)) {
  fail('BASE_WEBHOOK_URL must target loopback COMM')
}

if (!config.internalLifecycleURL) fail('internal lifecycle URL could not be derived from BASE_WEBHOOK_URL')
const lifecycle = new URL(config.internalLifecycleURL)
if (lifecycle.origin !== callback.origin) {
  fail('internal lifecycle URL must share the BASE_WEBHOOK_URL origin')
}
if (!['127.0.0.1', '::1', 'localhost'].includes(lifecycle.hostname)) {
  fail('internal lifecycle URL must target loopback COMM')
}
if (lifecycle.pathname !== '/internal/wwebjs-lifecycle') {
  fail('internal lifecycle URL must use /internal/wwebjs-lifecycle')
}
if (lifecycle.username || lifecycle.password) {
  fail('internal lifecycle URL must not contain credentials')
}
if (lifecycle.search || lifecycle.hash) {
  fail('internal lifecycle URL must not contain query or fragment')
}

process.stdout.write('wwebjs configuration valid\n')
