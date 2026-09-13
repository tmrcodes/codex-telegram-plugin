import { describe, expect, test } from 'bun:test'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { installedLauncher } from './telegram-installed'
import { activation, refreshLauncher } from './telegram-setup'

describe('persistent terminal entrypoint', () => {
  const installed = (version: string, enabled = true) => ({ installed: [{ pluginId: 'telegram-channel@codex-telegram', installed: true, enabled, version }] })
  test('resolves the currently installed version after a cache update', () => {
    expect(installedLauncher(installed('0.1.1+new'), '/tmp/synthetic-codex-home')).toBe('/tmp/synthetic-codex-home/plugins/cache/codex-telegram/telegram-channel/0.1.1+new/dist/scripts/telegram-launcher.js')
    expect(() => installedLauncher(installed('0.1.1', false), '/tmp/synthetic-codex-home')).toThrow('Install and enable')
    expect(() => installedLauncher(installed('../../wrong'), '/tmp/synthetic-codex-home')).toThrow('Install and enable')
  })
  test('shell activation keeps spaces, quotes and original arguments literal', () => {
    const script = activation('/bin/echo', "/tmp/it's a fixture", '/tmp/private settings', '/tmp/codex home') + `codex 'two words' '$HOME'\n`
    const child = Bun.spawnSync(['/bin/sh', '-c', script])
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe("/tmp/it's a fixture /tmp/private settings two words $HOME\n")
  })
  test('shell activation pins the installed Codex home without exporting it to the caller', () => {
    const script = activation('/usr/bin/env', '/usr/bin/printenv', 'CODEX_HOME', '/tmp/codex home') + `unset CODEX_HOME\ncodex\nprintf '%s' "\${CODEX_HOME-unset}"\n`
    const child = Bun.spawnSync(['/bin/sh', '-c', script])
    expect(child.exitCode).toBe(0)
    expect(child.stdout.toString()).toBe('/tmp/codex home\nunset')
  })
  test('upgrade requires an exact absolute settings path', () => {
    expect(() => refreshLauncher('relative/settings')).toThrow('normalized absolute path')
    expect(() => refreshLauncher('/tmp/../tmp/settings')).toThrow('normalized absolute path')
  })
  test('migrates a retained legacy bootstrap without changing token, policy, or state', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-telegram-upgrade-'))
    try {
      const settingsDir = join(root, 'settings'), stateDir = join(settingsDir, 'state'), codexHome = join(root, 'codex-home')
      mkdirSync(settingsDir, { mode: 0o700 }); mkdirSync(stateDir, { mode: 0o700 })
      const codexBinary = join(root, 'codex'), token = join(settingsDir, 'bot-token'), policy = join(settingsDir, 'policy.json'), settings = join(settingsDir, 'launcher.json')
      const oldBootstrap = join(settingsDir, 'bootstrap.ts'), activate = join(settingsDir, 'activate.sh'), source = join(root, 'telegram-bootstrap.js')
      writeFileSync(codexBinary, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
      writeFileSync(token, '12345:' + 'abcdefghijklmnopqrstuvwx' + '\n', { mode: 0o600 })
      writeFileSync(policy, JSON.stringify({ schemaVersion: 1, dmPolicy: 'allowlist', allowFrom: ['700001'], groups: {}, allowAllGroups: false, mentionPatterns: [], ackReaction: '👀', typing: true, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'newline', deliveryMode: 'queue', permissions: { enabled: false, operatorDmChatIds: [] }, pending: [] }) + '\n', { mode: 0o600 })
      writeFileSync(settings, JSON.stringify({ codexBinary, botTokenFile: token, policyFile: policy, stateDir }) + '\n', { mode: 0o600 })
      const legacyBootstrap = readFileSync(join(import.meta.dir, 'fixtures/telegram-bootstrap-unbundled.ts'))
      expect(createHash('sha256').update(legacyBootstrap).digest('hex')).toBe('b479d3b68447d97f69deabfc05b0b234e110ccf335e5bd56f6f2b68a0f7a9636')
      writeFileSync(oldBootstrap, legacyBootstrap, { mode: 0o600 })
      writeFileSync(activate, 'old activation\n', { mode: 0o600 })
      writeFileSync(join(stateDir, 'retained'), 'unchanged\n', { mode: 0o600 })
      writeFileSync(source, '#!/usr/bin/env bun\n// bundled bootstrap v0.1.0\n', { mode: 0o600 })
      const launcher = join(codexHome, 'plugins/cache/codex-telegram/telegram-channel/0.1.0/dist/scripts/telegram-launcher.js')
      mkdirSync(join(launcher, '..'), { recursive: true }); writeFileSync(launcher, 'bundled launcher\n')
      const retained = [token, policy, join(stateDir, 'retained')].map(path => readFileSync(path))
      const options = { bootstrapSource: source, bunBinary: '/absolute/bun', codexHome, inventory: () => ({ installed: [{ pluginId: 'telegram-channel@codex-telegram', installed: true, enabled: true, version: '0.1.0' }] }) }
      expect(refreshLauncher(settingsDir, options)).toBe(activate)
      expect(readFileSync(oldBootstrap, 'utf8')).toContain('bundled bootstrap v0.1.0')
      expect(readFileSync(activate, 'utf8')).toContain(`CODEX_HOME='${codexHome}' '/absolute/bun' '${oldBootstrap}' '${settings}'`)
      expect(JSON.parse(readFileSync(settings, 'utf8')).codexHome).toBe(codexHome)
      expect(() => statSync(join(settingsDir, 'bootstrap.js'))).toThrow()
      expect(statSync(oldBootstrap).mode & 0o777).toBe(0o600); expect(statSync(activate).mode & 0o777).toBe(0o600)
      expect([token, policy, join(stateDir, 'retained')].map(path => readFileSync(path))).toEqual(retained)
      expect(refreshLauncher(settingsDir, { ...options, codexHome: undefined })).toBe(activate)
      expect([token, policy, join(stateDir, 'retained')].map(path => readFileSync(path))).toEqual(retained)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('legacy refresh fails closed without its original Codex home', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-telegram-upgrade-home-'))
    try {
      const settingsDir = join(root, 'settings'), stateDir = join(settingsDir, 'state')
      mkdirSync(settingsDir, { mode: 0o700 }); mkdirSync(stateDir, { mode: 0o700 })
      const codexBinary = join(root, 'codex'), token = join(settingsDir, 'bot-token'), policy = join(settingsDir, 'policy.json'), settings = join(settingsDir, 'launcher.json')
      writeFileSync(codexBinary, '#!/bin/sh\n', { mode: 0o700 }); writeFileSync(token, '12345:' + 'abcdefghijklmnopqrstuvwx' + '\n', { mode: 0o600 })
      writeFileSync(policy, JSON.stringify({ schemaVersion: 1, dmPolicy: 'allowlist', allowFrom: ['700001'], groups: {}, allowAllGroups: false, mentionPatterns: [], ackReaction: '👀', typing: true, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'newline', deliveryMode: 'queue', permissions: { enabled: false, operatorDmChatIds: [] }, pending: [] }), { mode: 0o600 })
      writeFileSync(settings, JSON.stringify({ codexBinary, botTokenFile: token, policyFile: policy, stateDir }) + '\n', { mode: 0o600 })
      expect(() => refreshLauncher(settingsDir)).toThrow('explicit --codex-home')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('refuses to retarget a persisted setup to another Codex home', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-telegram-upgrade-retarget-'))
    try {
      const settingsDir = join(root, 'settings'), stateDir = join(settingsDir, 'state'), codexHome = join(root, 'original-home')
      mkdirSync(settingsDir, { mode: 0o700 }); mkdirSync(stateDir, { mode: 0o700 })
      const codexBinary = join(root, 'codex'), token = join(settingsDir, 'bot-token'), policy = join(settingsDir, 'policy.json'), settings = join(settingsDir, 'launcher.json')
      writeFileSync(codexBinary, '#!/bin/sh\n', { mode: 0o700 }); writeFileSync(token, '12345:' + 'abcdefghijklmnopqrstuvwx' + '\n', { mode: 0o600 })
      writeFileSync(policy, JSON.stringify({ schemaVersion: 1, dmPolicy: 'allowlist', allowFrom: ['700001'], groups: {}, allowAllGroups: false, mentionPatterns: [], ackReaction: '👀', typing: true, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'newline', deliveryMode: 'queue', permissions: { enabled: false, operatorDmChatIds: [] }, pending: [] }), { mode: 0o600 })
      writeFileSync(settings, JSON.stringify({ codexBinary, botTokenFile: token, policyFile: policy, stateDir, codexHome }) + '\n', { mode: 0o600 })
      expect(() => refreshLauncher(settingsDir, { codexHome: join(root, 'other-home') })).toThrow('does not match')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
  test('rejects a symlinked retained bootstrap before replacing activation', () => {
    const root = mkdtempSync(join(tmpdir(), 'codex-telegram-upgrade-link-'))
    try {
      const settingsDir = join(root, 'settings'), stateDir = join(settingsDir, 'state'), codexHome = join(root, 'home')
      mkdirSync(settingsDir, { mode: 0o700 }); mkdirSync(stateDir, { mode: 0o700 })
      const codexBinary = join(root, 'codex'), token = join(settingsDir, 'bot-token'), policy = join(settingsDir, 'policy.json'), settings = join(settingsDir, 'launcher.json'), target = join(root, 'target'), activate = join(settingsDir, 'activate.sh')
      writeFileSync(codexBinary, '#!/bin/sh\n', { mode: 0o700 }); writeFileSync(token, '12345:' + 'abcdefghijklmnopqrstuvwx' + '\n', { mode: 0o600 })
      writeFileSync(policy, JSON.stringify({ schemaVersion: 1, dmPolicy: 'allowlist', allowFrom: ['700001'], groups: {}, allowAllGroups: false, mentionPatterns: [], ackReaction: '👀', typing: true, replyToMode: 'first', textChunkLimit: 4096, chunkMode: 'newline', deliveryMode: 'queue', permissions: { enabled: false, operatorDmChatIds: [] }, pending: [] }), { mode: 0o600 })
      writeFileSync(settings, JSON.stringify({ codexBinary, botTokenFile: token, policyFile: policy, stateDir }), { mode: 0o600 }); writeFileSync(target, 'outside\n', { mode: 0o600 }); symlinkSync(target, join(settingsDir, 'bootstrap.ts')); writeFileSync(activate, 'retained\n', { mode: 0o600 })
      const source = join(root, 'source.js'); writeFileSync(source, 'new\n')
      const launcher = join(codexHome, 'plugins/cache/codex-telegram/telegram-channel/0.1.0/dist/scripts/telegram-launcher.js'); mkdirSync(join(launcher, '..'), { recursive: true }); writeFileSync(launcher, 'launcher\n')
      expect(() => refreshLauncher(settingsDir, { bootstrapSource: source, codexHome, inventory: () => ({ installed: [{ pluginId: 'telegram-channel@codex-telegram', installed: true, enabled: true, version: '0.1.0' }] }) })).toThrow('owned 0600 regular file')
      expect(readFileSync(target, 'utf8')).toBe('outside\n'); expect(readFileSync(activate, 'utf8')).toBe('retained\n')
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
