#!/usr/bin/env node
/**
 * Create (or update) a DSH profile that runs dsh-superagent, then start it.
 *
 * The profile is a copy of an existing profile (default `web`): its plugin list, its `cordis.patch.yml` settings and its
 * lockfile. Model logins live in `<DSH_HOME>/.credentials.yaml`, which every profile of the same DSH home shares, so the
 * new profile needs no new login. This bundle is added as a `link:` dependency on this checkout, and the profile's own
 * patch gets the web server port and the dsh-superagent `stateDir`.
 *
 * Re-running is safe: an existing profile keeps its settings; only the dsh-superagent link, port and stateDir rows are
 * (re)written. Use --reset to copy the source profile again (this discards the target profile's own settings).
 *
 * Assumes this checkout is already built (`pnpm install && pnpm build`) and the source profile's plugins are installed.
 *
 *   node scripts/setup-profile.mjs <profile> --port <port> [options]
 *
 * Options:
 *   --port <n>          Web server port of the profile (required for a new profile).
 *   --from <profile>    Profile to copy (default: web).
 *   --state-dir <path>  dsh-superagent state directory (default: <DSH_HOME>/state/<profile>).
 *   --host <host>       Web server host (default: 127.0.0.1).
 *   --reset             Replace an existing target profile with a fresh copy of --from.
 *   --no-start          Install only; do not start the profile.
 *   --foreground        Start in this terminal instead of detached.
 *   -h, --help          Show this help.
 */
import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WINDOWS = process.platform === 'win32'
/** Files that define a profile. node_modules is reinstalled; backups and caches are not copied. */
const PROFILE_FILES = ['cordis.yml', 'cordis.patch.yml', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compatibility.json']
const BEGIN = '# >>> dsh-superagent (written by scripts/setup-profile.mjs; edits between these markers are replaced)'
const END = '# <<< dsh-superagent'

function usage(code = 0) {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const doc = text.slice(text.indexOf('/**') + 3, text.indexOf('*/')).split('\n').map(line => line.replace(/^ \* ?/, '')).join('\n').trim()
  ;(code ? console.error : console.log)(doc)
  process.exit(code)
}
function fail(message) { console.error(`setup-profile: ${message}`); process.exit(1) }
function log(message) { console.log(`setup-profile: ${message}`) }

const { values, positionals } = (() => {
  try {
    return parseArgs({ allowPositionals: true, options: {
      port: { type: 'string' }, from: { type: 'string', default: 'web' }, 'state-dir': { type: 'string' },
      host: { type: 'string', default: '127.0.0.1' }, reset: { type: 'boolean', default: false },
      'no-start': { type: 'boolean', default: false }, foreground: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    } })
  } catch (error) { console.error(error.message); return usage(1) }
})()
if (values.help) usage(0)
if (positionals.length !== 1) usage(1)

const profile = positionals[0]
if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(profile)) fail(`invalid profile name: ${profile}`)
if (profile === values.from) fail('the target profile must differ from --from')
const port = values.port === undefined ? undefined : Number(values.port)
if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) fail(`invalid port: ${values.port}`)

const dshHome = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'))
const profiles = join(dshHome, 'profiles')
const source = join(profiles, values.from)
const target = join(profiles, profile)
const stateDir = resolve(values['state-dir'] ?? join(dshHome, 'state', profile)).replaceAll('\\', '/')

/** Run the dsh CLI. On Windows, npm installs `dsh` as a .cmd shim, which needs a shell. */
function dsh(args, options = {}) {
  const result = spawnSync('dsh', args, { stdio: 'inherit', shell: WINDOWS, ...options })
  if (result.error) fail(`could not run dsh: ${result.error.message}`)
  return result.status ?? 1
}
const quote = value => WINDOWS ? `"${value}"` : value

// 1. Preconditions.
if (!existsSync(join(CHECKOUT, 'lib', 'index.js'))) fail(`${CHECKOUT} is not built: run \`pnpm install && pnpm build\` there first`)
const exists = existsSync(target)
if (!exists || values.reset) {
  if (!existsSync(join(source, 'package.json'))) fail(`source profile not found: ${source}`)
  if (port === undefined) fail('--port is required for a new profile')
}

// 2. Copy the source profile.
if (exists && values.reset) {
  if (resolve(target) === resolve(profiles) || !resolve(target).startsWith(resolve(profiles))) fail(`refusing to remove ${target}`)
  log(`removing ${target} (--reset)`)
  rmSync(target, { recursive: true, force: true })
}
if (!exists || values.reset) {
  log(`copying profile ${values.from} -> ${profile}`)
  mkdirSync(target, { recursive: true })
  for (const file of PROFILE_FILES) if (existsSync(join(source, file))) copyFileSync(join(source, file), join(target, file))
  const manifestPath = join(target, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifest.name = `dsh-profile-${profile}`
  // The source may itself carry dsh-superagent; the link is re-added below.
  if (manifest.dependencies) delete manifest.dependencies['dsh-superagent']
  const bundles = manifest.dsh?.profile?.bundles
  if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter(name => name !== 'dsh-superagent')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
} else {
  log(`updating existing profile ${profile} (settings kept)`)
}

// 3. Profile-local configuration: port and stateDir, between markers so a re-run replaces only this block.
const patchPath = join(target, 'cordis.patch.yml')
let patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
const previous = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`)
const oldPort = previous.exec(patch)?.[0].match(/port: (\d+)/)?.[1]
patch = patch.replace(previous, '\n')
// A bare `[]` (the empty profile template) cannot be followed by list items.
if (/^\s*\[\]\s*$/m.test(patch.replace(/^#.*$/gm, ''))) patch = patch.replace(/^\s*\[\]\s*$/m, '')
// Drop a webserver row a copied profile may carry, so the block below is the only one.
patch = patch.replace(/^- id: webserver\n(?:[ \t]+.*\n?)*/m, '')
const effectivePort = port ?? (oldPort ? Number(oldPort) : undefined)
if (effectivePort === undefined) fail('--port is required (the profile has no port written by this script yet)')
const block = [BEGIN,
  '- id: webserver', '  config:', `    host: ${values.host}`, `    port: ${effectivePort}`,
  '- id: dsh-superagent', '  config:', `    stateDir: ${JSON.stringify(stateDir)}`,
  END].join('\n')
writeFileSync(patchPath, `${patch.trimEnd()}\n${block}\n`)
mkdirSync(stateDir, { recursive: true })

// 4. Install the profile's plugins and link this checkout.
log('installing plugins')
if (dsh(['plugin', '--profile', profile, 'install']) !== 0) fail('plugin install failed')
log(`linking ${CHECKOUT}`)
if (dsh(['plugin', '--profile', profile, 'add', quote(`link:${CHECKOUT.replaceAll('\\', '/')}`)]) !== 0) fail('adding dsh-superagent failed')

// 5. Validate the composed configuration without starting it.
if (dsh(['--profile', profile, '--dump-config'], { stdio: ['ignore', 'ignore', 'inherit'] }) !== 0) fail('the composed profile does not validate')
log(`profile ${profile} ready: port ${effectivePort}, stateDir ${stateDir}`)

// 6. Start.
if (values['no-start']) {
  log(`start it with: dsh --profile ${profile} --no-open`)
  process.exit(0)
}
/** A failed start can leave an empty credentials lock that blocks every later start until removed. */
function clearStaleLock() {
  const lock = join(dshHome, '.credentials.yaml.lock')
  try {
    const content = readFileSync(lock, 'utf8').trim()
    let alive = false
    if (/^\d+$/.test(content)) { try { process.kill(Number(content), 0); alive = true } catch (error) { alive = error.code === 'EPERM' } }
    if (!alive && statSync(lock).isFile()) { rmSync(lock); log(`removed stale lock ${lock}`) }
  } catch { /* No lock. */ }
}
/** True when something accepts TCP connections on the port. */
function listening() {
  return new Promise(done => {
    const socket = connect({ host: values.host, port: effectivePort, timeout: 2000 })
    const end = result => { socket.destroy(); done(result) }
    socket.once('connect', () => end(true)).once('error', () => end(false)).once('timeout', () => end(false))
  })
}
if (await listening()) fail(`port ${effectivePort} is already in use; stop the running instance first`)
clearStaleLock()
if (values.foreground) {
  log(`starting dsh --profile ${profile} (Ctrl+C to stop)`)
  process.exit(dsh(['--profile', profile, '--no-open']))
}
const logDir = join(target, '.artifacts')
mkdirSync(logDir, { recursive: true })
const logFile = join(logDir, `dsh-${new Date().toISOString().replace(/[:.]/g, '-')}.log`)
const out = openSync(logFile, 'a')
const child = spawn('dsh', ['--profile', profile, '--no-open'], { detached: true, stdio: ['ignore', out, out], shell: WINDOWS, windowsHide: true })
child.unref()
log(`started (pid ${child.pid}); log: ${logFile}`)
await (async () => {
for (let i = 0; i < 60; i++) {
  await new Promise(done => setTimeout(done, 2000))
  try {
    const response = await fetch(`http://${values.host}:${effectivePort}/orchestrator/api/state`, { headers: { 'x-orchestrator-request': '1' }, signal: AbortSignal.timeout(3000) })
    if (response.ok) {
      const state = await response.json()
      const problem = state.setup?.problem?.detail
      log(`up at http://${values.host}:${effectivePort}/ (open the URL with ?token=… printed in the log)`)
      if (problem) log(`setup needed: ${problem}  — configure it under Superagent in the sidebar`)
      // Return instead of process.exit(): exiting with fetch sockets still open crashes Node on Windows.
      process.exitCode = 0
      return
    }
  } catch { /* Not up yet. */ }
  const text = readFileSync(logFile, 'utf8')
  if (/startup failed/.test(text)) { console.error(text); fail('dsh failed to start; see the log above') }
}
fail(`dsh did not answer on port ${effectivePort} within 2 minutes; see ${logFile}`)
})()
