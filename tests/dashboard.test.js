const request = require('supertest')

const { basePath, enableWebUI } = require('../src/config')
const app = require('../src/app')

jest.mock('qrcode-terminal')

const basePrefix = basePath === '/' ? '' : basePath.replace(/\/$/, '')
const configuredPath = pathname => basePrefix + pathname

describe('Web UI dashboard under maintained configuration', () => {
  it('matches the configured dashboard exposure', async () => {
    const response = await request(app).get(configuredPath('/dashboard/'))

    if (enableWebUI) {
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toMatch(/html/)
      expect(response.text).toContain('<title>WWebJS API Dashboard</title>')
    } else {
      expect(response.status).toBe(404)
    }
  })

  if (enableWebUI) {
    it('redirects the configured dashboard path to its trailing-slash form', async () => {
      const path = configuredPath('/dashboard')
      const response = await request(app).get(path)
      expect(response.status).toBe(301)
      expect(response.headers.location).toBe(path + '/')
    })

    it('serves dashboard assets from the configured dashboard', async () => {
      const response = await request(app).get(configuredPath('/dashboard/app.js'))
      expect(response.status).toBe(200)
      expect(response.headers['content-type']).toMatch(/javascript/)
    })
  }
})
