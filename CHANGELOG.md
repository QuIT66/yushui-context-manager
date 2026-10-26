# 变更记录

版本号遵循语义化版本（SemVer）。

## 1.0.0 — 2026-10-26

首次发布。五个插件，可单独使用，也可整包挂载：

- `memory`：按需注入的长期记忆。一个条目一个文件；全库总字符上限写在**写入侧**（超限当场拒绝并返回差额，
  不静默截断、不自动淘汰）；`remove` / `replace` 掉的旧条目原文机械归档，另记一行移动日志。
  后台记忆评审的人设可换（`reviewPersonaFile`）：跑多个领域库时，每个库可以配一份自己的审查提示词。
- `project-index`：每会话注入一次项目位置索引。注入器与数据分离——真数据在 `config.indexFile` 指向的位置，
  仓库里只有空模板。
- `time`：每轮注入一行「现在」，避免跨天时把「以为的今天」当今天。
- `skill-search`：把「全量技能目录注入」换成 `skill_search` / `skill_load` 两个按需工具；
  中文查询按字块 + 中英词表匹配。
- `subagent-blocker`：按会话目录的 `.dsh/profile.yml` 给子代理派单上闸（`budget.maxSpawns` / `budget.maxDelegationDepth`），
  没声明就完全不作声；另记一行每会话日志。

装配方式：`dsh.bundle` 层（整个 profile 都带）或手工贴块（只给某个预设）。
