describe('service bind host', () => {
  test('defaults to IPv4 loopback', () => {
    const previousHost = process.env.HOST
    process.env.HOST = ''
    jest.resetModules()

    try {
      const config = require('../src/config')
      expect(config.serviceHost).toBe('127.0.0.1')
    } finally {
      if (previousHost === undefined) delete process.env.HOST
      else process.env.HOST = previousHost
      jest.resetModules()
    }
  })

  test('explicit bind host remains configurable for non-production wrapper use', () => {
    const previousHost = process.env.HOST
    process.env.HOST = '127.0.0.1'
    jest.resetModules()

    try {
      const config = require('../src/config')
      expect(config.serviceHost).toBe('127.0.0.1')
    } finally {
      if (previousHost === undefined) delete process.env.HOST
      else process.env.HOST = previousHost
      jest.resetModules()
    }
  })
})
