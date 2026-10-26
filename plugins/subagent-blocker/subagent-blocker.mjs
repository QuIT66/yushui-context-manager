/**
 * subagent-blocker — read the per-project assembly declaration, and enforce the
 * declaration's delegation budget on every dispatch call.
 *
 * WHY: the assembly declaration (`<cwd>/.dsh/profile.yml`) is meant to become the
 * single source of truth for what a session mounts, injects, or is allowed to
 * write. Step 1 was deliberately READ-ONLY: it read the declaration,
 * recorded one log line per session, and changed nothing else. Step 2 (this
 * revision) adds the first thing the declaration actually ENFORCES: a
 * `budget.maxSpawns` / `budget.maxDelegationDepth` fuse on delegation.
 *
 * WHY delegation and nothing else: dsh already guards RECURSION DEPTH natively
 * (`tool-subagent` `maxDepth`, default 3, enforced by `resolveChildDepth()` when a
 * child session is created), but nothing bounds the HORIZONTAL fan-out — one plugin
 * once spawned 930 sub-sessions batch after batch, each re-inheriting its own preset.
 * So this file caps fan-out per session, and
 * lets a project tighten depth below the native 3. The write policy is explicitly
 * out of scope (the sandbox line was dropped wholesale), and so is `restrict()`: a
 * fuse refuses one call, it never rewrites the tool set — rewriting the tool set
 * invalidates the prompt cache.
 *
 * Hard rules this file is written to satisfy:
 *  - A throw from here can keep a session from starting at all (the plugin is
 *    mounted on a preset), so `apply()`, both listeners, the profile reader, the
 *    declaration scraper and the subagent query each degrade on their own.
 *  - FAIL-OPEN, always. A plugin bug must never refuse a tool call: a false deny
 *    breaks real work, while a missed deny is one log line away from being seen.
 *  - No declaration -> no behavior change. Without `<cwd>/.dsh/profile.yml` this
 *    plugin is invisible to the session.
 *  - A field bites only when the declaration sets it. No `budget:` block, or a
 *    `budget:` block without `maxSpawns`, means that limit does not exist — it is
 *    never a default deny.
 *  - `next()` is called OUTSIDE every try/catch, so a downstream listener's
 *    rejection propagates exactly as it does without this plugin.
 *
 * READ vs LOG are separate concerns since step 2:
 *  - The LOG is once per session ACROSS resumes (an in-memory Set for the common
 *    case plus a per-session flag file, because a resumed session runs in a fresh
 *    process that would otherwise repeat the line). No `PROFILE-*` line repeats.
 *  - The READ happens again on every dispatch call, with no cache and therefore no
 *    invalidation, so editing the declaration takes effect on the very next call
 *    ("the declaration is the single source of truth — change it once, it applies
 *    everywhere"). Delegation calls are rare, so the extra read costs nothing.
 *
 * Budget semantics — both limits are counted in DURABLE facts, never in process
 * memory, so a restart or a resume cannot refund budget:
 *  - `budget.maxSpawns`: how many DIRECT child sessions this session may ever have
 *    spawned. Counted as `ctx.subagents.listChildren(<session id>).length` — dsh's
 *    own durable listing, which enumerates every session whose header carries
 *    `parentSession: <this session>` with `origin: 'subagent'`, live or cold. The
 *    count is therefore CUMULATIVE HISTORY, not "currently alive": a child that
 *    already finished, or was archived in the UI, still counts. That is the point
 *    — "one batch after another" only stops under a cumulative cap, because a cap
 *    on live children is refunded every time a child settles.
 *  - `budget.maxDelegationDepth`: the deepest delegation depth this project allows
 *    a session to reach, i.e. the deepest child session allowed to exist. A session
 *    at depth `d` may spawn only while `d < maxDelegationDepth`, because its child
 *    would be `d + 1`. That is the SAME axis and the SAME arithmetic as the native
 *    `tool-subagent` `maxDepth` (default 3 == `maxDelegationDepth: 3`), so a
 *    project can only ever make it STRICTER; setting it to 3 or more is inert
 *    because the native cap rejects first. Depth is read from
 *    `agent.session.header.delegationDepth` (an absent header field means 0).
 *
 * Behavior:
 *  - On the first `agent/pre-step` of each session, read `<cwd>/.dsh/profile.yml`
 *    where cwd comes from `agent.session.header.cwd` — NOT `ctx.cwd`, which is
 *    always undefined here and has silently broken plugins before.
 *    Present -> `PROFILE-LOADED cwd=<cwd> keys=[...] sha=<8>`; absent ->
 *    `PROFILE-ABSENT cwd=<cwd>`; unreadable -> `PROFILE-ERROR cwd=<cwd> reason=...`;
 *    no cwd -> `PROFILE-NOCWD session=<id>`.
 *  - On every `tools/pre-execute` whose name is a delegation tool, read the
 *    declaration fresh and check both limits: over a limit -> `{ kind: 'deny',
 *    reason }` plus one `BUDGET-DENY` log line; otherwise `next()`.
 *  - A degraded check (the child count cannot be taken) is fail-open AND loud: it
 *    records one `BUDGET-DEGRADED` line in this plugin's own log as well as a
 *    logger warning, so a fuse that stopped biting is visible instead of silent.
 *
 * Why the gate registers with `{ global: true, prepend: true }`: `tools/pre-execute`
 * is dispatched over a scope carrier whose context filter is meant to admit only a
 * listener whose own context sits on the agent's scope chain. In this cordis
 * version the filter admits a preset-mounted listener unconditionally, because the
 * recorded listener context is the untagged root (one `EventsService` is built at
 * the root and inherited by every derived context). Measured against the
 * real `ToolRuntime`: a listener registered under one mount still fires for an agent
 * parented to a different mount. So `global: true` changes nothing today; it is kept
 * so a future change that starts tagging listener contexts cannot make the gate
 * silently stop firing (dsh's own cross-scope listeners pass the same option).
 * `prepend: true` keeps the budget decision ahead of other policy listeners.
 *  - Does NOT: restrict tools, inject a prompt, refuse anything else, commit, or
 *    write anywhere except the log directory.
 *
 * The keys and values are scraped from the declaration's own text rather than
 * parsed with a YAML library: this module is loaded from
 * `~/.dsh/.agent-presets/`, where no upward node_modules walk reaches a YAML
 * parser, and an import that fails would take the whole plugin (including step 1's
 * logging) down with it. The scraper is total — malformed input yields "no limits
 * configured", never an exception.
 */

import { appendFile, mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'subagent-blocker'

/** Append-only log; one line per session that reaches an observation. */
const LOG_PATH = join(homedir(), '.dsh', 'staging', 'subagent-blocker.log')

/** Per-session "already observed" flags. One small file per session; pruned by age. */
const FLAG_DIR = join(homedir(), '.dsh', 'staging', 'subagent-blocker')
const FLAG_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Declaration location, relative to the session cwd. */
const PROFILE_SEGMENTS = ['.dsh', 'profile.yml']

/**
 * Tool names that create a child session. These are the four `tool-subagent`
 * (`@deepseek-ai/dsh-tool-subagent`) instances shipped in this deployment's
 * presets; the name is configurable per mount, so a deployment that renames the
 * tool can add the new name through the plugin's own `dispatchTools` config.
 * `send_message` is deliberately absent: it steers an existing child and creates
 * no session, so it must never be refused by a spawn budget.
 */
const DEFAULT_DISPATCH_TOOLS = ['subagent', 'subagent_fork', 'subagent_codex', 'subagent_claude_code']

/** Best-effort, once per process: drop flags for long-gone sessions. */
let pruned = false
async function pruneFlags() {
  if (pruned) return
  pruned = true
  try {
    const now = Date.now()
    for (const entry of await readdir(FLAG_DIR)) {
      const path = join(FLAG_DIR, entry)
      const info = await stat(path)
      if (now - info.mtimeMs > FLAG_TTL_MS) await unlink(path)
    }
  } catch {
    // Directory absent or unreadable — nothing to prune.
  }
}

/** Has this session already been observed (in any process)? */
async function hasFlag(key) {
  try {
    await stat(join(FLAG_DIR, key))
    return true
  } catch {
    return false
  }
}

/** Record that this session has been observed. */
async function setFlag(key) {
  try {
    await mkdir(FLAG_DIR, { recursive: true })
    await writeFile(join(FLAG_DIR, key), `${new Date().toISOString()}\n`, { flag: 'w' })
  } catch {
    // Non-fatal: worst case a resumed session repeats its one line.
  }
}

/** Append one timestamped line. Never rejects. */
async function log(line) {
  try {
    const text = String(line).replace(/\s+/gu, ' ').slice(0, 2000)
    await mkdir(dirname(LOG_PATH), { recursive: true })
    await appendFile(LOG_PATH, `${new Date().toISOString()} ${text}\n`, { encoding: 'utf8' })
  } catch {
    // Logging is diagnostic only — a failure must not affect the session.
  }
}

/** Session ids reach the filesystem as flag names, so keep them to safe characters. */
function flagKey(sessionId) {
  return String(sessionId).replace(/[^A-Za-z0-9._-]/gu, '_').slice(0, 200)
}

/**
 * The session's working directory, or undefined when the session header carries none.
 * The ONLY supported source: `agent.session.header.cwd`.
 */
function sessionCwd(agent) {
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd !== '' ? cwd : undefined
}

/** The session's durable id, or undefined when the header carries none. */
function sessionIdOf(agent) {
  const id = agent?.session?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

/**
 * The delegating session's own delegation depth. A missing, negative, or
 * non-integer header field means top-level (0), matching
 * `resolveChildDepth()`'s own tolerance for an omitted depth.
 */
function delegationDepthOf(agent) {
  const depth = agent?.session?.header?.delegationDepth
  return typeof depth === 'number' && Number.isSafeInteger(depth) && depth > 0 ? depth : 0
}

/** Top-level `key:` names, in file order, deduplicated. Comments and nesting ignored. */
function topLevelKeys(text) {
  const keys = []
  for (const line of text.split(/\r?\n/u)) {
    if (line === '' || /^\s/u.test(line) || line.startsWith('#')) continue
    const match = /^([A-Za-z0-9_.-]+)\s*:/u.exec(line)
    if (match !== null) keys.push(match[1])
  }
  return [...new Set(keys)]
}

/** Short content digest, so later steps can prove whether a cached read is stale. */
function contentSha(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 8)
}

/** A short, single-line reason for a diagnostic line. Never throws on a hostile value. */
function reasonOf(error) {
  try {
    const code = error?.code
    const message = error?.message
    return String(typeof code === 'string' && code !== '' ? code : message ?? error).replace(/\s+/gu, ' ').slice(0, 160)
  } catch {
    return '<unprintable thrown value>'
  }
}

/** A declaration read outcome. Every branch is a value; none of them is an exception. */
/** @returns `{ kind: 'loaded', text }` | `{ kind: 'absent' }` | `{ kind: 'error', reason }` */
async function readProfile(cwd) {
  try {
    const text = await readFile(join(cwd, ...PROFILE_SEGMENTS), { encoding: 'utf8' })
    return { kind: 'loaded', text: typeof text === 'string' ? text : '' }
  } catch (error) {
    const code = error?.code
    return code === 'ENOENT' || code === 'ENOTDIR'
      ? { kind: 'absent' }
      : { kind: 'error', reason: reasonOf(error) }
  }
}

/** Drop a trailing `#` comment, ignoring a `#` inside quotes. */
function stripComment(line) {
  let quote = ''
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i]
    if (quote !== '') {
      if (char === quote) quote = ''
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (char === '#' && (i === 0 || /\s/u.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

/** Leading indentation width of a line. */
function indentOf(line) {
  return /^[ \t]*/u.exec(line)[0].length
}

/** `key: value` of one mapping line; undefined for a bare nested key or a list item. */
function splitPair(line) {
  const match = /^\s*(?:-\s*)?([A-Za-z0-9_.-]+)\s*:[ \t]*(.*)$/u.exec(line)
  if (match === null) return undefined
  const value = match[2].trim()
  if (value === '') return undefined
  return [match[1], value]
}

/** Pairs of one inline mapping, e.g. `{ maxSpawns: 6, maxDelegationDepth: 2 }`. */
function inlinePairs(text) {
  const body = text.trim().replace(/^\{/u, '').replace(/\}$/u, '')
  return body.split(',').map(splitPair).filter(pair => pair !== undefined)
}

/**
 * Direct-child pairs of the first top-level `budget:` mapping, or undefined when
 * the declaration has no such key. Only one nesting level is read, so a nested
 * block under `budget:` cannot smuggle in a value; an unrelated `maxSpawns` under
 * some other top-level key is never reached.
 */
function budgetPairs(text) {
  const lines = text.split(/\r?\n/u)
  for (let i = 0; i < lines.length; i += 1) {
    const head = stripComment(lines[i])
    if (head.trim() === '' || /^\s/u.test(head)) continue
    const open = /^([A-Za-z0-9_.-]+)\s*:[ \t]*(.*)$/u.exec(head)
    if (open === null || open[1] !== 'budget') continue
    const inline = open[2].trim()
    if (inline !== '') return inlinePairs(inline)
    const block = []
    for (let j = i + 1; j < lines.length; j += 1) {
      const body = stripComment(lines[j])
      if (body.trim() === '') continue
      if (!/^\s/u.test(body)) break
      block.push(body)
    }
    if (block.length === 0) return []
    const baseIndent = indentOf(block[0])
    return block
      .filter(line => indentOf(line) === baseIndent)
      .map(splitPair)
      .filter(pair => pair !== undefined)
  }
  return undefined
}

/** A non-negative safe integer written as a plain number, quotes optional. */
function countOf(raw) {
  const token = String(raw).trim().replace(/^["']|["']$/gu, '').trim()
  if (!/^\+?\d+$/u.test(token)) return undefined
  const value = Number(token)
  return Number.isSafeInteger(value) && value >= 0 ? value : undefined
}

/** One budget value from direct-child pairs. A present but non-numeric value means "unset". */
function budgetValue(pairs, key) {
  for (const pair of pairs) {
    if (pair[0] !== key) continue
    return countOf(pair[1])
  }
  return undefined
}

/** Read a service by name without the inject requirement, tolerating either accessor. */
function serviceOf(ctx, key) {
  try {
    const viaGet = ctx?.get?.(key)
    if (viaGet !== undefined) return viaGet
  } catch {
    // Fall through to the property proxy.
  }
  try {
    return ctx?.[key]
  } catch {
    return undefined
  }
}

/**
 * How many direct child sessions this session has ever created, from dsh's own
 * durable listing. `undefined` when the count cannot be taken — an unreadable
 * listing is a degraded fuse (loud in the log), never a refusal.
 */
async function childCountOf(ctx, agent, signal) {
  const subagents = serviceOf(ctx, 'subagents')
  if (subagents === undefined || typeof subagents.listChildren !== 'function') return undefined
  const sessionId = sessionIdOf(agent)
  if (sessionId === undefined) return undefined
  const entries = await subagents.listChildren(sessionId, signal)
  return Array.isArray(entries) ? entries.length : undefined
}

/**
 * The delegation budget decision for one dispatch call.
 * @returns `{ reason, detail }` when the call must be refused, else undefined.
 *   Never throws: every failure path returns undefined, which lets the call pass.
 */
async function budgetDecision(ctx, exec, dispatchTools, onDegraded) {
  try {
    const toolName = exec?.name
    if (typeof toolName !== 'string' || !dispatchTools.has(toolName)) return undefined
    const agent = exec?.agent
    if (agent === undefined || agent === null) return undefined
    const cwd = sessionCwd(agent)
    if (cwd === undefined) return undefined

    const profile = await readProfile(cwd)
    if (profile.kind !== 'loaded') return undefined
    const pairs = budgetPairs(profile.text)
    if (pairs === undefined) return undefined
    const maxSpawns = budgetValue(pairs, 'maxSpawns')
    const maxDepth = budgetValue(pairs, 'maxDelegationDepth')
    if (maxSpawns === undefined && maxDepth === undefined) return undefined

    const where = `${join(cwd, ...PROFILE_SEGMENTS)}`
    const depth = delegationDepthOf(agent)
    if (maxDepth !== undefined && depth >= maxDepth) {
      return {
        reason: `装配声明预算 maxDelegationDepth=${maxDepth} 已达上限：本会话 delegationDepth=${depth}，`
          + `再派会得到深度 ${depth + 1} 的子代理。来源 ${where}。要更深请调高该字段或另起会话。`,
        detail: `BUDGET-DENY tool=${toolName} cwd=${cwd} limit=maxDelegationDepth=${maxDepth} depth=${depth}`,
      }
    }

    if (maxSpawns !== undefined) {
      const count = await childCountOf(ctx, agent, exec?.signal)
      if (count === undefined) {
        onDegraded(`subagents.listChildren unavailable — maxSpawns=${maxSpawns} not enforced for cwd=${cwd}`)
        return undefined
      }
      if (count >= maxSpawns) {
        return {
          reason: `装配声明预算 maxSpawns=${maxSpawns} 已达上限：本会话历史累计已派出 ${count} 个直接子代理`
            + `（含已结束/已归档的，计数器不因它们结束而回退）。来源 ${where}。`
            + `要继续请复用已有子代理（send_message）、调高该字段，或另起会话。`,
          detail: `BUDGET-DENY tool=${toolName} cwd=${cwd} limit=maxSpawns=${maxSpawns} count=${count} depth=${depth}`,
        }
      }
    }
    return undefined
  } catch (error) {
    onDegraded(`budget check failed, letting the call through: ${reasonOf(error)}`)
    return undefined
  }
}

/** Read the declaration once for this session and record exactly one line. */
async function observeOnce(agent, seen) {
  const sessionId = sessionIdOf(agent)
  if (typeof sessionId !== 'string' || sessionId === '') return
  if (seen.has(sessionId)) return
  seen.add(sessionId)

  const key = flagKey(sessionId)
  await pruneFlags()
  if (await hasFlag(key)) return

  const cwd = sessionCwd(agent)
  if (cwd === undefined) {
    await setFlag(key)
    await log(`PROFILE-NOCWD session=${sessionId}`)
    return
  }

  const profile = await readProfile(cwd)
  await setFlag(key)
  if (profile.kind === 'absent') {
    await log(`PROFILE-ABSENT cwd=${cwd}`)
    return
  }
  if (profile.kind === 'error') {
    await log(`PROFILE-ERROR cwd=${cwd} reason=${profile.reason}`)
    return
  }
  const keys = topLevelKeys(profile.text)
  await log(`PROFILE-LOADED cwd=${cwd} keys=[${keys.join(',')}] sha=${contentSha(profile.text)}`)
}

/**
 * Watch the declaration and enforce its delegation budget.
 * @param ctx - the plugin context; both listeners are registered on it.
 * @param config - optional `{ dispatchTools?: string[] }` ADDING to the natively known
 *   delegation tool names, for a deployment that renames the tool. An extension can
 *   only widen the gate — it never removes a built-in name, because a name that no
 *   tool answers to cannot be called anyway.
 */
export function apply(ctx, config) {
  const seen = new Set()
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    void log(`BUDGET-DEGRADED ${message}`)
    try {
      ctx?.logger?.warn?.(`${name}: ${message}`)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  const dispatchTools = new Set(DEFAULT_DISPATCH_TOOLS)
  try {
    if (Array.isArray(config?.dispatchTools)) {
      for (const entry of config.dispatchTools) {
        if (typeof entry === 'string' && entry !== '') dispatchTools.add(entry)
      }
    }
  } catch {
    // A malformed config keeps the native names, which cover the shipped presets.
  }

  try {
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      const decision = await next()
      try {
        await observeOnce(agent, seen)
      } catch (error) {
        warnOnce(`read-only observation failed, ignoring: ${reasonOf(error)}`)
      }
      return decision
    }, { prepend: true })
  } catch (error) {
    warnOnce(`pre-step listener registration failed, staying inert: ${reasonOf(error)}`)
  }

  try {
    ctx.on('tools/pre-execute', async (exec, next) => {
      let decision
      try {
        decision = await budgetDecision(ctx, exec, dispatchTools, message => warnOnce(message))
      } catch (error) {
        decision = undefined
        warnOnce(`budget gate failed, letting the call through: ${reasonOf(error)}`)
      }
      if (decision === undefined) return next()
      await log(decision.detail)
      return { kind: 'deny', reason: decision.reason }
    }, { global: true, prepend: true })
  } catch (error) {
    warnOnce(`pre-execute listener registration failed, budget not enforced: ${reasonOf(error)}`)
  }
}
