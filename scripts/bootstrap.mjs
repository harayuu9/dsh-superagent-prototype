#!/usr/bin/env node
/**
 * Set up dsh-superagent on a machine from scratch, after `git clone` of this repository, in one run:
 *
 *   1. check the tools (Node, pnpm, git, gh, dsh, and pwsh on Windows), installing pnpm and dsh when missing;
 *   2. build this checkout (`pnpm install && pnpm build`);
 *   3. create the agent's GitHub CLI wrapper `gh-agent` (an .exe on Windows, a shell script elsewhere) and sign it in;
 *   4. create and start the profile (scripts/setup-profile.mjs);
 *   5. optionally clone the target repository and save the Superagent settings through its management API.
 *
 * Every step is skipped when already done, so it is safe to re-run. Steps that need a person (a model login in DSH, the
 * agent's GitHub login in the browser) stop with the command to run, or ask and wait when run interactively.
 *
 *   node scripts/bootstrap.mjs [options]
 *
 * Profile:
 *   --profile <name>        Profile to create (default: superagent).
 *   --port <n>              Its web server port (default: 3082).
 *   --from <profile>        Profile to copy plugins, settings and model login from (default: web).
 *
 * Superagent settings (all optional; set only what is given, the rest stays as saved or default):
 *   --repo <owner/name>     GitHub repository the agent works on.
 *   --allow <logins>        Comma-separated GitHub logins that may ask for work.
 *   --clone <dir>           Local clone the tickets' worktrees come from; cloned from --repo when missing.
 *   --work <dir>            Directory of the tickets' worktrees (default: <clone>/../work).
 *   --author <login>        Commit author; the agent account when omitted. Written into the Delivery prompt.
 *   --settings <file>       JSON of settings to apply as is (see --export); flags above override it.
 *   --export <file>         Write the running profile's settings to <file> and exit, to carry them to another machine.
 *
 * Other:
 *   --dsh-version <v>       dsh version to install when dsh is missing (default: 0.2.1-rc.3).
 *   --skip-login            Do not run the agent's `gh auth login`; fail if it is not signed in.
 *   --yes                   Do not ask; fail where a person is needed.
 *   -h, --help              Show this help.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline/promises'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const CHECKOUT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WINDOWS = process.platform === 'win32'
const HOME = homedir()

function usage(code = 0) {
  const text = readFileSync(fileURLToPath(import.meta.url), 'utf8')
  const doc = text.slice(text.indexOf('/**') + 3, text.indexOf('*/')).split('\n').map(line => line.replace(/^ \* ?/, '')).join('\n').trim()
  ;(code ? console.error : console.log)(doc)
  process.exit(code)
}
const step = message => console.log(`\n== ${message}`)
const log = message => console.log(`   ${message}`)
function fail(message) { console.error(`\nbootstrap: ${message}`); process.exit(1) }

const { values: opts } = (() => {
  try {
    return parseArgs({ options: {
      profile: { type: 'string', default: 'superagent' }, port: { type: 'string', default: '3082' }, from: { type: 'string', default: 'web' },
      repo: { type: 'string' }, allow: { type: 'string' }, clone: { type: 'string' }, work: { type: 'string' }, author: { type: 'string' },
      settings: { type: 'string' }, export: { type: 'string' }, 'dsh-version': { type: 'string', default: '0.2.1-rc.3' },
      'skip-login': { type: 'boolean', default: false }, yes: { type: 'boolean', default: false }, help: { type: 'boolean', short: 'h', default: false },
    } })
  } catch (error) { console.error(error.message); return usage(1) }
})()
if (opts.help) usage(0)
const port = Number(opts.port)
if (!(Number.isInteger(port) && port > 0 && port < 65536)) fail(`invalid port: ${opts.port}`)
if (opts.repo && !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(opts.repo)) fail(`--repo must be owner/name: ${opts.repo}`)
const interactive = !opts.yes && process.stdin.isTTY

/**
 * Arguments for spawn. On Windows npm installs commands (pnpm, dsh) as .cmd shims, which only start through a shell; with
 * `shell` the arguments are joined as one command line, so quote them here (Node warns, DEP0190, when given an array).
 */
function invocation(command, args, options) {
  const shell = options.shell ?? WINDOWS
  if (!shell) return [command, args, options]
  const line = [command, ...args].map(arg => /[\s"&|<>^()]/.test(arg) ? `"${arg.replaceAll('"', '\\"')}"` : arg).join(' ')
  return [line, [], { ...options, shell: true }]
}
/** Run a command and return its trimmed stdout, or undefined when it cannot run or fails. */
function output(command, args, options = {}) {
  try { return execFileSync(...invocation(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], ...options })).trim() }
  catch { return undefined }
}
/** Run a command with the terminal attached; fail on a non-zero exit. */
function run(command, args, options = {}) {
  const result = spawnSync(...invocation(command, args, { stdio: 'inherit', ...options }))
  if (result.error || result.status !== 0) fail(`\`${[command, ...args].join(' ')}\` failed${result.error ? `: ${result.error.message}` : ''}`)
}
const quote = value => WINDOWS && /[\s"]/.test(value) ? `"${value}"` : value
async function ask(question) {
  if (!interactive) return ''
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try { return (await rl.question(`   ${question} `)).trim() } finally { rl.close() }
}
/** Compare dotted versions numerically, ignoring prerelease tags. */
function atLeast(version, minimum) {
  const a = (version.match(/\d+(\.\d+)*/)?.[0] ?? '0').split('.').map(Number)
  const b = minimum.split('.').map(Number)
  for (let i = 0; i < b.length; i++) { if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i] }
  return true
}

const dshHome = resolve(process.env.DSH_HOME || join(HOME, '.dsh'))
const api = `http://127.0.0.1:${port}/orchestrator/api`
const headers = { 'x-orchestrator-request': '1' }
async function call(method, path, body) {
  const response = await fetch(`${api}/${path}`, { method, headers: { ...headers, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(180_000) })
  const text = await response.text()
  let json; try { json = JSON.parse(text) } catch { json = { error: text } }
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${json.error ?? text}${json.setup ? ` (${JSON.stringify(json.setup)})` : ''}`)
  return json
}
/** Wait until the management API answers and the runtime is no longer starting. */
async function waitReady(seconds = 120) {
  for (let i = 0; i < seconds / 2; i++) {
    try { const state = await call('GET', 'state'); if (state.health?.runtime?.state !== 'starting') return state } catch { /* Restarting. */ }
    await new Promise(done => setTimeout(done, 2000))
  }
  fail(`Superagent on port ${port} did not answer within ${seconds} s`)
}

// --export: read the settings of a running profile and stop. The script ends by returning, not process.exit(): exiting
// while fetch's sockets close crashes Node on Windows (libuv assertion).
async function exportSettings() {
  const settings = await call('GET', 'settings')
  const prompts = await call('GET', 'prompts')
  const github = settings.sources.find(source => source.id === 'github')?.value
  const exported = { github, policy: settings.blocks.policy.value, eval: settings.blocks.eval.value, executor: settings.blocks.executor.value, prompts: prompts.current.config }
  writeFileSync(opts.export, `${JSON.stringify(exported, null, 2)}\n`)
  console.log(`bootstrap: wrote the settings of port ${port} to ${opts.export}; machine paths in it (github.cli, executor.directory, executor.prepare) are replaced on import`)
}
if (opts.export) await exportSettings()
else await main()

async function main() {
// 1. Tools.
step('Tools')
const [major, minor] = process.versions.node.split('.').map(Number)
if (!(major >= 24 || (major === 22 && minor >= 19))) fail(`Node.js 22.19+ or 24+ is required (this is ${process.versions.node})`)
log(`node ${process.versions.node}`)
const git = output('git', ['--version'])
if (!git) fail('git is not installed: install git 2.32 or later')
if (!atLeast(git.replace(/^git version /, ''), '2.32')) fail(`git 2.32 or later is required (${git})`)
log(git)
/** How to install a current gh. Distribution packages (Ubuntu's `gh` is 2.46) lag behind; GitHub's apt repository does not. */
function ghInstallHint() {
  if (WINDOWS) return 'winget install GitHub.cli   (or: winget upgrade GitHub.cli)'
  if (existsSync('/etc/debian_version')) return [
    "GitHub's apt repository (Ubuntu's own gh package is too old):",
    '  sudo mkdir -p -m 755 /etc/apt/keyrings',
    '  wget -nv -O- https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo tee /etc/apt/keyrings/githubcli-archive-keyring.gpg > /dev/null',
    '  sudo chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg',
    '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null',
    '  sudo apt update && sudo apt install gh',
    'then re-run this script.',
  ].join('\n')
  if (process.platform === 'darwin') return 'brew install gh   (or: brew upgrade gh)'
  return 'see https://github.com/cli/cli#installation'
}
const gh = output('gh', ['--version'])?.split('\n')[0]
if (!gh) fail(`the GitHub CLI is not installed. Install it with ${ghInstallHint()}`)
if (!atLeast(gh.replace(/^gh version /, ''), '2.48')) fail(`GitHub CLI 2.48 or later is required (${gh}). Update it with ${ghInstallHint()}`)
log(gh)
if (WINDOWS) {
  if (!output('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'])) fail('PowerShell 7 (pwsh) is required for the prepare command: winget install Microsoft.PowerShell')
  log('pwsh found')
}
if (!output('pnpm', ['--version'])) {
  log('pnpm is missing: installing it with npm')
  run('npm', ['install', '-g', 'pnpm'])
}
log(`pnpm ${output('pnpm', ['--version'])}`)
let dshVersion = output('dsh', ['--version'])
if (!dshVersion) {
  log(`dsh is missing: installing @deepseek-ai/dsh@${opts['dsh-version']}`)
  run('npm', ['install', '-g', `@deepseek-ai/dsh@${opts['dsh-version']}`])
  dshVersion = output('dsh', ['--version']) ?? fail('dsh is still not on PATH after installing it; open a new terminal and re-run')
}
log(`dsh ${dshVersion}`)

// 2. The source profile with a model login.
step(`Source profile "${opts.from}"`)
if (!existsSync(join(dshHome, 'profiles', opts.from, 'package.json'))) {
  log(`creating it from the shipped "${opts.from}" template`)
  run('dsh', [opts.from, '--from-default-profile', opts.from, '--dump-config'], { stdio: ['ignore', 'ignore', 'inherit'] })
}
const credentials = join(dshHome, '.credentials.yaml')
const hasModelLogin = () => existsSync(credentials) && /^\s{2}\S/m.test(readFileSync(credentials, 'utf8').replace(/^\s{2}client-connection\/browser-session:.*$/m, ''))
if (!hasModelLogin()) {
  const message = `No model login yet. Run \`dsh ${opts.from}\`, add a model provider in Settings → Models, then close it.`
  if (!interactive) fail(message)
  log(message)
  await ask('Press Enter when the model login is done...')
  if (!hasModelLogin()) fail('still no model login found')
}
log('model login found (shared by every profile of this DSH home)')

// 3. Build.
step('Build')
if (!existsSync(join(CHECKOUT, 'node_modules'))) run('pnpm', ['install'], { cwd: CHECKOUT })
run('pnpm', ['build'], { cwd: CHECKOUT })

// 4. The agent's GitHub CLI.
step('Agent GitHub CLI (gh-agent)')
const bin = join(HOME, '.local', 'bin')
mkdirSync(bin, { recursive: true })
mkdirSync(join(HOME, '.config', 'gh-agent'), { recursive: true })
const ghAgent = join(bin, WINDOWS ? 'gh-agent.exe' : 'gh-agent')
if (WINDOWS) {
  const csc = join(process.env.WINDIR ?? 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe')
  if (!existsSync(csc)) fail(`the .NET Framework C# compiler was not found at ${csc}`)
  run(csc, ['/nologo', '/optimize', `/out:${ghAgent}`, join(CHECKOUT, 'scripts', 'gh-agent.cs')], { shell: false, stdio: ['ignore', 'ignore', 'inherit'] })
} else {
  writeFileSync(ghAgent, '#!/bin/sh\nGH_CONFIG_DIR="$HOME/.config/gh-agent" exec gh "$@"\n')
  chmodSync(ghAgent, 0o755)
}
log(ghAgent)
const agentLogin = () => output(ghAgent, ['api', 'user', '--jq', '.login'], { shell: false })
let agent = agentLogin()
if (!agent) {
  if (opts['skip-login'] || !interactive) fail(`gh-agent is not signed in. Sign it in as the agent account (not your own), then re-run:\n  ${quote(ghAgent)} auth login --hostname github.com --git-protocol https --web --insecure-storage`)
  log('Sign in as the AGENT account (a dedicated GitHub user, not your own) in the browser that opens.')
  // --insecure-storage keeps the token in gh-agent's own hosts.yml. Without it the token goes to the OS keyring, which
  // every gh shares, and your own gh and git would act as the agent.
  run(ghAgent, ['auth', 'login', '--hostname', 'github.com', '--git-protocol', 'https', '--web', '--insecure-storage'], { shell: false })
  agent = agentLogin() ?? fail('gh-agent is still not signed in')
}
log(`signed in as ${agent}`)
const personal = output('gh', ['api', 'user', '--jq', '.login'])
if (personal && personal === agent) log(`warning: your own gh is also signed in as ${agent}; run \`gh auth switch\` to your own account`)
if (opts.repo) {
  const push = output(ghAgent, ['api', `repos/${opts.repo}`, '--jq', '.permissions.push'], { shell: false })
  if (push !== 'true') fail(`${agent} cannot push to ${opts.repo}: give it write access (and accept the invitation as ${agent})`)
  log(`${agent} can push to ${opts.repo}`)
}

// 5. The local clone the tickets' worktrees come from.
let clone, work
if (opts.clone) {
  step('Repository clone')
  clone = resolve(opts.clone)
  work = resolve(opts.work ?? join(dirname(clone), 'work'))
  if (!existsSync(join(clone, '.git'))) {
    if (!opts.repo) fail(`${clone} is not a git clone, and --repo was not given to clone it`)
    mkdirSync(dirname(clone), { recursive: true })
    // Cloned with your own credentials; the agent's git never reads this clone's remote credentials.
    run('git', ['clone', `https://github.com/${opts.repo}.git`, clone])
  }
  mkdirSync(work, { recursive: true })
  log(`clone ${clone}`)
  log(`work  ${work}`)
}

// 6. The profile.
step(`Profile "${opts.profile}"`)
const setup = [join(CHECKOUT, 'scripts', 'setup-profile.mjs'), opts.profile, '--port', String(port), '--from', opts.from]
const running = await fetch(`${api}/state`, { headers, signal: AbortSignal.timeout(3000) }).then(r => r.ok, () => false)
if (running) {
  log(`already running on port ${port}: updating without restarting`)
  run(process.execPath, [...setup, '--no-start'], { shell: false })
} else {
  run(process.execPath, setup, { shell: false })
}
await waitReady()

// 7. Superagent settings.
const imported = opts.settings ? JSON.parse(readFileSync(opts.settings, 'utf8')) : {}
const wantsSettings = opts.settings || opts.repo || opts.allow || opts.clone || opts.author
if (wantsSettings) {
  step('Superagent settings')
  let settings = await call('GET', 'settings')

  // GitHub Source: repository and the agent CLI of this machine. Saving it checks the account and restarts Superagent.
  const github = settings.sources.find(source => source.id === 'github')
  const repository = opts.repo ?? imported.github?.config?.repository
  if (repository) {
    const value = { ...github.value, ...(imported.github ?? {}), enabled: true, config: { ...github.value.config, ...(imported.github?.config ?? {}), repository, cli: ghAgent } }
    const saved = await call('PUT', 'settings/source:github', { value, revision: github.revision })
    log(`GitHub Source: ${repository} as ${agent}`)
    if (saved.restarting) { await new Promise(done => setTimeout(done, 3000)); await waitReady() }
    settings = await call('GET', 'settings')
  }

  // Policy: who may ask.
  const policy = structuredClone(imported.policy ?? settings.blocks.policy.value)
  if (opts.allow) {
    policy.sources ??= {}
    policy.sources.github = { ...(policy.sources.github ?? {}), allowed: opts.allow.split(',').map(id => ({ id: id.trim() })).filter(entry => entry.id) }
    policy.sources.github.bots ??= []
  }
  if (opts.allow || imported.policy) {
    await call('PUT', 'settings/policy', { value: policy, revision: settings.blocks.policy.revision })
    log(`Policy: ${(policy.sources?.github?.allowed ?? []).map(entry => entry.id).join(', ') || '(nobody yet)'} may ask`)
  }

  if (imported.eval) await call('PUT', 'settings/eval', { value: imported.eval, revision: settings.blocks.eval.revision })

  // Execution: worktree directory and a prepare command for this machine's clone.
  if (clone || imported.executor) {
    const executor = { ...settings.blocks.executor.value, ...(imported.executor ?? {}) }
    if (clone) {
      executor.directory = work
      executor.prepare = WINDOWS ? [
        "$ErrorActionPreference = 'Stop'",
        `$repo = '${clone.replaceAll("'", "''")}'`,
        "$src = if ($env:DSH_SUPERAGENT_GITHUB_PR_HEAD) { $env:DSH_SUPERAGENT_GITHUB_PR_HEAD } else { 'HEAD' }",
        '$ref = "refs/dsh-superagent/$env:DSH_SUPERAGENT_TICKET"',
        'git -C $repo fetch --no-tags "https://github.com/$env:DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "${src}:$ref"',
        'if ($LASTEXITCODE) { exit $LASTEXITCODE }',
        'git -C $repo worktree add -b "agent/$env:DSH_SUPERAGENT_NAME" "$env:DSH_SUPERAGENT_DIR" $ref',
        'exit $LASTEXITCODE',
      ].join('\n') : [
        `git -C '${clone.replaceAll("'", "'\\''")}' fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" "\${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" &&`,
        `git -C '${clone.replaceAll("'", "'\\''")}' worktree add -b "agent/$DSH_SUPERAGENT_NAME" "$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"`,
      ].join('\n')
    } else if (imported.executor) {
      log('warning: --settings has a prepare command and directory from another machine; pass --clone to replace them')
    }
    await call('PUT', 'settings/executor', { value: executor, revision: settings.blocks.executor.revision })
    log(`Execution: ${executor.directory || '(default)'}`)
  }

  // Prompts: commit author, and no auto-merge (a person merges every PR).
  const prompts = await call('GET', 'prompts')
  const config = structuredClone(imported.prompts ?? prompts.current.config)
  const author = opts.author ?? (imported.prompts ? undefined : agent)
  if (author || imported.prompts) {
    let delivery = config.delivery ?? ''
    const start = delivery.indexOf('Never enable auto-merge'), end = delivery.indexOf('Credit each person')
    if (start >= 0 && end > start) {
      delivery = `${delivery.slice(0, start)}Never enable auto-merge, approve or merge a PR: a person merges every PR; say so in your report. ${delivery.slice(end)}`
        .replace('Withdraw auto-merge first as above. ', '')
    }
    if (author) {
      delivery = delivery.replace(/\nCommit author: [\s\S]*$/, '')
      const email = author === agent ? '$DSH_SUPERAGENT_GITHUB_COMMIT_EMAIL' : `the noreply address of ${author}`
      delivery += `\nCommit author: commit as ${author}, with \`git -c user.name=${author} -c user.email=${email} commit\`, or set them with \`git config user.name\` / \`user.email\` in the ticket's worktree. The commit author is ${author}.`
    }
    config.delivery = delivery
    await call('PUT', 'prompts', { config, baseRevision: prompts.current.revision })
    log(`Prompts: commit author ${author ?? '(as imported)'}, no auto-merge`)
  }
}

// 8. Result.
step('Done')
const state = await call('GET', 'state')
const problem = state.setup?.problem
log(`Superagent: http://127.0.0.1:${port}/ (the URL with ?token=… is in ${join(dshHome, 'profiles', opts.profile, '.artifacts')})`)
if (problem) log(`setup still needs: ${problem.detail}  — set it under Superagent → 設定, or re-run with --repo/--allow/--clone`)
else log(`ready: ${state.setup.accounts?.agent} works on ${state.setup.accounts?.repository}`)
log('Do not run Superagent for the same agent account and repository on two machines at once: both would answer the same requests.')
}
