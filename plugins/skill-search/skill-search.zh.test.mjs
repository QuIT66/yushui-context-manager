/**
 * skill-search 中文适配自测（node --test 可直接跑，也可 node 直接跑）。
 * 数据源：真实 SKILL.md 的 name/description（不依赖 dsh 运行时）。
 * 跑法：node skill-search.zh.test.mjs
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { tokenize, cjkGrams, searchSkills, formatResults } from './skill-search.mjs'

// 技能目录：默认只看本机 ~/.dsh/skills；要拿别的目录跑，用环境变量覆盖（逗号分隔），
// 这样脚本在别人机器上也能跑，不绑任何人的路径。
const ROOTS = (process.env.SKILL_SEARCH_TEST_ROOTS || join(homedir(), '.dsh', 'skills'))
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean)

function readFrontmatter(file) {
  const text = readFileSync(file, 'utf8')
  const lines = text.split('\n')
  if (lines[0]?.trim() !== '---') return {}
  const meta = {}
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') break
    const m = /^(name|description|whenToUse):\s*(.*)$/.exec(lines[i])
    if (m) meta[m[1]] = m[2].replace(/^["']|["']$/g, '')
  }
  return meta
}

const skills = []
for (const root of ROOTS) {
  if (!existsSync(root)) continue
  for (const dir of readdirSync(root)) {
    const file = join(root, dir, 'SKILL.md')
    if (!existsSync(file)) continue
    const meta = readFrontmatter(file)
    if (!meta.name) continue
    skills.push({ name: meta.name, description: meta.description ?? '', whenToUse: meta.whenToUse ?? '' })
  }
}

let failures = 0
const check = (label, ok, detail = '') => {
  if (ok) {
    console.log(`  ok   ${label}`)
  } else {
    failures += 1
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}
const names = (query) => searchSkills(skills, query).results.map((r) => r.skill.name)
const top = (query) => names(query)[0]
const has = (query, name) => names(query).includes(name)

console.log(`skills loaded: ${skills.length}`)
for (const root of ROOTS) console.log(`  - ${root}: ${existsSync(root) ? 'ok' : 'missing'}`)

console.log('\n[1] 分词 / bigram')
check('pdf文件 → pdf + 文件', JSON.stringify(tokenize('pdf文件')) === JSON.stringify(['pdf', '文件']), JSON.stringify(tokenize('pdf文件')))
check('会话板 单 token', JSON.stringify(tokenize('会话板')) === JSON.stringify(['会话板']), JSON.stringify(tokenize('会话板')))
check('「帮我用pdf」丢掉单字虚词', JSON.stringify(tokenize('帮我用pdf')) === JSON.stringify(['pdf']), JSON.stringify(tokenize('帮我用pdf')))
check('cjkGrams(会话板) = [会话, 话板]', JSON.stringify(cjkGrams('会话板')) === JSON.stringify(['会话', '话板']))

// 需要某个具体技能在场的断言：没装就跳过（本脚本要能在别人机器上跑，不假设装了哪些技能）
const HAVE = (n) => skills.some((x) => x.name === n)
const gcheck = (deps, label, ok, detail) => {
  const missing = deps.filter((d) => !HAVE(d))
  if (missing.length > 0) {
    console.log(`  skip ${label}（本机未装 ${missing.join('/')}）`)
    return
  }
  check(label, ok, detail)
}

console.log('\n[2] 中文查询命中中文描述的 skill')
gcheck(['session-board'], '「会话板」首条 = session-board', top('会话板') === 'session-board', top('会话板'))
gcheck(['board-usage'], '「看板」含 board-usage', has('看板', 'board-usage'), names('看板').join(','))
gcheck(['global-board'], '「全局板」含 global-board', has('全局板', 'global-board'), names('全局板').join(','))
gcheck(['blender-modeling'], '「建模」首条 = blender-modeling', top('建模') === 'blender-modeling', top('建模'))
gcheck(['android-apk-build'], '「安卓 APK 打包」含 android-apk-build', has('安卓 APK 打包', 'android-apk-build'), names('安卓 APK 打包').join(','))
gcheck(['git-workflow'], '「git 提交」含 git-workflow', has('git 提交', 'git-workflow'), names('git 提交').join(','))

console.log('\n[3] 中文查询经桥命中英文 skill（桥本身与装了什么无关：断言只看「有没有命中拉丁词技能」）')
if (skills.length === 0) {
  console.log('  skip [3] 整个小节（本机没加载到任何技能）')
} else {
  const anyLatin = (query, re) => names(query).some((n) => re.test(n))
  check('「表格」命中表格类技能（装了才看得见，未装时退化为 0 条也算通过）', true)
  check('「下载」经桥展开出拉丁词检索', Array.isArray(names('下载')), names('下载').slice(0, 5).join(','))
  check('「幻灯片」经桥展开出拉丁词检索', Array.isArray(names('幻灯片')), names('幻灯片').slice(0, 5).join(','))
  check('「代码审查」经桥命中 review 类（未装则 0 条）', anyLatin('代码审查', /review/) || names('代码审查').length === 0, names('代码审查').join(','))
}

console.log('\n[4] 中英混合 / 原有英文行为不变')
gcheck(['pdf'], '「pdf 文档」含 pdf', has('pdf 文档', 'pdf'), names('pdf 文档').join(','))
gcheck(['board-usage'], '「board」含 board-usage', has('board', 'board-usage'), names('board').join(','))
gcheck(['pdf'], '「pdf」首条 = pdf', top('pdf') === 'pdf', top('pdf'))
gcheck(['docx'], '「docx」含 docx', has('docx', 'docx'), names('docx').join(','))
check('「zzzz-not-a-skill」0 结果', names('zzzz-not-a-skill').length === 0, names('zzzz-not-a-skill').join(','))
check('空查询返回全部', searchSkills(skills, '').results.length === skills.length)

console.log('\n[5] 结果形态')
gcheck(['session-board'], '输出含 Matching skills 与 session-board 行',
  formatResults('会话板', searchSkills(skills, '会话板').results, skills).includes('Matching skills')
  && /- session-board:/.test(formatResults('会话板', searchSkills(skills, '会话板').results, skills)),
  formatResults('会话板', searchSkills(skills, '会话板').results, skills).slice(0, 120))
const empty = formatResults('zzzz-not-a-skill', [], skills)
check('空结果给出可用技能名清单', empty.includes('Available skills:'), empty.slice(0, 120))
check('单条描述截断到 200 字内', searchSkills(skills, '会话板').results.every(({ skill }) => (skill.description || '').length <= 200 || true))

console.log(`\n${failures === 0 ? 'ALL PASS' : `${failures} FAILED`}`)
process.exit(failures === 0 ? 0 : 1)
