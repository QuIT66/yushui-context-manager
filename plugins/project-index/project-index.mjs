/**
 * project-index — inject the preset's PROJECT-INDEX.md once per session.
 *
 * WHY: the focus preset deliberately carries no injected memory
 * context (no AGENTS.md digest, no skills). Its only added context is this
 * static project-location index, so a fresh session can immediately locate the
 * project the user is asking about and knows each project's storage habits.
 *
 * Behavior:
 *  - On the FIRST `agent/pre-step` of each session, read PROJECT-INDEX.md
 *    (next to this module) and append its content as ONE user-role message.
 *  - Once per session, ACROSS resumes. Two guards cooperate:
 *      1. an in-memory Set — the common case, no filesystem traffic;
 *      2. a per-session flag file — a resumed session runs in a fresh process
 *         with an empty Set, which used to re-inject the index every time the
 *         agent loop was rebuilt (observed: 4 injections for one session over
 *         two days and three dsh restarts).
 *    The flag is a filesystem fact rather than process memory, so it survives
 *    restarts without needing any session-log read API.
 *  - No promotion gate: the index is wanted from the very first request.
 *  - A read failure or missing file degrades to no injection (never throws;
 *    logs once). A flag-write failure degrades to at-worst one duplicate.
 */

import { readFile, writeFile, mkdir, readdir, stat, unlink } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { homedir } from 'node:os'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'project-index'

/**
 * 索引文件位置与注入引语。
 *
 * 本模块只是**注入器**，不带任何人的真数据：
 *   · 真数据（真实项目清单）放在仓库外，用 config.indexFile 指过去；
 *   · 仓库里只放 PROJECT-INDEX.template.md 一份空模板；
 *   · 不配 config.indexFile 时就当模板被复制成同目录的 PROJECT-INDEX.md（本地自用最省事）。
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
let indexPath = join(MODULE_DIR, 'PROJECT-INDEX.md')
/** 注入引语：默认是通用措辞，本机可在预设里用 config.intro 覆盖。 */
let indexIntro = '以下是本机项目位置索引（本会话开始时注入一次）。用户提到某个项目时，先用它定位项目的绝对路径，再按其中的存储习惯到对应目录操作：'

/** Per-session injection flags. One small file per session; pruned by age. */
const FLAG_DIR = join(homedir(), '.dsh', 'staging', 'project-index')
const FLAG_TTL_MS = 30 * 24 * 60 * 60 * 1000

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

/** Has this session already received the index (in any process)? */
async function hasFlag(sessionId) {
  try {
    await stat(join(FLAG_DIR, sessionId))
    return true
  } catch {
    return false
  }
}

/** Record that this session received the index. */
async function setFlag(sessionId) {
  try {
    await mkdir(FLAG_DIR, { recursive: true })
    await writeFile(join(FLAG_DIR, sessionId), `${new Date().toISOString()}\n`, { flag: 'w' })
  } catch {
    // Non-fatal: worst case a resumed session sees one extra copy.
  }
}

/** Inject the index once per session, before the first model request. */
/** 这个会话是不是子代理会话。三种口径任一命中即算；字段缺失 ⇒ 当作主会话（绝不误杀）。 */
function isSubagentSession(session) {
  try {
    const header = (session && (session.header || session.meta)) || {}
    if (header.origin === 'subagent') return true
    if (header.parentSession !== undefined && header.parentSession !== null && String(header.parentSession) !== '') return true
    if (typeof header.delegationDepth === 'number' && header.delegationDepth > 0) return true
  } catch {
    // 读不到 ⇒ 按主会话处理
  }
  return false
}

/** 解析 config.indexFile：支持绝对路径、~ 开头、相对模块目录。 */
function resolveIndexPath(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return join(MODULE_DIR, 'PROJECT-INDEX.md')
  const p = raw.trim()
  if (p === '~') return homedir()
  if (p.startsWith('~/')) return join(homedir(), p.slice(2))
  return p.startsWith('/') ? p : join(MODULE_DIR, p)
}

export function apply(ctx, config = {}) {
  indexPath = resolveIndexPath(config.indexFile)
  if (typeof config.intro === 'string' && config.intro.trim()) indexIntro = config.intro
  const injected = new Set()
  let warned = false
  const warnOnce = (message) => {
    if (warned) return
    warned = true
    try {
      ctx.logger.warn(message)
    } catch {
      // Logger unavailable — the guard exists only to avoid spamming.
    }
  }

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    try {
      const session = agent.session
      if (session === undefined || injected.has(session.id)) return decision
      // **子代理会话不注入** —— 它们是被派来做具体活的，项目路径已由派单给定；
      // 实测每派一次白吃一份（两个子代理各中 1 条 2909 字节）。判据用会话头字段（任一命中即认定子会话），
      // 字段读不到时一律当主会话 —— 宁可多注入一次，也不要静默失效。
      if (isSubagentSession(session)) { injected.add(session.id); return decision }

      await pruneFlags()
      if (await hasFlag(session.id)) {
        injected.add(session.id)
        return decision
      }

      const content = await readFile(indexPath, { encoding: 'utf8', signal })
      const text = [
        indexIntro,
        '',
        content.trim(),
      ].join('\n')

      injected.add(session.id)
      await setFlag(session.id)

      return {
        ...decision,
        messages: [...decision.messages, {
          id: `project-index-${session.id}`,
          role: 'user',
          content: [{ type: 'text', text }],
          // V4 会话格式**拒绝** kind:'plugin'（session-format-v3-to-v4/src/message-sources.ts:9
          // 明确写 "refuses retired plugin wrappers"）：写入时抛
          // "format v4 message requires a producer-owned source kind"，回合直接死掉。
          // 生产者要用自己的 kind（官方每家在 MessageSourceMap 里声明一个，如
          // 'agent-instructions' / 'compact-checkpoint'）。注意**不要**借用别家的 kind，
          // 否则会被那家的过滤逻辑认领（如 agent-instructions 的 isAgentInstructionsMessage）。
          source: { kind: 'project-index', form: 'instructions' },
        }],
      }
    } catch (error) {
      warnOnce(`${name}: injection failed, skipping: ${String((error && error.message) || error)}`)
      return decision
    }
  }, { prepend: true })
}
