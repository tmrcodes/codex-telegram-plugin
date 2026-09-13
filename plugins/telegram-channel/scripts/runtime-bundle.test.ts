import { afterEach, describe, expect, test } from 'bun:test'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const pluginRoot = resolve(import.meta.dir, '..')
const temporary: string[] = []

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('published runtime bundles', () => {
  test('MCP discovery points at the committed standalone bundle', () => {
    const manifest = JSON.parse(readFileSync(join(pluginRoot, '.mcp.json'), 'utf8'))
    expect(manifest.mcpServers.telegram.args).toEqual(['./dist/app-server-controller/standalone-telegram-main.js'])
    expect(manifest.mcpServers.telegram.env_vars).toEqual([
      'CODEX_TELEGRAM_CONFIG',
      'CODEX_TELEGRAM_OWNER_SOCKET',
      'CODEX_TELEGRAM_OWNER_CONFIG',
    ])
  })

  test('plugin and package versions stay synchronized', () => {
    const plugin = JSON.parse(readFileSync(join(pluginRoot, '.codex-plugin/plugin.json'), 'utf8'))
    const packageManifest = JSON.parse(readFileSync(join(pluginRoot, 'package.json'), 'utf8'))
    expect(plugin.version).toBe('0.1.0')
    expect(packageManifest.version).toBe(plugin.version)
  })

  test('all production entrypoints are present and remain marketplace-sized', () => {
    for (const relative of [
      'dist/scripts/telegram-launcher.js',
      'dist/scripts/telegram-setup.js',
      'dist/scripts/telegram-bootstrap.js',
      'dist/app-server-controller/standalone-telegram-main.js',
      'dist/app-server-controller/standalone-telegram-access.js',
    ]) {
      const stats = statSync(join(pluginRoot, relative))
      expect(stats.isFile()).toBe(true)
      expect(stats.size).toBeGreaterThan(0)
      expect(stats.size).toBeLessThan(1_000 * 1_000)
    }
  })

  test('access entrypoint executes from an empty directory without package installation', () => {
    const directory = mkdtempSync(join(tmpdir(), 'codex-telegram-bundle-'))
    temporary.push(directory)
    const bundled = join(directory, 'access.js')
    copyFileSync(join(pluginRoot, 'dist/app-server-controller/standalone-telegram-access.js'), bundled)
    const env = { ...process.env }
    delete env.CODEX_TELEGRAM_CONFIG
    const child = Bun.spawnSync([process.execPath, bundled, 'status'], { cwd: directory, env, stdin: 'ignore' })
    expect(child.exitCode).toBe(1)
    expect(child.stderr.toString()).toContain('CODEX_TELEGRAM_CONFIG must name an absolute private connection config')
    expect(child.stderr.toString()).not.toContain('Cannot find package')
  })

  test('setup bundle runs only its own entrypoint', () => {
    const child = Bun.spawnSync([process.execPath, join(pluginRoot, 'dist/scripts/telegram-setup.js')], { stdin: 'ignore' })
    expect(child.exitCode).toBe(1)
    expect(child.stderr.toString()).toContain('telegram-setup: Provide the installed stock Codex binary')
    expect(child.stderr.toString()).not.toContain('codex Telegram:')
  })

  test('launcher bundle has the same failed-start behavior as source', () => {
    const env = { ...process.env }
    delete env.CODEX_TELEGRAM_LAUNCHER_CONFIG
    delete env.CODEX_TELEGRAM_CONFIG
    const source = Bun.spawnSync([process.execPath, join(pluginRoot, 'scripts/telegram-launcher.ts')], { env, stdin: 'ignore' })
    const bundled = Bun.spawnSync([process.execPath, join(pluginRoot, 'dist/scripts/telegram-launcher.js')], { env, stdin: 'ignore' })
    expect(source.exitCode).toBe(1)
    expect(bundled.exitCode).toBe(source.exitCode)
    expect(bundled.stderr.toString()).toBe(source.stderr.toString())
    expect(bundled.stdout.toString()).toBe(source.stdout.toString())
  })

  test('legacy refresh preserves one Codex home through a fresh ordinary shell', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-telegram-fresh-shell-'))
    temporary.push(root)
    const selectedHome = join(root, 'selected-home'), otherHome = join(root, 'other-home')
    const settingsDir = join(root, 'private-settings'), stateDir = join(settingsDir, 'state')
    mkdirSync(settingsDir, { recursive: true, mode: 0o700 }); mkdirSync(stateDir, { mode: 0o700 }); mkdirSync(otherHome)
    const inventoryLog = join(root, 'inventory-home.log')
    const codexBinary = join(root, 'stock-codex')
    writeFileSync(codexBinary, `#!/bin/sh\nprintf '%s\\n' "$CODEX_HOME" >> '${inventoryLog}'\nif [ "$1" = plugin ] && [ "$2" = list ]; then\n  printf '%s\\n' '{"installed":[{"pluginId":"telegram-channel@codex-telegram","installed":true,"enabled":true,"version":"0.1.0"}]}'\nelse\n  printf '{"home":"%s","path":"%s","args":["plugin","probe","two words"]}\\n' "$CODEX_HOME" "$PATH"\nfi\n`, { mode: 0o700 })
    const launcher = join(selectedHome, 'plugins/cache/codex-telegram/telegram-channel/0.1.0/dist/scripts/telegram-launcher.js')
    mkdirSync(join(launcher, '..'), { recursive: true })
    copyFileSync(join(pluginRoot, 'dist/scripts/telegram-launcher.js'), launcher)
    const token = join(settingsDir, 'bot-token'), policy = join(settingsDir, 'policy.json'), settings = join(settingsDir, 'launcher.json')
    writeFileSync(token, '12345:' + 'abcdefghijklmnopqrstuvwx' + '\n', { mode: 0o600 })
    writeFileSync(policy, JSON.stringify({ schemaVersion: 1, dmPolicy: 'allowlist', allowFrom: ['700001'], groups: {}, allowAllGroups: false, mentionPatterns: [], ackReaction: '👀', typing: true, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'newline', deliveryMode: 'queue', permissions: { enabled: false, operatorDmChatIds: [] }, pending: [] }) + '\n', { mode: 0o600 })
    writeFileSync(settings, JSON.stringify({ codexBinary, botTokenFile: token, policyFile: policy, stateDir }) + '\n', { mode: 0o600 })
    writeFileSync(join(settingsDir, 'bootstrap.ts'), 'legacy bootstrap\n', { mode: 0o600 })
    writeFileSync(join(settingsDir, 'activate.sh'), 'legacy activation\n', { mode: 0o600 })

    const refresh = Bun.spawnSync([
      process.execPath, join(pluginRoot, 'dist/scripts/telegram-setup.js'), '--refresh-launcher',
      '--directory', settingsDir, '--codex-home', selectedHome,
    ], { env: { ...process.env, CODEX_HOME: otherHome }, stdin: 'ignore' })
    expect(refresh.exitCode).toBe(0)
    expect(JSON.parse(readFileSync(settings, 'utf8')).codexHome).toBe(selectedHome)

    const activate = join(settingsDir, 'activate.sh')
    const shell = Bun.spawnSync(['/bin/sh', '-c', `. '${activate}'; unset CODEX_HOME; codex plugin probe 'two words'; printf 'caller=%s\\n' "\${CODEX_HOME-unset}"`], {
      env: { PATH: '/usr/bin:/bin', CODEX_HOME: otherHome }, stdin: 'ignore',
    })
    expect(shell.exitCode).toBe(0)
    const [launcherOutput, callerOutput] = shell.stdout.toString().trim().split('\n')
    const observed = JSON.parse(launcherOutput!)
    expect(observed.home).toBe(selectedHome)
    expect(observed.path.split(':')).toContain(join(process.execPath, '..'))
    expect(observed.args).toEqual(['plugin', 'probe', 'two words'])
    expect(callerOutput).toBe('caller=unset')
    expect(readFileSync(inventoryLog, 'utf8').trim().split('\n')).toEqual([selectedHome, selectedHome, selectedHome])

    const mismatch = Bun.spawnSync([process.execPath, launcher, 'plugin', 'probe'], {
      env: { PATH: '/usr/bin:/bin', CODEX_HOME: otherHome, CODEX_TELEGRAM_LAUNCHER_CONFIG: settings }, stdin: 'ignore',
    })
    expect(mismatch.exitCode).toBe(1)
    expect(mismatch.stderr.toString()).toContain('does not match retained setup provenance')
    expect(readFileSync(inventoryLog, 'utf8').trim().split('\n')).toEqual([selectedHome, selectedHome, selectedHome])
  })
})
