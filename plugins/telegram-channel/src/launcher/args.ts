/**
 * Splits a `codex` command line between the two stock processes this launcher starts.
 * The TUI receives the arguments unchanged; the App Server receives only host-wide configuration.
 */
export type LaunchPlan = {
  /** Administrative commands and `--help`/`--version` run the stock binary directly, without Telegram. */
  passthrough: boolean
  host: string[]
  tui: string[]
}

const ADMIN_COMMANDS = new Set([
  'exec',
  'e',
  'review',
  'login',
  'logout',
  'mcp',
  'mcp-server',
  'app-server',
  'app',
  'plugin',
  'plugins',
  'completion',
  'sandbox',
  'debug',
  'apply',
  'a',
  'cloud',
  'features',
  'help',
  'agents',
])
const VALUE_FLAGS = new Set([
  '-m',
  '--model',
  '-C',
  '--cd',
  '-p',
  '--profile',
  '-a',
  '--ask-for-approval',
  '-s',
  '--sandbox',
  '-i',
  '--image',
  '--add-dir',
])
const CONFIG_FLAGS = ['-c', '--config', '--enable', '--disable']

export function launchArguments(args: readonly string[]): LaunchPlan {
  const hostConfig: string[] = []
  let strictConfig = false
  let passthrough = false
  let command: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--') break
    if (['--help', '-h', '--version', '-V'].includes(arg)) passthrough = true
    if (CONFIG_FLAGS.includes(arg)) {
      const value = args[++index]
      if (value === undefined) throw new Error(`${arg} requires a value`)
      hostConfig.push(arg, value)
    } else if (/^(?:--config|--enable|--disable)=/u.test(arg) || /^-c.+/u.test(arg)) hostConfig.push(arg)
    else if (arg === '--strict-config') strictConfig = true
    else if (arg === '--remote' || arg.startsWith('--remote=')) {
      throw new Error('Telegram launcher owns its private --remote endpoint; use stock Codex for another endpoint')
    } else if (VALUE_FLAGS.has(arg)) {
      if (args[++index] === undefined) throw new Error(`${arg} requires a value`)
    } else if (!arg.startsWith('-') && command === undefined) command = arg
  }
  return {
    passthrough: passthrough || (command !== undefined && ADMIN_COMMANDS.has(command)),
    host: [...hostConfig, 'app-server', ...(strictConfig ? ['--strict-config'] : [])],
    tui: [...args],
  }
}
