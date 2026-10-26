/**
 * time-line — 每轮往对话里注入一行「现在」。
 *
 * WHY：会话跨天时，「以为的今天」和「实际今天」会对不上 —— 人会按旧日期思考，
 * 症状很具体：agent 看到卡上的 `updatedAt 2026-10-16T23:33`，第一反应是**怀疑数据出现了未来时间**，
 * 而不是怀疑自己手里那份"今天"过期了 —— 因为会话跨天时，除了对话本身，没有任何东西会提醒它。
 *
 * WHY 单独一个插件（而不是继续挂在记忆插件里）：那行时间和记忆**没有关系**，只是借用了
 * 同一个注入位置（`agent/pre-step` —— 这是 dsh 里唯一能往对话塞消息的钩子，见 dsh-tool-cordis 的
 * api-catalog：另一个 `webserver/index-inject` 是注入网页的）。挂在记忆插件上，等于让每次改记忆
 * 都要多担一份心，而那个插件是这一套里最大、最活跃的一个。
 *
 * 与记忆块的关键差别：**不节流**。记忆块"会话首次 / 有变更 / 压缩后 / 最少隔 3 轮"，
 * 而跨天那种情况正好会落在没有记忆块的轮次里 —— 那行时间必须每轮都在。
 *
 * 硬规则：
 *  - 一行字、每轮都注、现场取（不缓存 —— 跨天靠的就是它每轮都变）；
 *  - 同一轮只注一次（`pre-step` 在一轮内会被调多次，每次工具调用一次）；
 *  - 子代理也注（它同样会写文件、判断哪天；一行字而已，不像记忆块那样有 4KB 的顾虑）；
 *  - 任何异常都只是少注入一行，绝不影响这一轮对话。
 */
export const name = 'time-line'

export function apply(ctx, config = {}) {
  const withSeconds = config.withSeconds === true
  const zoneLabel = typeof config.zone === 'string' && config.zone ? config.zone : '本机时区'
  const label = typeof config.label === 'string' && config.label ? config.label : '现在'
  const seen = new Map()          // sessionId -> 已注入过的轮号
  const SEEN_MAX = 500

  /** 现场取一行。**刻意不缓存**：这一行的全部价值就在于它每轮都变。 */
  function line() {
    const d = new Date()
    const p = (n) => String(n).padStart(2, '0')
    const hms = p(d.getHours()) + ':' + p(d.getMinutes()) + (withSeconds ? ':' + p(d.getSeconds()) : '')
    return label + '：' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + hms
      + ' 周' + '日一二三四五六'[d.getDay()] + '（' + zoneLabel + '）'
  }

  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    const decision = await next()
    try {
      if (decision.kind === 'reject') return decision
      const session = agent && agent.session
      if (!session || !session.id) return decision      // 拿不到会话身份就少注入一行，不猜
      if (seen.get(session.id) === turn) return decision // 同一轮只注一次
      seen.set(session.id, turn)
      while (seen.size > SEEN_MAX) seen.delete(seen.keys().next().value)
      const msg = {
        id: 'ytime-' + Date.now(),
        role: 'user',
        content: [{ type: 'text', text: line() }],
        // 生产者自己的 kind（v4 口径：kind 用生产者自己的名字，不再包 `kind:'plugin'` 那层壳）。
        source: { kind: 'yushui-time', form: 'instructions' },
      }
      // 插在"这一步新带进来的最后一条消息"之后 —— 与记忆块、卡面块同一种插法。
      const at = decision.messages.findLastIndex((m) => messages.includes(m))
      return { kind: 'enter', messages: decision.messages.toSpliced(at + 1, 0, msg) }
    } catch (e) {
      return decision
    }
  })
}
