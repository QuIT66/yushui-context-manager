/**
 * skill-search — on-demand skill discovery and loading, replacing
 * `dsh-tool-skill`'s full-catalog injection.
 *
 * WHY: the available-skills reminder (`<available_skills>`, ~9KB with many
 * skills) is injected into the first step by dsh-tool-skill and again after
 * every promotion/compaction. That large injected block perturbs the
 * trajectory (issue #6: 0/9 anchored with the catalog present vs ~81%
 * without). We remove the catalog injection entirely and expose two small
 * tools instead — the Claude tool-search pattern:
 *
 *  - `skill_search` — list skills whose name/description match a query
 *    (summaries only, bounded; no bodies). The model discovers what exists
 *    without a 9KB dump.
 *  - `skill_load` — load ONE skill's full instructions by exact name and
 *    inject them for the NEXT request via `agent.inject` (the non-waking
 *    next-step inbox). The model (or the user) calls this only when the
 *    skill is actually needed.
 *
 * Discovery reads `ctx.skills` scoped to the calling agent, exactly like
 * dsh-tool-skill. If skills are unavailable the tools answer with a short
 * message instead of throwing.
 *
 * ZH: the default tokenizer splits on /[^a-z0-9_-]+/, which both
 * dropped every Chinese character from the haystack and turned a Chinese query
 * into an empty token list ("match everything"). Non-Latin support:
 *   1. tokenize by Unicode letters, then split each token at script boundaries
 *      (so `pdf文件` → `pdf` + `文件`);
 *   2. CJK tokens match by character bigrams, so a Chinese phrase hits a
 *      Chinese description without needing a segmenter; a single-character
 *      token is dropped when it is a common function word;
 *   3. a small Chinese→English keyword bridge maps 「表格」→ spreadsheet/xlsx,
 *      「下载」→ download … so Chinese queries can still reach the (mostly
 *      English) skill names/descriptions. Users may extend it in
 *      `~/.dsh/skill-search-zh.json` ({"表格": ["sheet"], …}, merged over the
 *      built-in table).
 *
 * NOTE: this plugin REPLACES the `dsh-tool-skill` row in the composition —
 * the composition must NOT mount both, or the catalog injection returns.
 */

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'skill-search'

/** The agent, tools, and skills services must exist before these tools can register. */
export const inject = ['agents', 'tools', 'skills']

const MAX_RESULTS = 20
const MAX_DESC = 200

const SCRIPT_CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}'
const CJK_SPLIT = new RegExp(`([${SCRIPT_CJK}]+)`, 'u')
const CJK_TEST = new RegExp(`[${SCRIPT_CJK}]`, 'u')
const NON_WORD = new RegExp('[^\\p{L}\\p{N}_-]+', 'u')

/** 中文单字虚词：单字查询里出现不当作检索词（否则「用」「的」会命中一切）。 */
const CJK_STOP = new Set([...'的了用是在和与及把给对让我你他它这那就也都要能会有没个一下上中里帮请看做查'])

/** 内置中→英关键词桥；可在 ~/.dsh/skill-search-zh.json 追加/覆盖。 */
const ZH_BRIDGE = {
  会话板: ['board', 'sboard'],
  工作板: ['board', 'sboard'],
  看板: ['board'],
  全局板: ['board', 'gboard'],
  待办: ['board', 'todo'],
  任务线: ['task', 'board'],
  汇报: ['report'],
  决策: ['decision', 'ask'],
  文档: ['document', 'docx', 'pdf', 'markdown'],
  表格: ['spreadsheet', 'excel', 'xlsx', 'csv'],
  幻灯片: ['powerpoint', 'ppt', 'slide'],
  演示: ['powerpoint', 'slide', 'deck'],
  图片: ['image', 'png', 'jpeg'],
  图像: ['image'],
  视频: ['video'],
  音频: ['audio', 'voice'],
  网页: ['web', 'html', 'page'],
  前端: ['web', 'frontend', 'html', 'css'],
  代码: ['code'],
  论文: ['paper', 'arxiv', 'academic'],
  文献: ['literature', 'paper', 'arxiv'],
  审稿: ['review'],
  评审: ['review'],
  审查: ['review'],
  代码审查: ['review'],
  下载: ['download'],
  建模: ['blender', 'modeling'],
  三维: ['blender', '3d'],
  游戏: ['game'],
  测试: ['test', 'qa'],
  部署: ['deploy', 'publish'],
  发布: ['publish', 'deploy'],
  服务器: ['server', 'ssh'],
  数据库: ['database', 'sql'],
  搜索: ['search'],
  记忆: ['memory'],
  日记: ['memory', 'journal'],
  笔记: ['note', 'markdown'],
  语音: ['voice', 'speech', 'tts'],
  音乐: ['music', 'audio'],
  屏幕: ['screen', 'computer'],
  桌面: ['desktop', 'computer'],
  浏览器: ['browser', 'web'],
  排版: ['markdown', 'pdf', 'publish'],
  导出: ['export', 'publish'],
  转换: ['convert'],
  阅读: ['read'],
  总结: ['summar'],
}

const FIELD_WEIGHTS = [['name', 3], ['description', 1], ['whenToUse', 1]]

/** 长描述（如 blender-modeling 近千字）命中一切词：按长度做衰减，避免霸榜。 */
function lengthFactor(hay) {
  return 1 / (1 + Math.log10(Math.max(1, hay.length / 300)))
}

/** 自定义同义词表路径（可选）。 */
const BRIDGE_FILE = join(homedir(), '.dsh', 'skill-search-zh.json')

/** Minimal JSON schema compiler for tool parameters (zero dependencies). */
function toJsonSchema(spec) {
  const properties = {}
  const required = []
  for (const [key, meta] of Object.entries(spec || {})) {
    const prop = { type: meta.type }
    if (meta.description) prop.description = meta.description
    properties[key] = prop
    if (meta.required) required.push(key)
  }
  return { type: 'object', properties, required, additionalProperties: false }
}

/** Whether a token contains CJK script characters. */
function isCJK(token) {
  return CJK_TEST.test(token)
}

/**
 * Split a query into search tokens.
 * Latin runs stay whole; CJK runs stay whole; a run mixing both is split at
 * the script boundary so `pdf文件` becomes `pdf` + `文件`.
 */
export function tokenize(text) {
  const out = []
  for (const raw of String(text ?? '').toLowerCase().split(NON_WORD)) {
    if (!raw) continue
    for (const part of raw.split(CJK_SPLIT)) {
      if (!part) continue
      // 单字虚词、或整段都是虚词（如「帮我用」）都不当检索词。
      if (isCJK(part) && [...part].every((ch) => CJK_STOP.has(ch))) continue
      out.push(part)
    }
  }
  return out
}

/** Character bigrams of a CJK token (single-char tokens match themselves). */
export function cjkGrams(token) {
  const chars = [...token]
  if (chars.length <= 1) return [token]
  const out = []
  for (let i = 0; i < chars.length - 1; i += 1) out.push(chars[i] + chars[i + 1])
  return out
}

/** Lowercased searchable fields of one skill; name is also split so `session-board` matches `session`. */
function fieldTexts(skill) {
  const skillName = String(skill?.name ?? '')
  return {
    name: `${skillName} ${skillName.replace(/[-_]+/g, ' ')}`.toLowerCase(),
    nameRaw: skillName.toLowerCase(),
    description: String(skill?.description ?? '').toLowerCase(),
    whenToUse: String(skill?.whenToUse ?? '').toLowerCase(),
  }
}

/**
 * Longest common run between a token and a haystack, plus its position.
 * Used instead of bigram overlap so 「会话板」 (full run 3) outranks a text that
 * merely contains 「会话」 (run 2).
 */
function longestRun(token, hay) {
  let bestLen = 0
  let bestAt = -1
  for (let i = 0; i < token.length; i += 1) {
    for (let j = hay.indexOf(token[i]); j >= 0; j = hay.indexOf(token[i], j + 1)) {
      let k = 1
      while (i + k < token.length && token[i + k] === hay[j + k]) k += 1
      if (k > bestLen) {
        bestLen = k
        bestAt = j
      }
      if (bestLen === token.length) return { len: bestLen, at: bestAt }
    }
  }
  return { len: bestLen, at: bestAt }
}

/** Direct score of one token against one skill (0 = miss). */
function directScore(token, fields) {
  let best = 0
  for (const [field, weight] of FIELD_WEIGHTS) {
    const hay = fields[field]
    if (!hay) continue
    if (isCJK(token)) {
      const chars = [...token]
      const { len, at } = longestRun(chars, hay)
      if (len === 0) continue
      // 多字查询只匹配到一个字 → 噪声（「语音」命中「音频」），不计分。
      if (len === 1 && chars.length > 1) continue
      const coverage = len / chars.length
      const fullBonus = len === chars.length ? 0.3 : 0
      const headBonus = len === chars.length && at >= 0 && at < 80 ? 0.4 : 0
      const base = len === 1 ? weight * 0.5 : weight * (0.3 + 0.7 * coverage)
      const scale = field === 'name' ? 1 : lengthFactor(hay)
      best = Math.max(best, (base + fullBonus + headBonus) * scale)
    } else if (hay.includes(token)) {
      // 技能名与查询词完全一致（如 pdf / docx）时明确排到前面。
      const exactName = field === 'name' && fields.nameRaw === token ? 3 : 0
      best = Math.max(best, weight + (field === 'name' ? 1 : 0) + exactName)
    }
  }
  return best
}

/** Score of a Chinese token through the zh→en keyword bridge (0 = miss). */
function bridgeScore(token, fields, table) {
  // 先按整词查桥；整词无条目时再按 bigram 查（「代码审查」→「代码」）。
  const candidates = [token, ...cjkGrams(token).filter((gram) => gram !== token)]
  for (const [index, candidate] of candidates.entries()) {
    const words = table[candidate]
    if (!Array.isArray(words) || words.length === 0) continue
    const decay = index === 0 ? 1 : 0.7
    let best = 0
    for (const word of words) {
      const needle = String(word).toLowerCase()
      if (!needle) continue
      for (const [field, weight] of FIELD_WEIGHTS) {
        const hay = fields[field]
        if (!hay || !hay.includes(needle)) continue
        // 技能名本身就是主题词：桥命中名字给足权重，描述命中按半权 + 长度衰减。
        const score = field === 'name' ? 2.2 : weight * 0.5 * lengthFactor(hay)
        best = Math.max(best, score)
      }
    }
    if (best > 0) return best * decay
  }
  return 0
}

/** Load the built-in bridge plus the optional user table. */
export function loadBridge() {
  const table = { ...ZH_BRIDGE }
  try {
    const extra = JSON.parse(readFileSync(BRIDGE_FILE, 'utf8'))
    for (const [key, value] of Object.entries(extra)) {
      if (!Array.isArray(value)) continue
      const merged = [...new Set([...(table[key] ?? []), ...value.map(String)])]
      table[key] = merged
    }
  } catch {
    // No user table (or unreadable): the built-in one is enough.
  }
  return table
}

/**
 * Rank skills for a query.
 * - Latin tokens must ALL match (same AND semantics as before);
 * - CJK tokens match by bigram overlap, or through the zh→en bridge;
 * - a query with only CJK tokens needs at least one matching CJK token.
 * @returns {{results: Array<{skill: object, score: number, bridged: boolean}>, wanted: string[]}}
 */
export function searchSkills(skills, query, table = loadBridge()) {
  const wanted = tokenize(query)
  if (wanted.length === 0) {
    return { results: skills.map((skill) => ({ skill, score: 0, bridged: false })), wanted }
  }
  const latin = wanted.filter((token) => !isCJK(token))
  const cjk = wanted.filter((token) => isCJK(token))
  const scored = []
  for (const skill of skills) {
    const fields = fieldTexts(skill)
    let total = 0
    let latinHit = 0
    let cjkHit = 0
    let bridged = false
    for (const token of latin) {
      const score = directScore(token, fields)
      if (score > 0) {
        latinHit += 1
        total += score
      }
    }
    for (const token of cjk) {
      const score = directScore(token, fields)
      if (score > 0) {
        cjkHit += 1
        total += score
        continue
      }
      const bridgedScore = bridgeScore(token, fields, table)
      if (bridgedScore > 0) {
        cjkHit += 1
        bridged = true
        total += bridgedScore
      }
    }
    if (latin.length > 0 && latinHit !== latin.length) continue
    if (cjk.length > 0 && latin.length === 0 && cjkHit === 0) continue
    if (total <= 0) continue
    scored.push({ skill, score: total, bridged })
  }
  scored.sort((a, b) => b.score - a.score || String(a.skill.name).localeCompare(String(b.skill.name)))
  return { results: scored, wanted }
}

/** Render the tool answer (bounded; empty answers list what exists). */
export function formatResults(query, results, allSkills, maxResults = MAX_RESULTS) {
  if (results.length === 0) {
    const names = allSkills.map((skill) => skill.name).join(', ')
    return `No skills match "${query}". 中文查询可换技能名或英文关键词（如 board / pdf / docx / blender）。\nAvailable skills: ${names}`
  }
  const head = results.slice(0, maxResults)
  const lines = head.map(({ skill }) => {
    const desc = String(skill.description || '').split('\n')[0].trim()
    const clipped = desc.length > MAX_DESC ? `${desc.slice(0, MAX_DESC)}…` : desc
    return `- ${skill.name}: ${clipped}`
  })
  const extra = results.length > maxResults ? `\n…(${results.length - maxResults} more)` : ''
  return `Matching skills (${results.length}):\n${lines.join('\n')}${extra}\n\nLoad one with skill_load (exact name).`
}

/** Register the two on-demand skill tools. */
export function apply(ctx) {
  ctx.tools.register({
    name: 'skill_search',
    description:
      'Search the available skills by keyword and return matching skill names with short descriptions. Supports English and Chinese queries (「看板」「表格」「建模」 work too). This session keeps NO skill catalog in the prompt — if a task looks like it matches a skill (document conversion, image processing, game reviews, markdown, PDF, spreadsheets, …), call skill_search FIRST to find it, then skill_load to activate it. Do NOT assume skill names from memory.',
    parameters: toJsonSchema({
      query: {
        type: 'string',
        required: true,
        description: 'search keywords, English or Chinese (e.g. "pdf", "obsidian", "游戏测评", "看板", "表格")',
      },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      const scope = exec?.agent ?? ctx
      try {
        const all = await ctx.skills.list({
          scope,
          cwd: exec?.agent?.session?.header?.cwd,
          signal: exec?.signal,
        })
        const { results } = searchSkills(all, args.query)
        return { text: formatResults(args.query, results, all) }
      } catch (error) {
        return { text: `skill_search unavailable: ${String((error && error.message) || error)}` }
      }
    },
  })

  ctx.tools.register({
    name: 'skill_load',
    description: 'Load the full instructions of ONE skill by its exact name (from skill_search results) and inject them for the next request. Call this before acting on a task that matches the skill.',
    parameters: toJsonSchema({
      name: { type: 'string', required: true, description: 'exact skill name (kebab-case, from skill_search)' },
    }),
    output: {
      schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string' } }, required: ['text'] },
      render: (_a, v) => [{ type: 'text', text: v.text }],
    },
    async execute(args, exec) {
      try {
        const agent = exec?.agent
        if (agent === undefined) return { text: 'skill_load requires an agent context.' }
        const skill = await ctx.skills.get(args.name, {
          scope: agent,
          cwd: agent.session.header.cwd,
          signal: exec?.signal,
        })
        if (skill === undefined) {
          return { text: `No skill named "${args.name}". Run skill_search to list available skills.` }
        }
        const body = extractSkillBody(skill)
        if (body.length === 0) {
          return { text: `Skill "${args.name}" has no loadable body.` }
        }
        // Queue the skill content as a non-waking next-step context message,
        // exactly like dsh-tool-skill's invocation injection.
        agent.inject({
          id: `skill-load-${args.name}-${Date.now()}`,
          role: 'user',
          content: [{ type: 'text', text: body }],
          source: { kind: 'skill-invocation', name: args.name, form: 'instructions' },
        })
        return { text: `Skill "${args.name}" loaded; its instructions will be injected for the next request.` }
      } catch (error) {
        return { text: `skill_load failed: ${String((error && error.message) || error)}` }
      }
    },
  })
}

/** Extract the model-facing body of a loaded skill definition. */
function extractSkillBody(skill) {
  const content = skill?.content ?? skill?.instructions ?? skill?.body
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((part) => (typeof part === 'string' ? part : JSON.stringify(part))).join('\n')
  }
  return ''
}
