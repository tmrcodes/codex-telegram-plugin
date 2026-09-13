import { describe, expect, test } from 'bun:test'
import { delimiter } from 'node:path'
import { bootstrapEnvironment } from './telegram-bootstrap'

describe('cache-following bootstrap environment', () => {
  test('pins the installed Codex home and makes its own Bun available to MCP children', () => {
    const source = { PATH: ['/usr/bin', '/bin'].join(delimiter), RETAINED: 'yes', CODEX_HOME: '/wrong' }
    const result = bootstrapEnvironment('/private/codex-home', source, '/opt/private-bun/bin/bun')
    expect(result).toEqual({ ...source, CODEX_HOME: '/private/codex-home', PATH: ['/opt/private-bun/bin', '/usr/bin', '/bin'].join(delimiter) })
    expect(source).toEqual({ PATH: ['/usr/bin', '/bin'].join(delimiter), RETAINED: 'yes', CODEX_HOME: '/wrong' })
  })

  test('does not duplicate a Bun directory already present in PATH', () => {
    const path = ['/usr/bin', '/opt/private-bun/bin', '/bin'].join(delimiter)
    expect(bootstrapEnvironment('/private/codex-home', { PATH: path }, '/opt/private-bun/bin/bun').PATH).toBe(path)
  })
})
