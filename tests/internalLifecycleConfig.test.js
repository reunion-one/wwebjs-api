const { spawnSync } = require('node:child_process')
const path = require('node:path')

const configPath = require.resolve('../src/config')
const checkConfigPath = path.resolve(__dirname, '../scripts/check-config.js')

const withConfigEnv = (values, callback) => {
  const names = ['BASE_WEBHOOK_URL', 'INTERNAL_LIFECYCLE_URL', 'ENV_PATH']
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]))
  Object.assign(process.env, values)
  jest.resetModules()
  try {
    return callback(require('../src/config'))
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name]
      else process.env[name] = previous[name]
    }
    delete require.cache[configPath]
    jest.resetModules()
  }
}

const runProductionCheck = baseWebhookURL => {
  return spawnSync(process.execPath, [checkConfigPath], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      ENV_PATH: '/dev/null',
      HOST: '127.0.0.1',
      PORT: '3000',
      BASE_WEBHOOK_URL: baseWebhookURL,
      INTERNAL_LIFECYCLE_URL: 'http://192.0.2.10:9999/redirect',
      ENABLE_SWAGGER_ENDPOINT: 'FALSE',
      ENABLE_WEB_UI: 'FALSE',
      PROXY_URL: '',
      PROXY_USERNAME: '',
      PROXY_PASSWORD: ''
    },
    encoding: 'utf8'
  })
}

describe('internal lifecycle configuration authority', () => {
  test('ambient INTERNAL_LIFECYCLE_URL cannot redirect the derived endpoint', () => {
    withConfigEnv({
      ENV_PATH: '/dev/null',
      BASE_WEBHOOK_URL: 'http://127.0.0.1:5000/whatsapp-webhook',
      INTERNAL_LIFECYCLE_URL: 'http://192.0.2.10:9999/redirect'
    }, config => {
      expect(config.internalLifecycleURL).toBe(
        'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
      )
    })
  })

  test('derived endpoint preserves callback origin and enforces the internal path', () => {
    withConfigEnv({
      ENV_PATH: '/dev/null',
      BASE_WEBHOOK_URL: 'http://127.0.0.1:5000/custom/path?callback=1#fragment',
      INTERNAL_LIFECYCLE_URL: 'http://192.0.2.10:9999/redirect'
    }, config => {
      const callback = new URL(process.env.BASE_WEBHOOK_URL)
      const lifecycle = new URL(config.internalLifecycleURL)
      expect(lifecycle.origin).toBe(callback.origin)
      expect(lifecycle.pathname).toBe('/internal/wwebjs-lifecycle')
      expect(lifecycle.search).toBe('')
      expect(lifecycle.hash).toBe('')
    })
  })

  test.each([
    ['missing base URL', ''],
    ['malformed base URL', 'not a url'],
    ['non-loopback base URL', 'http://192.0.2.10:5000/whatsapp-webhook']
  ])('%s fails safe instead of accepting an independent lifecycle destination', (_name, baseWebhookURL) => {
    withConfigEnv({
      ENV_PATH: '/dev/null',
      BASE_WEBHOOK_URL: baseWebhookURL,
      INTERNAL_LIFECYCLE_URL: 'http://127.0.0.1:5000/internal/wwebjs-lifecycle'
    }, config => {
      expect(config.internalLifecycleURL).toBeNull()
    })
  })

  test('production checker accepts a valid derived endpoint despite an ambient override', () => {
    const result = runProductionCheck('http://127.0.0.1:5000/whatsapp-webhook')
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('wwebjs configuration valid')
  })

  test('production checker rejects a non-loopback base/effective destination', () => {
    const result = runProductionCheck('http://192.0.2.10:5000/whatsapp-webhook')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('BASE_WEBHOOK_URL must target loopback COMM')
  })

  test('production checker rejects credentials inherited by the effective lifecycle URL', () => {
    const result = runProductionCheck(
      'http://user:password@127.0.0.1:5000/whatsapp-webhook'
    )
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('internal lifecycle URL must not contain credentials')
  })
})
