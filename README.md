# yushui context manager

给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（下称 dsh）用的**上下文管理**插件组。名字里带 context，是因为这五个插件管的是同一件事：
**往对话里注入什么、注入多少、什么时候注入**。

它们是一组**可选插件**，不是预设、也不是完整 profile：你装上以后自己决定挂在哪一层——挂 profile 就是整个 profile 都带，
挂某个预设就只有那个预设带。

全部由配置驱动，代码里没有任何人的绝对路径、也没有任何人的数据。每个插件都能单独用，装一个不装别的也行。

仓库：<https://github.com/QuIT66/yushui-context-manager>（MIT 许可）

## 五个插件

| 子路径（装的时候写这个名字） | 干什么 | 依赖的宿主服务 |
|---|---|---|
| `yushui-context-manager/memory` | 按需注入的长期记忆：一条一个文件、全库总字符上限写在写入侧（超了当场拒绝而不是静默截断）；带淘汰留档区，删掉的条目原文可捞回 | `tools` `subagents` |
| `yushui-context-manager/project-index` | 每会话只注入一次「项目位置索引」文件（真数据在你自己指定的路径，仓库里只有空模板） | — |
| `yushui-context-manager/time` | 每轮注入一行「现在：YYYY-MM-DD HH:mm 周X」，防止跨天误判 | — |
| `yushui-context-manager/skill-search` | 把「全量技能目录注入」换成两个小工具 `skill_search` / `skill_load`（按需检索、按需加载）。**用了它就别再挂官方的 `dsh-tool-skill`**，否则目录注入会回来 | `agents` `tools` `skills` |
| `yushui-context-manager/subagent-blocker` | 给子代理派单上闸：读会话目录下的 `.dsh/profile.yml`，按里面的 `budget.maxSpawns`（历史上总共能派几个）与 `budget.maxDelegationDepth`（允许的最深层数）拒绝超限的派单；没写声明就完全不作声。另记一行每会话日志 | — |

## 安装

前提：node ≥ 20；宿主 dsh 与 `@deepseek-ai/cordis` 4.x 兼容。本包对宿主只有 `ctx` 契约依赖，没有构建步骤。

装到**目标 profile** 里，三选一：

```bash
# ① 直接从 GitHub 装（不用等发布）
dsh plugin --profile <你的 profile> add "github:QuIT66/yushui-context-manager"

# ② 从 npm 装（发布后可用，版本可查可回滚）
dsh plugin --profile <你的 profile> add yushui-context-manager

# ③ 从本地 tarball 装（离线 / 内网）
npm pack yushui-context-manager     # 得到 yushui-context-manager-1.0.0.tgz
dsh plugin --profile <你的 profile> add ./yushui-context-manager-1.0.0.tgz
```

> `dsh plugin` 只是把参数转给该 profile 目录下的 pnpm。你也可以自己 `pnpm add`，效果一样。
> 本地开发想改代码即时生效，用 `link:`：`dsh plugin --profile <名字> add "link:/绝对路径/yushui-context-manager"`。

**装完还要启用**——加依赖只是把代码放进来，装配是另一回事。下面三种挂法**三选一**：

### 方式 A：整个 profile 都带（推荐）

把本包加进 profile 的 bundles 列表，它的 `cordis.patch.yml` 会被自动插入：

```jsonc
{
  "dsh": { "profile": { "bundles": ["@deepseek-ai/dsh-base", "yushui-context-manager"] } }
}
```

效果：**该 profile 下所有会话、所有预设**都带这五个工具，互不干扰。

### 方式 B：手工贴块（不改 bundles）

把 `profile-snippet.yml` 里的 `- insert:` 块贴进 profile 的 `cordis.patch.yml`（或某个预设的 `agent.cordis.yml`）。
贴 profile 层 = 整个 profile 带；贴预设里 = 只有该预设带。

### 方式 C：只装一部分

插件行是彼此独立的，想要哪个留哪个——把不要的行删掉即可，不装的那个不会注册工具。

> 方式 A 与 B 不要同时用：同一个插件被两个 fiber 各注册一次会撞名。

## 配置项

所有配置都写在插件行的 `config:` 下，都可省略。

### memory

| 键 | 默认 | 说明 |
|---|---|---|
| `memoryDir` | `~/memory/mmr` | 记忆条目目录：一条一个文件，文件名 = `加入时间_重要度_id` |
| `scarDir` | `~/memory/scar` | 淘汰留档区：`remove` / `replace` 掉的条目文件原样搬来，另加一行移动记录 |
| `charLimit` | `4000` | 全库总字符上限。超限的写入**当场拒绝**并告诉你差多少，由你自己合并/删除 |
| `userName` | `用户` | 注入块与评审快照里给「用户说的话」贴的称呼 |
| `injectMinTurns` / `reviewEveryTurns` | 内置 | 注入与后台记忆评审的节奏，一般不用改 |
| `reviewPersonaFile` | 插件自带的 `memory-reviewer.md` | 后台记忆评审用的提示词文件。写绝对路径，或只写文件名（按插件同目录找）。跑多个领域库时可以为每个库配不同人设 |

**写什么**：新事实、用户偏好、做过的事的结论、踩过的坑、待办——以及它们为什么重要。**不写**：对话过程、临时状态、能从代码或文件当场读到的东西。
**写多长**：4,000 字符大约装 15 条，单条 100–300 字；快满时先合并同类条目，再删已完成的。

### project-index

| 键 | 默认 | 说明 |
|---|---|---|
| `indexFile` | 模块同目录的 `PROJECT-INDEX.md` | 真数据文件的位置。支持绝对路径、`~/`、相对模块目录 |
| `intro` | 一句通用引语 | 注入时加在索引正文前面的那句话 |

空模板在 `plugins/project-index/PROJECT-INDEX.template.md`，复制出去按需填写即可。

### time

| 键 | 默认 | 说明 |
|---|---|---|
| `zone` | `本机时区` | 时间行括号里显示的时区名（只是标签，时间本身取本机时区） |

## 装完怎么验

1. **工具在不在**：新开一个会话，看工具清单里有没有 `memory`、`skill_search`、`skill_load`。
2. **时间行**：任一轮的注入块里应有 `现在：YYYY-MM-DD ...`。
3. **索引**：第一次对话时应当出现你那份索引的前几行；第二次会话若没出现（或出现两次），检查 `~/.dsh/staging/project-index/` 下的会话标记文件。
4. **记忆**：让模型 `memory add` 一条，`~/memory/mmr/` 下应出现一个新文件。
5. **没生效**：先确认 profile 的 `node_modules/yushui-context-manager` 确实指向你放的那份（`readlink -f`），再重启 dsh。
   插件是**启动时**装配的，改完不重启不算生效。

## 已知限制

- `skill-search` 与官方 `dsh-tool-skill` 二选一：两者同时挂载会让 9KB 的技能目录注入回来。
- `project-index` 只在**主会话**注入，子代理会话跳过（它们的路径已由派单给出）。
- `memory` 的容量语义是「写入侧有界」：满了不是自动淘汰，而是拒绝写入并返回差额。
- 包内不含预设。想连预设一起用，见作者的 `dsh-preset-yushui`（未随本包发布）。

## 版本与变更

见 [CHANGELOG.md](./CHANGELOG.md)。
