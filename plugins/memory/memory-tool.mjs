/**
 * memory 插件 — 一个条目 = 一个无后缀文件（mmr 结构化）
 *
 * 为什么一个条目一个文件，而不是把全部条目塞进一个 md：
 *   - 文件名 = <YYYY-MM-DD>_<L|M|H>_<id>  → 加入时间(added_at) + 重要度(importance) 落文件名
 *   - 内容 = 纯文本
 *   - mtime = 最近触碰(last_touched)，任何 write/rename 自动刷新
 * 这样"时间"由文件系统免费提供，重要度落在文件名，ls 即表。
 *
 * 读写强制走本工具：模型只通过 memory 工具读写，不直接 touch/rm。
 * 兜底强制：remove/replace 的旧条目**文件**由插件机械 rename 进 scarDir（原文/文件名/mtime 全留），
 *   同时在 scarDir/移动记录.md 里追加一行日志（动作、归档文件名、原因）。模型无从选择。
 *
 * 容量策略（有界在写入侧）：
 *   全库总长 ≤ charLimit（4000 字符，每条另计 ~24 字符注入前缀开销）。**没有条数上限**。
 *   写满时 add/replace **拒绝写入**，返回差额 + 全库条目清单，要求模型先合并/删除再重试 ——
 *   淘汰决策发生在写入那一刻，由带着完整上下文的模型做，而不是丢给注入时的排名。
 *   注入块 = 全库所有条目（按加入时间升序），不排名、不分冷热、不按话题筛。
 *
 * 注入时机：本轮首步 / mmr 内容变化 / 压缩之后（见下方 §mmr 注入 长注释）。
 *
 * 语义：
 *   - 每条 = 一个文件；charLimit 是**全库**总长上限（单条自然也被它约束）。
 *   - add/replace 会因全库超限而**失败**（这是设计）：必须按条目为单位合并或删除后重试。
 *   - 成功响应是 TERMINAL（勿重复），防模型反复重试烧轮次。
 *   - 单条写原子（tmp+rename）；batch 逐条应用（非全局原子，每步各自 scar）。
 *
 * 注意：本包以独立 npm 包形式被预设或 profile 按包名挂载，不 import 任何 dsh 包,
 * 工具通过 ctx.tools.register 直接注册原始 JSON-Schema ToolDefinition。
 */

import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { mkdir, readFile, writeFile, rename, appendFile, stat, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

export const name = 'memory-tool'
// 'subagents'：本插件自己起后台"记忆审查代理"要用（见 reviewEveryTurns）。
// 注意必须在这里声明依赖，apply 时 ctx.get('subagents') 才是就绪的服务
// （profile 层插件踩过：不声明就拿到 undefined）。
export const inject = ['tools', 'subagents']

// ---- 纯函数（模块级：便于单独 import 测试）-------------------------------
/** 从 ContentBlock[] / string 里取纯文本（会话事件里的 content / message.content 两种形状）。 */
function plainText(content) {
  if (typeof content === 'string') return content
  return (content || []).map((b) => (b && b.type === 'text' ? b.text : '')).join('')
}

/**
 * 记忆审查该不该到点：轮号比上次触发前进了 ≥ every 轮。
 * prev 非法或轮号回退（会话被重置）都返回 false —— 由调用方重新取基线。
 */
function reviewDue(prev, turn, every) {
  if (!Number.isFinite(turn) || !Number.isFinite(every) || every <= 0) return false
  if (prev === undefined || !Number.isFinite(prev) || turn < prev) return false
  return turn - prev >= every
}

/** 快照里给用户说的话贴的称呼。默认「用户」，可用 config.userName 覆盖。*/
let userName = '用户'

/** 解析评审提示词文件：绝对路径原样用；纯文件名按本模块目录解析；空则返回 undefined。 */
function resolvePersonaFile(raw) {
  const v = typeof raw === 'string' ? raw.trim() : ''
  if (!v) return undefined
  if (v.includes('/')) return v
  return fileURLToPath(new URL(v, import.meta.url))
}

/** 把累积的对话组装成快照：从最新往回填，装不下就丢最旧的，永不超 maxChars 太多。 */
function reviewSnapshot(recent, maxChars) {
  const out = []
  let chars = 0
  const list = recent || []
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i]
    if (!m || !m.text) continue
    const block = `${m.role === 'user' ? userName : '助手'}：${m.text}`
    if (out.length && chars + block.length > maxChars) break
    out.push(block)
    chars += block.length
  }
  if (!out.length) return ''
  return out.reverse().join('\n\n')
}

// 供离线测试（tests/rank.test.mjs）使用的纯函数；harness 只认 name/inject/apply，额外导出无害。
export const __test = { plainText, reviewDue, reviewSnapshot }

const DEFAULT_CHAR_LIMIT = 4000
/** 每条进注入块时的固定开销：`[YYYY-MM-DD|X|id] ` 前缀 + 换行。计入容量预算，否则块会超 charLimit。 */
const ENTRY_OVERHEAD = 24
/** 注入节流：除"首次 / 记忆变更 / 刚压缩"外，最少隔这么多**轮**才再注一份。 */
const INJECT_MIN_TURNS = 3
const MAX_CONSOLIDATION_FAILURES_PER_TURN = 3
/** 记忆审查代理：每多少个**用户轮**后台起一次（0 = 关闭）。默认 10 轮提醒一次。 */
const REVIEW_EVERY_TURNS = 10
/** 快照最多带多少条消息（按条数 + 字符双上限，超出丢最旧的）。 */
const REVIEW_SNAPSHOT_MESSAGES = 24
const REVIEW_SNAPSHOT_CHARS = 9000
/** 单条消息进快照前先截断。 */
const REVIEW_MSG_CHARS = 1200
/** 全局冷却：距上次成功启动不足这么久就跳过（防多会话同时堆积审查代理）。 */
const REVIEW_MIN_GAP_MS = 120000
/** 启动审查代理这一调用的超时；只约束启动，不影响它跑起来之后的运行。 */
const REVIEW_START_TIMEOUT_MS = 20000
// 审查代理的总时长上限（兜底）：跑满这么久还没完就主动叫停。
const REVIEW_MAX_MS = 600000
const ENTRY_FILE_RE = /^(\d{4}-\d{2}-\d{2})_([LHM])_([0-9a-f]+)$/
const IMP_LETTER = { L: 'L', M: 'M', H: 'H', 1: 'L', 2: 'M', 3: 'H' }

/** 日期串 YYYY-MM-DD（本地时区） */
function today() {
  const d = new Date()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}
function dateStr(ms) {
  const d = new Date(ms)
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${m}-${day}`
}

/** 内容 => 8 位十六进制稳定 id（唯一性由 writeEntry 碰撞兜底）。 */
function makeId(content) {
  let h = 5381
  for (let i = 0; i < content.length; i++) h = ((h << 5) + h) ^ content.charCodeAt(i)
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 规范化重要度：接受 1|2|3 或 L|M|H，默认 M。 */
function normImp(x) {
  if (x == null || x === '') return 'M'
  if (typeof x === 'number') return IMP_LETTER[Math.min(3, Math.max(1, Math.round(x)))]
  const s = String(x).toUpperCase()
  return IMP_LETTER[s] || 'M'
}

export function apply(ctx, config = {}) {
  userName = (typeof config.userName === 'string' && config.userName.trim()) || '用户'
  const memoryDir = config.memoryDir || join(homedir(), 'memory', 'mmr')
  // 淘汰条目的**原文**区：remove/replace 时由插件机械把条目文件搬到这里（不经模型、无开关）。
  const scarDir = config.scarDir || join(homedir(), 'memory', 'scar')
  // 移动日志（只记账，不是留档副本）：一行一条，最新在上。默认跟随 scarDir。
  const moveLogFile = config.moveLogFile || join(scarDir, '移动记录.md')
  // charLimit = 全库总长上限。没有条数上限：条数由字符自然约束。
  const charLimit = Number(config.charLimit) || DEFAULT_CHAR_LIMIT
  const injectMinTurns = Math.max(1, Number(config.injectMinTurns) || INJECT_MIN_TURNS)
  // ---- 记忆审查代理（每 N 个用户轮后台起一次；写者是子代理，不是前台）----
  const reviewEveryTurns = Math.max(0, Number(config.reviewEveryTurns ?? REVIEW_EVERY_TURNS))
  const reviewProvider = config.reviewProvider || 'spawn'
  // 审查代理的总时长上限（兜底：启动超时只管启动，停跑另有这把刀）
  const reviewMaxMs = Math.max(60000, Number(config.reviewMaxMs) || REVIEW_MAX_MS)
  // reviewPersonaFile 支持三种写法：① 绝对路径 ② 只写文件名（当成本插件同目录的兄弟文件，
  // 这样预设里不用写任何绝对路径，分享时也不绑机器）③ 不写 = 默认 memory-reviewer.md。
  const reviewPersonaFile = resolvePersonaFile(config.reviewPersonaFile)
    || fileURLToPath(new URL('memory-reviewer.md', import.meta.url))
  const reviewStateFile = config.reviewStateFile || join(homedir(), '.dsh', 'state', 'memory-review.json')
  const reviewLogFile = config.reviewLogFile || join(homedir(), '.dsh', 'state', 'memory-review.log')

  // ---- 文件层 -------------------------------------------------------------

  /** 列出全部条目（跳过非条目文件的杂散文件）。 */
  async function listEntries() {
    let names
    try { names = await readdir(memoryDir) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
    const out = []
    for (const nm of names) {
      const m = ENTRY_FILE_RE.exec(nm)
      if (!m) continue
      const full = join(memoryDir, nm)
      let content, st
      try { content = await readFile(full, 'utf8'); st = await stat(full) } catch (e) { continue }
      out.push({ filename: nm, id: m[3], added_at: m[1], importance: m[2], last_touched_ms: st.mtimeMs, content })
    }
    return out
  }

  /** 一条占的容量预算 = 内容 + 注入前缀开销。按它算全库用量，注入块就不会超 charLimit。 */
  function entryCost(e) { return e.content.length + ENTRY_OVERHEAD }
  function totalCost(entries) { return entries.reduce((s, e) => s + entryCost(e), 0) }
  function toObj(e) {
    return { filename: e.filename, id: e.id, added_at: e.added_at, importance: e.importance, last_touched: dateStr(e.last_touched_ms), content: e.content }
  }

  /** 检测杂散文件（不走本工具的外部写入），存在则拒绝写，防覆盖外部追加/手改。 */
  async function detectStray() {
    let names
    try { names = await readdir(memoryDir) } catch (e) { if (e.code === 'ENOENT') return null; throw e }
    const stray = names.filter((n) => !ENTRY_FILE_RE.test(n))
    if (stray.length) {
      return `拒绝写入：mmr 目录存在不是合法条目的文件（${stray.join(', ')}）。它们可能是手改/外部工具/并发会话留下的。先移走或清理它们再重试（快照未动）。`
    }
    return null
  }

  async function atomicWriteFile(path, content) {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    await writeFile(tmp, content, 'utf8')
    await rename(tmp, path)
  }

  /** 建/写一个条目文件（content 相同则幂等返回；id 碰撞追加十六进制计数）。 */
  async function writeEntry(content, imp, addedAt) {
    await mkdir(memoryDir, { recursive: true })
    const base = makeId(content)
    let filename = `${addedAt}_${imp}_${base}`
    let counter = 1
    for (;;) {
      const full = join(memoryDir, filename)
      try {
        const existing = await readFile(full, 'utf8')
        if (existing.trim() === content.trim()) return { filename, created: false }
        counter += 1
        filename = `${addedAt}_${imp}_${base}${counter.toString(16)}`
        continue
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
      }
      await atomicWriteFile(full, content.trim())
      return { filename, created: true }
    }
  }

  /** 淘汰条目原文区：把一个条目文件机械搬进 scarDir（rename，保留内容/文件名/mtime）。 */
  /** 把条目文件机械搬进 scar/（同分区 rename：内容、文件名、mtime 全保留）。重名加 .N。 */
  async function archiveEntryFile(entry) {
    await mkdir(scarDir, { recursive: true })
    let name = entry.filename
    for (let n = 1; ; n += 1) {
      const target = join(scarDir, name)
      try {
        await stat(target)
      } catch (e) {
        if (e.code !== 'ENOENT') throw e
        await rename(join(memoryDir, entry.filename), target)
        return name
      }
      name = `${entry.filename}.${n}`
    }
  }

  const LOG_MARK = '<!-- 新记录插在下面这一行之后（最新在上） -->'

  /** 移动日志：一行一条 `<本地时间> | <动作> | <归档文件名> | 原因：<文字>`；最新在上。 */
  async function appendMoveLog(entry, action, archivedAs, reason) {
    const file = moveLogFile
    await mkdir(dirname(file), { recursive: true })
    const d = new Date()
    const p2 = (n) => String(n).padStart(2, '0')
    const ts = `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`
    const why = (reason || '').replace(/\s+/g, ' ').trim() || '—'
    const line = `${ts} | ${action} | ${archivedAs} | 原因：${why}`
    let text = ''
    try { text = await readFile(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
    if (!text) {
      text = '# mmr 移动记录\n\n'
        + `条目因 remove / replace 被移出活库时，插件机械地把它搬进 \`${scarDir}/\`（原文、文件名、mtime 都不变），并在这里记一行。\n`
        + '格式：`<本地时间> | <动作> | <归档文件名> | 原因：<文字>`；**最新在最上面**。\n\n'
        + `${LOG_MARK}\n`
    }
    const at = text.indexOf(LOG_MARK)
    if (at === -1) {
      // 文件被手工改过、标记丢了：退化成普通追加，不丢记录
      await appendFile(file, `${line}\n`, 'utf8')
      return
    }
    const cut = at + LOG_MARK.length
    const next = `${text.slice(0, cut)}\n${line}\n${text.slice(cut).replace(/^\n+/, '\n')}`
    await atomicWriteFile(file, next)
  }

  // ---- 匹配 + 分数 --------------------------------------------------------

  function matchUnique(entries, oldText) {
    const matches = entries.map((e, i) => [i, e]).filter(([, e]) => e.content.includes(oldText))
    if (!matches.length) return { error: `没有条目匹配 '${oldText}'。用 current_entries/entries 里的准确文本重试。` }
    if (matches.length > 1 && new Set(matches.map(([, e]) => e.content)).size > 1) {
      return { error: `有 ${matches.length} 条匹配，请更具体。`, matches: matches.map(([, e]) => e.content.slice(0, 80)) }
    }
    return { idx: matches[0][0], entry: matches[0][1] }
  }

  // ---- 容量（有界在写入侧）------------------------------------------------
  //
  // 为什么不要排名/冷热：那套东西是为了「满仓不删、只降级到注入块之外」而长出来的，
  // 而想要的形态是「有总长限制、能自动更新、旧条目有兜底留档」。
  // 排名会把「该忘什么」的决策推迟到每轮注入时、交给一个 0.8/0.2 的打分公式 —— 实测会让
  // 刚写入的条目排到第 16 名。
  // 这里的选择：全库总长 ≤ charLimit，超了就在写入那一刻拒绝，由模型带着完整上下文合并/删除。

  /** 全库超上限时的拒绝响应：差额 + 全库条目清单（大小/摘要），让模型一次就能做合并决策。 */
  function capacityRefusal(entries, need, incoming, failures) {
    failures.n += 1
    const used = totalCost(entries)
    const detail = entries.slice()
      .sort((a, b) => entryCost(b) - entryCost(a))
      .map((e) => ({
        id: e.id, added_at: e.added_at, importance: e.importance,
        chars: e.content.length, cost: entryCost(e), preview: e.content.slice(0, 60),
      }))
    const head = `全库 ${used.toLocaleString()}/${charLimit.toLocaleString()} 字符（含每条 ${ENTRY_OVERHEAD} 字符注入开销），这次要写 ${incoming} 字符，还差 ${need} 字符。已拒绝，未写入。`
    const guide = '按【条目】为单位腾空间：用 replace 把相关的几条合并成一条（old_text 传旧条目唯一子串），或 remove 删掉不再需要的，然后再写一次。不要截断或追加单条硬塞。'
    if (failures.n > MAX_CONSOLIDATION_FAILURES_PER_TURN) {
      return {
        success: false, done: true, target: 'memory',
        error: `${head} ${guide} 本回合已连续 ${failures.n} 次容量不足，先停下：把要记的内容留在回复里，别再试。`,
        capacity: { charLimit, used, need },
      }
    }
    return {
      success: false, done: false, target: 'memory',
      error: `${head} ${guide}`,
      capacity: { charLimit, used, left: charLimit - used, need, incoming },
      current_entries: detail,
      note: '这是容量拒绝，不是故障：合并或删除后重试即可。',
    }
  }

  // ---- 响应构造 -----------------------------------------------------------

  function successResponse(entries, message, extra = {}) {
    const used = totalCost(entries)
    return {
      success: true, done: true, target: 'memory',
      usage: `全库 ${entries.length} 条 · ${used.toLocaleString()}/${charLimit.toLocaleString()} 字符（余 ${Math.max(0, charLimit - used)}）`,
      entry_count: entries.length, message,
      note: '已落盘。本操作完成，勿重复执行。容量按条目算：全库超上限时 add/replace 会被拒绝，需先 replace 合并或 remove 腾空间。',
      ...extra,
    }
  }

  function consolidationFailure(error, entries, failures) {
    failures.n += 1
    if (failures.n <= MAX_CONSOLIDATION_FAILURES_PER_TURN) {
      return {
        success: false, error,
        current_entries: entries.map(toObj),
        usage: `全库 ${totalCost(entries).toLocaleString()}/${charLimit.toLocaleString()} 字符`,
      }
    }
    return {
      success: false, done: true,
      error: `Memory consolidation failed ${failures.n} times this turn. Stop retrying memory calls — leave memory unchanged for now and continue with your reply.`,
    }
  }

  // ---- 动作（每次操作前重读磁盘） -----------------------------------------

  async function doAdd(content, importance, failures) {
    content = (content || '').trim()
    if (!content) return { success: false, error: '内容不能为空。' }
    if (content.length + ENTRY_OVERHEAD > charLimit) return { success: false, error: `单条内容 ${content.length} 字符超过全库上限 ${charLimit}，请拆分。` }
    const imp = normImp(importance)
    const stray = await detectStray(); if (stray) return { success: false, error: stray }
    const entries = await listEntries()
    if (entries.some((e) => e.content === content)) return { success: false, error: '该条目已存在（未重复添加）。' }
    // 容量在**写入侧**判。全库总长（含每条注入前缀开销）超 charLimit 就拒绝，
    // 淘汰谁由模型在写入这一刻决定 —— 不再"先存下来、注入时再排名"。
    const incoming = content.length + ENTRY_OVERHEAD
    const need = totalCost(entries) + incoming - charLimit
    if (need > 0) return capacityRefusal(entries, need, incoming, failures)
    await writeEntry(content, imp, today())
    return successResponse(await listEntries(), '已写入（全库仍在上限内）。')
  }

  async function doReplace(oldText, newContent, importance, reason, failures) {
    oldText = (oldText || '').trim(); newContent = (newContent || '').trim()
    if (!oldText) return { success: false, error: 'old_text 不能为空。' }
    if (!newContent) return { success: false, error: 'new_content 不能为空。用 remove 删除条目。' }
    if (newContent.length + ENTRY_OVERHEAD > charLimit) return { success: false, error: `新内容 ${newContent.length} 字符超过全库上限 ${charLimit}。` }
    const stray = await detectStray(); if (stray) return { success: false, error: stray }
    const entries = await listEntries()
    const m = matchUnique(entries, oldText)
    if (m.error) return consolidationFailure(m.error, entries, failures)
    const e = m.entry
    const imp = (importance == null || importance === '') ? e.importance : normImp(importance)
    // 换入前先判容量（净增量 = 新条 cost − 旧条 cost），超限拒绝。
    // 合并本身就是靠这个动作完成的：把两条并成一条，新内容通常比旧两条之和短。
    const incoming = newContent.length + ENTRY_OVERHEAD
    const need = totalCost(entries) - entryCost(e) + incoming - charLimit
    if (need > 0) return capacityRefusal(entries, need, incoming, failures)
    // 旧版机械进 scar/（rename 在先：写新失败也不会丢旧内容），再写新内容。
    const archivedAs = await archiveEntryFile(e)
    await writeEntry(newContent, imp, e.added_at) // 保留原加入时间
    await appendMoveLog(e, 'replace', archivedAs, reason || '')
    return successResponse(await listEntries(), `已替换（旧版已进 ${join(scarDir, archivedAs)}）。`)
  }

  async function doRemove(oldText, reason, failures) {
    oldText = (oldText || '').trim()
    if (!oldText) return { success: false, error: 'old_text 不能为空。' }
    const stray = await detectStray(); if (stray) return { success: false, error: stray }
    const entries = await listEntries()
    const m = matchUnique(entries, oldText)
    if (m.error) return consolidationFailure(m.error, entries, failures)
    const e = m.entry
    const archivedAs = await archiveEntryFile(e)
    await appendMoveLog(e, 'remove', archivedAs, reason || '')
    return successResponse(await listEntries(), `已删除（原文已进 ${join(scarDir, archivedAs)}）。`)
  }

  async function doTouch(oldText, importance, reason, failures) {
    oldText = (oldText || '').trim()
    if (!oldText) return { success: false, error: 'old_text 不能为空。' }
    const stray = await detectStray(); if (stray) return { success: false, error: stray }
    const entries = await listEntries()
    const m = matchUnique(entries, oldText)
    if (m.error) return consolidationFailure(m.error, entries, failures)
    const e = m.entry
    const imp = (importance == null || importance === '') ? e.importance : normImp(importance)
    // 重写内容 => mtime 刷新 = last_touched；重要度变化则改名
    await atomicWriteFile(join(memoryDir, e.filename), e.content)
    if (imp !== e.importance) {
      const newName = `${e.added_at}_${imp}_${e.id}`
      await rename(join(memoryDir, e.filename), join(memoryDir, newName))
    }
    return successResponse(await listEntries(), imp !== e.importance ? '已更新重要度并刷新最近触碰。' : '已刷新最近触碰。')
  }

  async function doList() {
    const entries = await listEntries()
    const sorted = entries.slice().sort((a, b) =>
      b.added_at.localeCompare(a.added_at) || (b.last_touched_ms || 0) - (a.last_touched_ms || 0))
    const used = totalCost(sorted)
    return {
      success: true, done: true, target: 'memory',
      usage: `全库 ${entries.length} 条 · ${used.toLocaleString()}/${charLimit.toLocaleString()} 字符（余 ${Math.max(0, charLimit - used)}）`,
      entry_count: entries.length,
      entries: sorted.map((e) => ({ ...toObj(e), chars: e.content.length, cost: entryCost(e) })),
      note: '只读查询。全部条目本来就在每轮注入块里（没有冷区），list 主要用于合并/删除前核对大小。',
    }
  }

  /** recall：在全库里按关键词过滤定位（全部条目本来就在注入块里，这里只解决"我现在要精确读哪条"）。 */
  async function doRecall(query) {
    const q = (query || '').trim()
    if (!q) return { success: false, error: 'recall 需要 query（关键词，空格分隔）。' }
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    const entries = await listEntries()
    if (!entries.length) return { success: true, done: true, target: 'memory', matches: [], message: '库是空的。' }
    const hits = []
    for (const e of entries) {
      const low = e.content.toLowerCase()
      const matched = terms.filter((t) => low.includes(t))
      if (matched.length) hits.push({ e, matched })
    }
    hits.sort((a, b) => b.matched.length - a.matched.length
      || (b.e.last_touched_ms || 0) - (a.e.last_touched_ms || 0))
    const top = hits.slice(0, 10)
    if (!top.length) {
      return { success: true, done: true, target: 'memory', matches: [], entry_count: entries.length,
        message: `没有条目含 ${terms.join(' / ')}。可用 memory list 看全部条目。` }
    }
    // 不刷新 mtime：排名已删，mtime 不再是"该进热区"的信号，
    // 而刷新它只会让 last_touched 失真（那是"被读过"，不是"被修改过"）。
    return {
      success: true, done: true, target: 'memory', entry_count: entries.length,
      matches: top.map((h) => ({ ...toObj(h.e), matched_terms: h.matched })),
      message: `命中 ${top.length} 条。`,
      note: '召回只读，不改内容也不改时间戳。',
    }
  }

  async function doBatch(operations, reason, failures) {
    if (!Array.isArray(operations) || !operations.length) return { success: false, error: 'operations 列表为空。' }
    const results = []
    for (const op of operations) {
      const act = op && op.action
      let r
      if (act === 'add') r = await doAdd(op.content, op.importance, failures)
      else if (act === 'replace') r = await doReplace(op.old_text, op.content, op.importance, reason || op.reason, failures)
      else if (act === 'remove') r = await doRemove(op.old_text, reason || op.reason, failures)
      else return { success: false, error: `未知 action '${act}'。用 add/replace/remove。` }
      if (!r.success) return { ...r, error: `批量第 ${results.length + 1} 步(${act})失败：${r.error}`, partial_results: results.map((x) => x.message) }
      results.push(r)
    }
    return successResponse(await listEntries(), `已应用 ${operations.length} 个操作。`)
  }

  // ---- mmr 注入（每轮一次 / 内容变化 / 压缩后补注）--------------------------
  //
  // v2 的意图是"内容相同就别重复注入"，但去重扫的是 `decision.messages` ——
  // 那只是**本步进入的消息**，不是对话历史。证据：
  //   - api-catalog.ts 'agent/pre-step'：'Reject a proposed step or replace the
  //     messages that enter it'
  //   - agent-loop/src/agent.ts preStep()：`messages: claimed`（claim 出来的新消息）
  //   - runtime-types.ts：`PreStepDecision = { kind:'enter'; messages: UserMessage[] }`
  // 于是 `already` 恒为 false，实际变成**每一步都注入一次**。实测：某个会话
  // 727 次 / 748 步（12 会话合计 7.86 MB），而内容只有 7–25 种。
  //
  // 注入是 durable 的：进了历史模型就一直看得见 —— "每步再塞一份相同的"
  // 只涨体积不涨信息。真正需要注入的时机：
  //   ① 本会话第一次：历史里还没有块
  //   ② **记忆真的变了**（条目增删改）：让模型立刻看到新的
  //   ③ 刚发生过压缩：旧块可能被折进摘要，补一份
  //   ④ 兜底节流：距上次注入 ≥ injectMinTurns（默认 3）轮 —— 块内容现在是**全库、稳定排序**，
  //      只在条目集合变化时才变；这道闸只防"频繁小改写"把上下文刷得太勤
  // 同一轮内**最多一份**（`st.turn !== turn` 守卫），压缩补注也走这条。
  // 官方 `context/agent-instructions` 也是"变化才注入"（它在 session/event 上等
  // step/end 把 touch 落定），不是每步注入。
  //
  // 判据是"条目集合签名"(st.sig)：只有条目增删改才算"变了"。块内容不再随对话排名漂移，
  // 不再随对话排名漂移（全库稳定排序），所以同一份集合渲染出来的块逐字节相同 ——
  // prompt 缓存可以命中；频率由 ④ 的轮数节流控制。

  let injectSeq = 0

  /** 每个会话的注入状态。block 存全文（不存哈希），比较零碰撞风险。 */
  const injectState = new Map()
  const INJECT_STATE_MAX = 64

  function injectStateFor(sessionId) {
    let st = injectState.get(sessionId)
    if (st === undefined) {
      // compactedSinceInject 初值 true：新会话 / 重启后进程内状态为空，第一轮务必注入
      st = { turn: undefined, sig: undefined, lastInjectTurn: undefined,
             compactedSinceInject: true, recent: [] }
      injectState.set(sessionId, st)
      // 有界：Map 保持插入序，超了丢最老的
      while (injectState.size > INJECT_STATE_MAX) {
        injectState.delete(injectState.keys().next().value)
      }
    }
    return st
  }

  // 压缩会把旧块替换成摘要 → 记一笔，下一个 pre-step 补注一次。
  // `session/event` 按 agent 作用域过滤（api-catalog: "agent-scoped listeners
  // receive only events from sessions entered through that agent's context"），
  // 但仍按 session.id 取状态，挂载粒度变了也不会串台。
  // 同一条钩子也是「记忆审查代理」的对话快照来源：会话日志每落一条事件都会广播过来
  // （api-catalog: "Post-commit, fire-and-forget append feed"）。据此攒最近对话，
  // 到点由 pre-step 起审查代理。**子代理的事件一律不看** —— 这是防子代理爆炸的第一道
  // 闸门（子代理的对话不污染快照），也保证审查代理自己（它是子代理）不会再触发审查。
  ctx.on('session/event', (session, event) => {
    if (!session || !event) return
    if (session.header?.origin === 'subagent') return
    if (event.type === 'compaction/end') {
      injectStateFor(session.id).compactedSinceInject = true
      return
    }
    if (event.type !== 'user/message' && event.type !== 'assistant/message') return
    const st = injectStateFor(session.id)
    let role
    let text
    if (event.type === 'user/message') {
      // 只收「用户自己说的」（source.kind === 'user'）；插件注入的块不算对话
      if (event.data?.source?.kind !== 'user') return
      role = 'user'
      text = plainText(event.data?.content)
    } else {
      role = 'assistant'
      text = plainText(event.data?.message?.content)
    }
    text = (text || '').trim()
    if (!text) return
    if (text.length > REVIEW_MSG_CHARS) text = text.slice(0, REVIEW_MSG_CHARS) + ' …（已截断）'
    st.recent.push({ role, text })
    if (st.recent.length > REVIEW_SNAPSHOT_MESSAGES) {
      st.recent.splice(0, st.recent.length - REVIEW_SNAPSHOT_MESSAGES)
    }
  })

  // ---- 记忆审查代理（非前台写者）------------------------------------------
  //
  // 补的是「后台写者」这条：前台模型随时可以自己写（另一条路，一直都在），
  // 这里补「到点必看一次」+「换一个写者」。护栏必须自己写 —— 已知坑：
  // 插件直接调 subagents 不经过 tools/pre-execute，dsh 的委派深度熔断在这条路上不生效：
  //   ① 只对主会话计数（子代理在 pre-step 与 session/event 两处都被挡掉）；
  //   ② 每会话每 reviewEveryTurns 轮最多一次；
  //   ③ 全局冷却 REVIEW_MIN_GAP_MS，防多会话同时堆积；
  //   ④ 工具白名单只给 memory —— 它没有派子代理的工具，结构上不可能递归；
  //   ⑤ 启动失败只记日志，不重试、不抛、不影响这一轮对话。

  /** 触发点台账 { <会话id>: <上次触发的用户轮号> }。落盘，免得每次重启 dsh 都从头数。 */
  let reviewPoints = {}
  let reviewPointsLoaded = false
  let reviewLastStartAt = 0

  async function loadReviewPoints() {
    if (reviewPointsLoaded) return
    reviewPointsLoaded = true
    try {
      reviewPoints = JSON.parse(await readFile(reviewStateFile, 'utf8')) || {}
    } catch (e) {
      reviewPoints = {} // 文件不存在或坏了都从头来，不抛
    }
  }

  async function saveReviewPoints() {
    try {
      await mkdir(dirname(reviewStateFile), { recursive: true })
      await atomicWriteFile(reviewStateFile, JSON.stringify(reviewPoints))
    } catch (e) { /* 记不住触发点最多多看一眼，不影响记忆本身 */ }
  }

  function reviewLog(line) {
    const stamp = `[${new Date().toISOString()}]`
    void appendFile(reviewLogFile, `${stamp} ${line}` + '\n', 'utf8').catch(() => {})
  }

  /** 起一个审查代理。任何失败都只写日志：这条路上出问题绝不该影响正常对话。 */
  async function maybeStartMemoryReview(agent, session, turn) {
    try {
      if (reviewEveryTurns <= 0) return
      await loadReviewPoints()
      const prev = reviewPoints[session.id]
      const st = injectStateFor(session.id)
      if (!st.recent || !st.recent.length) return
      if (!reviewDue(prev, turn, reviewEveryTurns)) {
        // 首次见到这个会话（或会话轮号被重置）：取基线，从这一刻起数 N 轮
        if (prev === undefined || turn < prev) {
          reviewPoints[session.id] = turn
          await saveReviewPoints()
        }
        return
      }
      const now = Date.now()
      if (now - reviewLastStartAt < REVIEW_MIN_GAP_MS) {
        reviewLog(`skip busy session=${session.id} turn=${turn}`)
        return
      }
      const subagents = ctx.get('subagents')
      // 注意：这里判的是 `start`，别写成 `startContinuable` —— 后者是 continuable 专用；
      // 两者同时存在时能跑，但 `startContinuable` 一旦被摘掉，这里就会静默跳到 no-service。
      if (!subagents || typeof subagents.start !== 'function') {
        reviewLog(`skip no-service session=${session.id} turn=${turn}`)
        return
      }
      let persona = ''
      try {
        persona = await readFile(reviewPersonaFile, 'utf8')
      } catch (e) {
        reviewLog(`skip no-persona file=${reviewPersonaFile} session=${session.id}`)
        return
      }
      const snapshot = reviewSnapshot(st.recent, REVIEW_SNAPSHOT_CHARS)
      if (!snapshot) return
      // 先记账再启动：启动失败也不在下一轮重试同一批内容（失败会写日志）
      reviewPoints[session.id] = turn
      await saveReviewPoints()
      reviewLastStartAt = now
      const prompt = '下面是最近这段对话的快照（节选，可能被截断）。'
        + '请按你的职责审查长期记忆库：先用 memory 工具 list 看全库，再按需 add / replace / remove，'
        + '并在收尾里说明你动了什么。\n\n'
        + '=== 对话快照开始 ===\n' + snapshot + '\n=== 对话快照结束 ==='
      // 用**一次性**（one-shot）而不是「可继续」：可继续通道属于 dsh 的 continuable 编排，
      // 它会在子会话结束时给父会话投一条「Background subagent … finished」结算通知，还会给
      // 子代理塞一段"完成前把结果 send_message 给父代理"的提示词
      // （packages/subagent/subagent/src/continuation-messages.ts：整份文件都是 continuable 专属）。
      // 审查是全自动的、结论直接落盘，不需要打扰主会话 ⇒ 走 one-shot，它跑完即散、不通知。
      // 注意：这里不能用 `signal: AbortSignal.timeout(REVIEW_START_TIMEOUT_MS)` ——
      // 那个写法**既管启动、也管运行** —— timeout 信号 20 秒后无条件 fire，而 dsh 对它的语义是
      // 「fire 之后取消已发布 run 的**剩余工作**」⇒ 审查代理跑到 20 秒被当场砍掉。
      // 实测吻合到秒：两个子会话都是启动后 ~19 秒收到 aborted，四次触发全死在同一个地方、
      // 没有一次交出结果（日志里 reason 那个 parent 指的是"上层给的信号"，不是"父会话"）。
      // 这里用**自管信号**，把关收成两段、各自清楚：
      //   ① 启动阶段：20 秒定时器（启动一成功立刻撤掉 —— 运行期不该有这把刀）；
      //   ② 运行阶段：只留一个「总时长上限」兜底（默认 10 分钟），跑完/失败都撤掉。
      // 于是既不再被误杀，也不会像脱缰一样没人管。
      const ctrl = new AbortController()
      const startTimer = setTimeout(() => { try { ctrl.abort() } catch (e) {} }, REVIEW_START_TIMEOUT_MS)
      let run = null
      try {
        run = await subagents.start(reviewProvider, {
          parent: agent,
          persona,
          prompt: [{ type: 'text', text: prompt }],
          toolFilter: { allow: ['memory'] },
          signal: ctrl.signal,          // 我们掌管的信号（不再让「超时」兼职「停跑」）
        })
      } finally {
        clearTimeout(startTimer)        // 启动这一步结束了，把它那把刀收掉
      }
      const maxTimer = setTimeout(() => { try { ctrl.abort() } catch (e) {} }, reviewMaxMs)
      st.recent = [] // 交出去就清空，避免下次审查重复喂同一批对话
      const childRef = run && run.id ? String(run.id) : '?'
      reviewLog(`started session=${session.id} turn=${turn} child=${childRef} chars=${prompt.length}`)
      // 收尾留痕（原先只有 started；成败看不出来，只能靠人看到半句话才发现它死了）：
      Promise.resolve(run && run.result).then((res) => {
        reviewLog(`finished session=${session.id} child=${childRef} stop=${(res && res.stopReason) || 'ok'}`)
      }).catch((err) => {
        reviewLog(`failed session=${session.id} child=${childRef} ${(err && err.message) || err}`)
      }).finally(() => { clearTimeout(maxTimer) })
    } catch (error) {
      const message = error && error.message ? error.message : String(error)
      reviewLog(`failed session=${session && session.id} turn=${turn} ${message}`)
    }
  }

  /** 条目集合签名：与顺序无关、与内容有关（条目增删改才算"变了"）。 */
  function sigOf(entries) {
    return entries.map((e) => `${e.filename}#${makeId(e.content)}`).sort().join(',')
  }

  /** 注入块 = 全库所有条目，按加入时间升序（稳定顺序 ⇒ 内容不变时可命中 prompt 缓存）。 */
  async function renderMmrBlock(entries) {
    entries = entries || await listEntries()
    if (!entries.length) return null
    const sorted = entries.slice().sort((a, b) =>
      a.added_at.localeCompare(b.added_at) || (a.last_touched_ms || 0) - (b.last_touched_ms || 0))
    const used = totalCost(sorted)
    const sep = '='.repeat(46)
    const lines = [
      sep,
      `MEMORY (mmr) [${sorted.length} 条 · ${used.toLocaleString()}/${charLimit.toLocaleString()} 字符]`,
      sep,
    ]
    for (const e of sorted) lines.push(`[${e.added_at}|${e.importance}|${e.id}] ${e.content}`)
    return lines.join('\n')
  }

  async function buildInjectionMessage(entries) {
    const block = await renderMmrBlock(entries)
    if (!block) return null
    return {
      id: `ymm-${Date.now()}-${injectSeq++}`,
      role: 'user',
      content: [{ type: 'text', text: block }],
      // 已发布词表内的写法：kind 必须是 harness 认识的种类，插件身份放 plugin 字段。
      // 自造 kind 逃得过写入校验，但会被
      // v0/v1/v2→v3 迁移的 SOURCE_KINDS 白名单拒读。
      // V4 拒绝 kind:'plugin'（retired plugin wrapper）——必须用生产者自己的 kind，
      // 否则 session.append 抛 "format v4 message requires a producer-owned source kind"，
      // 整个 turn 静默失败。见 session-format-v3-to-v4/src/message-sources.ts:9。
      source: { kind: 'yushui-memory', form: 'instructions' },
    }
  }

  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    const decision = await next()
    if (decision.kind === 'reject') return decision
    try {
      const session = agent && agent.session
      if (!session) return decision // 拿不到会话身份宁可少注入，也不跨会话共享状态
      // 子代理不注入 mmr（工具仍可调 recall，但省 ~4KB/轮被动塞入）
      if (session.header?.origin === 'subagent') return decision
      // 记忆审查：到点就后台起一个审查代理。上一行已把子代理挡掉 ⇒ 天然只对主会话生效，
      // 审查代理自己也是子代理、不会再触发。不 await：起代理不许拖慢这一轮对话。
      void maybeStartMemoryReview(agent, session, turn)
      const st = injectStateFor(session.id)
      const entries = await listEntries()
      if (!entries.length) return decision
      const sig = sigOf(entries)
      const first = st.lastInjectTurn === undefined
      const memChanged = st.sig !== sig
      const throttled = !first && !memChanged && !st.compactedSinceInject
        && turn - st.lastInjectTurn < injectMinTurns
      // 节流到点之前连块都不渲染（省一次全库读 + 渲染）
      if (throttled) return decision
      // 同一轮内最多一份 —— 例外：刚发生过压缩（旧块被折进摘要，必须补）
      if (st.turn === turn && !st.compactedSinceInject) return decision
      const desired = await buildInjectionMessage(entries)
      if (!desired) return decision
      const lastClaimedIndex = decision.messages.findLastIndex((m) => messages.includes(m))
      const entered = decision.messages.toSpliced(lastClaimedIndex + 1, 0, desired)
      st.turn = turn
      st.sig = sig
      st.lastInjectTurn = turn
      st.compactedSinceInject = false
      return { kind: 'enter', messages: entered }
    } catch (e) {
      return decision // 注入失败绝不能吞掉用户请求
    }
  })

  // ---- 工具注册 ------------------------------------------------------------

  ctx.tools.register({
    name: 'memory',
    description:
      '维护持久记忆数据库（mmr）——一个条目 = 一个无后缀文件，文件名 = 加入时间_重要度_id。' +
      '存值得跨会话长期记住的内容：新事实、用户偏好、事务进展/结论、踩坑教训、待办。' +
      'action：add 添加；replace 替换（old_text 传旧条目唯一子串）；remove 删除；batch 一次多个操作；' +
      'list 只读列出全部（含每条字符数）；recall 按关键词在全库里定位；touch 改重要度/刷新最近触碰。' +
      'importance 传 1低/2中/3高（或 L/M/H），add 默认 M——**它现在只是元数据提示，不再决定淘汰**。' +
      '【容量语义：有界在写入侧】全库总长上限 ' + charLimit + ' 字符（每条另含约 ' + ENTRY_OVERHEAD + ' 字符注入前缀开销），**没有条数上限**。' +
      '每轮注入块 = 全库所有条目（按加入时间），不排名、不分冷热。' +
      '写满时 add/replace 会**被拒绝**并返回差额与全库清单：先用 replace 把相关的几条合并成一条、或 remove 腾空间，再重试。' +
      '条目是最小操作单位：不要截断或追加单条来硬塞。' +
      '删除/替换的旧条目由插件自动搬进淘汰区并在移动记录里记一行（含原因）；你无需也不应自己去动那些文件。' +
      '成功写入后不要重复调用同一操作。',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'replace', 'remove', 'batch', 'list', 'recall', 'touch'], description: '要执行的操作。recall 用 query 在全库里按关键词定位。' },
        content: { type: 'string', description: 'add / replace 的条目内容。' },
        query: { type: 'string', description: 'recall 的关键词，空格分隔（如 "ssh 代理"）。' },
        old_text: { type: 'string', description: 'replace / remove / touch 要定位的旧条目唯一子串。' },
        importance: { type: 'string', enum: ['1', '2', '3', 'L', 'M', 'H'], description: '可选：1低/2中/3高（或 L/M/H）。' },
        reason: { type: 'string', description: '可选：删除/替换原因，记入 scar 留档。' },
        operations: {
          type: 'array',
          description: 'batch 的操作列表。',
          items: {
            type: 'object',
            properties: {
              action: { type: 'string', enum: ['add', 'replace', 'remove'] },
              content: { type: 'string' },
              old_text: { type: 'string' },
              importance: { type: 'string' },
            },
            required: ['action'],
          },
        },
      },
      required: ['action'],
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          success: { type: 'boolean' },
          done: { type: 'boolean' },
          target: { type: 'string' },
          usage: { type: 'string' },
          entry_count: { type: 'number' },
          message: { type: 'string' },
          note: { type: 'string' },
          error: { type: 'string' },
          capacity: { type: 'object' },
          chars: { type: 'number' },
          cost: { type: 'number' },
          current_entries: { type: 'array', items: { type: 'object' } },
          entries: { type: 'array', items: { type: 'object' } },
          matches: { type: 'array', items: { type: 'object' } },
        },
        required: ['success'],
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const failures = { n: 0 }
      const action = args && args.action
      const target = (args && args.target) || 'memory'
      if (target !== 'memory') return { success: false, error: `Invalid target '${target}'. Only 'memory' supported.` }
      switch (action) {
        case 'add': return await doAdd(args.content, args.importance, failures)
        case 'replace': return await doReplace(args.old_text, args.content, args.importance, args.reason, failures)
        case 'remove': return await doRemove(args.old_text, args.reason, failures)
        case 'batch': return await doBatch(args.operations, args.reason, failures)
        case 'list': return await doList()
        case 'recall': return await doRecall(args.query)
        case 'touch': return await doTouch(args.old_text, args.importance, args.reason, failures)
        default: return { success: false, error: `Unknown action '${action}'. Use: add, replace, remove, batch, list, recall, touch` }
      }
    },
  })
}
