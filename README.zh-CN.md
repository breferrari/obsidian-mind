🌐 [English](README.md) | [日本語](README.ja.md) | **中文** | [한국어](README.ko.md)

> [!NOTE]
> 本翻译在AI辅助下完成。如果您发现不自然的表达或翻译错误，欢迎通过Issue或Pull Request告知我们。我们非常欢迎社区的修正和贡献。

# 🧠 Obsidian Mind

[![Claude Code](https://img.shields.io/badge/claude%20code-required-D97706)](https://docs.anthropic.com/en/docs/claude-code)
[![Obsidian](https://img.shields.io/badge/obsidian-1.12%2B-7C3AED)](https://obsidian.md)
[![Python](https://img.shields.io/badge/python-3.8%2B-3776AB)](https://python.org)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **一个让 Claude Code 记住一切的 Obsidian 仓库。** 开始一次会话，聊聊你的一天，Claude 会处理剩下的一切——笔记、链接、索引、绩效追踪。每一次对话都建立在上一次的基础之上。

---

## 🔴 问题

Claude Code 功能强大，但它会遗忘。每次会话都从零开始——不了解你的目标、你的团队、你的工作模式、你的成就。你不得不反复解释相同的事情。三次对话前做出的决策就丢失了。知识永远无法积累。

## 🟢 解决方案

给 Claude 一个大脑。

```
你: "开始会话"
Claude: *读取北极星目标，检查活跃项目，扫描最近的记忆*
Claude: "你正在做 Project Alpha，被后端契约阻塞了。
         上次会话你决定拆分协调器。你明天和经理有个
         1:1——Review 简报已经准备好了。"
```

---

## ⚡ 实际效果

<p align="center">
  <img src="obsidian-mind-demo.gif" alt="Obsidian Mind 演示 — standup 和 dump 命令" width="800">
</p>

**早间启动：**

```bash
/om-standup
# → 加载北极星目标、活跃项目、待办任务、最近的 git 变更
# → "你有 2 个活跃项目。auth 重构被 API 契约阻塞了。
#    你下午2点和 Sarah 有 1:1——上次她提到了可观测性的问题。"
```

**会后头脑转储：**

```bash
/om-dump Just had a 1:1 with Sarah. She's happy with the auth work but wants
us to add error monitoring before release. Also, Tom mentioned the cache
migration is deferred to Q2 — we decided to focus on the API contract first.
Decision: defer Redis migration. Win: Sarah praised the auth architecture.
```

```
→ 更新了 org/people/Sarah Chen.md，添加了会议上下文
→ 创建了 work/1-1/Sarah 2026-03-26.md，记录关键要点
→ 创建了决策记录："将 Redis 迁移推迟到 Q2"
→ 添加到 perf/Brag Doc.md："Auth 架构获得经理好评"
→ 更新了 work/active/Auth Refactor.md，添加错误监控任务
```

**事件响应：**

```bash
/om-incident-capture https://slack.com/archives/C0INCIDENT/p123456
# → slack-archaeologist 读取每一条消息、线程和个人资料
# → people-profiler 为新涉及的人员创建笔记
# → 完整的时间线、根因分析、成就记录
```

**收工：**

```
你: "wrap up"
# → 验证所有笔记都有链接
# → 更新索引
# → brag-spotter 发现未记录的成就
# → 提出改进建议
```

---

## 🚀 快速开始

1. 克隆此仓库（或使用它作为 **GitHub 模板**）
2. 将文件夹作为 **Obsidian 仓库** 打开
3. 在 设置 → 通用 中启用 **Obsidian CLI**（需要 Obsidian 1.12+）
4. 在仓库目录中运行 **`claude`**
5. 在 **`brain/North Star.md`** 中填写你的目标——这将为每次会话定下基调
6. 开始谈论工作

### 可选：QMD 语义搜索

用于在仓库中进行语义搜索（即使笔记标题是 "Redis Migration ADR"，也能找到 "我们关于缓存做了什么决策"）：

```bash
npm install -g @tobilu/qmd
qmd collection add . --name vault --mask "**/*.md"
qmd context add qmd://vault "Engineer's work vault: projects, decisions, incidents, people, reviews, architecture"
qmd update && qmd embed
```

> [!NOTE]
> 如果没有安装 QMD，一切仍然正常运作——Claude 会回退到 Obsidian CLI 和 grep。

---

## 📋 环境要求

- [Obsidian](https://obsidian.md) 1.12+（支持 CLI）
- [Claude Code](https://docs.anthropic.com/en/docs/claude-code)
- Python 3（用于钩子脚本）
- Git（用于版本历史）
- [QMD](https://github.com/tobi/qmd)（可选，用于语义搜索）

---

## ⚙️ 工作原理

**文件夹按用途组织，链接按含义组织。** 一个笔记存放在一个文件夹中（它的归属），但链接到许多笔记（它的上下文）。Claude 维护这个图谱——自动将工作笔记链接到人员、决策和能力项。当绩效评估季到来时，每个能力项笔记上的反向链接就是现成的证据链。一个没有链接的笔记就是一个 bug。

**仓库优先的记忆** 使上下文能跨会话和设备持续存在。所有持久知识存储在 `brain/` 主题笔记中（git 跟踪、Obsidian 可浏览、相互链接）。Claude Code 的 `MEMORY.md`（`~/.claude/`）是一个自动加载的索引，指向仓库中的位置——本身不存储内容。这意味着记忆可以在更换设备后保留，并且是知识图谱的一部分。

**会话有设计好的生命周期。** `SessionStart` 钩子自动注入你的北极星目标、活跃项目、最近变更、待办任务和完整的仓库文件列表——Claude 每次会话都带着上下文启动，而不是从空白开始。结束时，说 "wrap up"，Claude 就会运行 `/om-wrap-up`——验证笔记、更新索引、发现未记录的成就。285 行的 `CLAUDE.md` 规范了中间的一切：文件归档位置、链接方式、何时拆分笔记、如何处理决策和事件。

### 钩子

五个生命周期钩子自动处理路由：

| 钩子 | 触发时机 | 功能 |
|------|---------|------|
| 🚀 SessionStart | 启动/恢复时 | QMD 重新索引，注入北极星目标、活跃工作、最近变更、任务、文件列表 |
| 💬 UserPromptSubmit | 每条消息 | 对内容分类（决策、事件、成就、1:1、架构、人员、项目更新）并注入路由提示 |
| ✍️ PostToolUse | 写入 `.md` 后 | 验证 frontmatter、检查 wikilinks |
| 💾 PreCompact | 上下文压缩前 | 将会话记录备份到 `thinking/session-logs/` |
| 🏁 Stop | 会话结束时 | 检查清单：归档已完成项目、更新索引、检查孤立笔记 |

> [!TIP]
> 你只需要正常对话。钩子会处理路由。

### Token 效率

obsidian-mind **不会**将整个 vault 加载到上下文中。它使用分层加载来控制 token 成本：

| 层级 | 内容 | 时机 | 成本 |
|------|------|------|------|
| **始终** | `CLAUDE.md` + SessionStart 元数据（文件名、git 摘要、任务） | 会话启动时 | ~2K tokens |
| **按需** | QMD 语义搜索结果 | Claude 需要特定上下文时 | 精准定向 |
| **触发** | 分类路由提示 | 每条消息 | ~100 tokens |
| **触发** | PostToolUse 验证 | `.md` 写入后 | ~200 tokens |
| **罕见** | 完整文件读取 | 仅在明确需要时 | 可变 |

SessionStart 仅加载**元数据和文件名** — 启动时不读取完整文件。Claude 通过 QMD 进行语义搜索后再读取文件，因此只获取相关内容。分类钩子每条消息仅执行一次轻量级 Python 调用。验证钩子仅在 markdown 写入时触发，跳过非 vault 文件。

---

## 📅 日常工作流

**早晨**：运行 `/om-standup`。Claude 加载你的北极星目标、活跃项目、待办任务和最近变更。你会得到一份结构化的摘要和优先事项建议。

**全天**：自然地交谈。提到你做的决策、发生的事件、刚结束的 1:1、想记住的成就。分类钩子会引导 Claude 将每条信息归档到正确位置。对于更大量的信息转储，使用 `/om-dump` 一次性叙述所有内容。

**收工**：说 "wrap up"，Claude 就会调用 `/om-wrap-up`——验证笔记、更新索引、检查链接、发现未记录的成就。

**每周**：运行 `/om-weekly` 进行跨会话综合——北极星对齐、模式识别、未记录的成就和下周优先事项。运行 `/om-vault-audit` 捕获孤立笔记、断开的链接和过时的内容。

**绩效评估季**：运行 `/om-review-brief manager`，获得一份结构化的评估准备文档，所有证据都已链接就绪。

---

## 🛠️ 命令

定义在 `.claude/commands/` 中。可在任何 Claude Code 会话中运行。

| 命令 | 功能 |
|------|------|
| `/om-standup` | 早间启动——加载上下文，回顾昨天，浮现任务，建议优先事项 |
| `/om-dump` | 自由捕获——随意交谈，Claude 将所有内容路由到正确的笔记 |
| `/om-wrap-up` | 完整的会话回顾——验证笔记、索引、链接，提出改进建议 |
| `/om-humanize` | 语气校准编辑——让 Claude 起草的文字听起来像是你自己写的 |
| `/om-weekly` | 每周综合——跨会话模式、北极星对齐、未记录的成就 |
| `/om-prep-1on1` | 1:1 准备——加载对方上下文、未解决事项、建议议程 |
| `/om-meeting` | 按主题准备会议——未解决事项、障碍、需要考虑的要点 |
| `/om-intake` | 处理会议笔记收件箱——分类 `work/meetings/` 中的文件并路由到正确的笔记 |
| `/om-capture-1on1` | 将 1:1 会议记录捕获为结构化的仓库笔记 |
| `/om-incident-capture` | 从 Slack/频道中捕获事件，生成结构化笔记 |
| `/om-slack-scan` | 深度扫描 Slack 频道/私信以获取证据 |
| `/om-peer-scan` | 深度扫描同事的 GitHub PR，用于评估准备 |
| `/om-review-brief` | 生成评估简报（经理版或同事版） |
| `/om-self-review` | 撰写绩效评估自评——项目、能力、原则 |
| `/om-review-peer` | 撰写同事评审——项目、原则、绩效总结 |
| `/om-vault-audit` | 审计索引、链接、孤立笔记、过时内容 |
| `/om-vault-upgrade` | 从现有仓库导入内容——版本检测、分类、迁移 |
| `/om-project-archive` | 将已完成的项目从 active/ 移至 archive/，更新索引 |

---

## 🤖 子代理

在隔离的上下文窗口中运行的专业代理。它们处理繁重的操作，不会污染你的主对话。

| 代理 | 用途 | 调用方式 |
|------|------|---------|
| `brag-spotter` | 发现未记录的成就和能力差距 | `/om-wrap-up`, `/om-weekly` |
| `context-loader` | 加载仓库中关于某人、项目或概念的所有上下文 | 直接调用 |
| `cross-linker` | 查找缺失的 wikilinks、孤立笔记、断开的反向链接 | `/om-vault-audit` |
| `people-profiler` | 从 Slack 个人资料批量创建/更新人员笔记 | `/om-incident-capture` |
| `review-prep` | 汇总某个评估周期的所有绩效证据 | `/om-review-brief` |
| `slack-archaeologist` | 完整的 Slack 重建——每条消息、线程、个人资料 | `/om-incident-capture` |
| `vault-librarian` | 深度仓库维护——孤立笔记、断开链接、过时笔记 | `/om-vault-audit` |
| `review-fact-checker` | 对照仓库来源验证评审草稿中的每一项声明 | `/om-self-review`, `/om-review-peer` |
| `vault-migrator` | 分类、转换和迁移源仓库中的内容 | `/om-vault-upgrade` |

> [!NOTE]
> 子代理定义在 `.claude/agents/` 中。你可以添加自己的代理以适应特定领域的工作流。

---

## 📊 绩效图谱

这个仓库同时也是一个绩效追踪系统：

1. **能力项笔记** 在 `perf/competencies/` 中定义你所在组织的能力框架——每个能力项一个笔记
2. **工作笔记** 在其 `## Related` 部分链接到能力项，并标注所展示的能力
3. **反向链接自动积累**——绩效评估准备变成了查看每个能力项笔记上的反向链接面板
4. **Brag Doc** 按季度汇总成就，并链接到证据笔记
5. **`/om-peer-scan`** 深度扫描同事的 GitHub PR，并将结构化证据写入 `perf/evidence/`
6. **`/om-review-brief`** 通过汇总所有内容生成完整的评估简报：成就记录、决策、事件、能力证据和 1:1 反馈

> [!TIP]
> 入门方法：使用模板创建能力项笔记，然后在日常工作中将工作笔记链接到它们。图谱会处理剩下的一切。

---

## 📋 Bases

`bases/` 文件夹包含查询笔记 frontmatter 属性的数据库视图。它们会随着笔记的变化自动更新。

| Base | 显示内容 |
|------|---------|
| Work Dashboard | 按季度筛选、按状态分组的活跃项目 |
| Incidents | 按严重程度和日期排序的所有事件 |
| People Directory | `org/people/` 中所有人员的角色和团队 |
| 1:1 History | 可按人员和日期排序的所有 1:1 笔记 |
| Review Evidence | 按人员和周期分组的 PR 扫描和证据 |
| Competency Map | 带有反向链接证据计数的能力项 |
| Templates | 快速访问所有模板 |

`Home.md` 嵌入这些视图，使其成为仓库的仪表板。

---

## 📁 仓库结构

```
Home.md                 仓库入口——嵌入的 Base 视图、快捷链接
CLAUDE.md               操作手册——Claude 每次会话都会读取
vault-manifest.json     模板元数据——版本、结构、schema
CHANGELOG.md            版本历史
CONTRIBUTING.md         模板开发清单
README.md               产品文档
LICENSE                 MIT 许可证

bases/                  动态数据库视图（Work Dashboard、Incidents、People 等）

work/
  active/               当前项目（同时 1-3 个文件）
  archive/YYYY/         已完成的工作，按年份组织
  incidents/            事件文档（主笔记 + RCA + 深度分析）
  1-1/                  1:1 会议笔记——命名格式 <Person> YYYY-MM-DD.md
  Index.md              所有工作的内容地图

org/
  people/               每人一个笔记——角色、团队、关系、关键时刻
  teams/                每个团队一个笔记——成员、职责范围、互动
  People & Context.md   组织知识的内容地图

perf/
  Brag Doc.md           成就持续记录，链接到证据
  brag/                 季度成就笔记（每季度一个）
  competencies/         每个能力项一个笔记（链接目标）
  evidence/             PR 深度扫描、用于评审的数据摘录
  <cycle>/              评审周期简报和产出物

brain/
  North Star.md         目标和关注领域——每次会话读取
  Memories.md           记忆主题索引
  Key Decisions.md      重要决策及其推理过程
  Patterns.md           工作中观察到的重复模式
  Gotchas.md            出过问题的事情及其原因
  Skills.md             自定义工作流和斜杠命令

reference/              代码库知识、架构图、流程文档
thinking/               草稿用暂存区——提炼成果后删除
templates/              带有 YAML frontmatter 的 Obsidian 模板

.claude/
  commands/             18 个斜杠命令
  agents/               9 个子代理
  scripts/              钩子脚本 + charcount.sh 工具
  skills/               Obsidian + QMD 技能
  settings.json         5 个钩子配置
```

---

## 📝 模板

带有 YAML frontmatter 的模板，每个都包含用于渐进式展示的 `description` 字段：

- **Work Note（工作笔记）** — date、description、project、status、quarter、tags
- **Decision Record（决策记录）** — date、description、status（proposed/accepted/deprecated）、owner、context
- **Thinking Note（思考笔记）** — date、description、context、tags（暂存区——提炼后删除）
- **Competency Note（能力项笔记）** — date、description、current-level、target-level、熟练度表格
- **1:1 Note（1:1 笔记）** — date、person、关键要点、行动项、引用
- **Incident Note（事件笔记）** — date、ticket、severity、role、时间线、根因、影响

---

## 🔧 包含内容

### Obsidian Skills

[kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) 预装在 `.claude/skills/` 中：

- **obsidian-markdown** — Obsidian 风格的 Markdown（wikilinks、嵌入、callout、属性）
- **obsidian-cli** — 仓库操作的 CLI 命令
- **obsidian-bases** — 数据库风格的 `.base` 文件
- **json-canvas** — 可视化 `.canvas` 文件创建
- **defuddle** — 网页到 Markdown 的提取

### QMD Skill

`.claude/skills/qmd/` 中的自定义技能，教会 Claude 主动使用 [QMD](https://github.com/tobi/qmd) 语义搜索——在读取文件之前、在创建笔记之前（检查重复）以及在创建笔记之后（查找应该链接到它的相关内容）。

---

## 🎨 自定义

这是一个起点。根据你的工作方式来调整它：

| 内容 | 位置 |
|------|------|
| 你的目标 | `brain/North Star.md` — 为每次会话定下基调 |
| 你的组织 | `org/` — 添加你的经理、团队、重要协作者 |
| 你的能力框架 | `perf/competencies/` — 匹配你所在组织的能力框架 |
| 你的工具 | `.claude/commands/` — 根据你的 GitHub 组织、Slack 工作区进行编辑 |
| 你的规范 | `CLAUDE.md` — 操作手册，随着使用不断完善 |
| 你的领域 | 添加文件夹、在 `.claude/agents/` 中添加子代理，或在 `.claude/scripts/` 中添加分类规则 |

> [!IMPORTANT]
> `CLAUDE.md` 是操作手册。当你改变规范时，请同步更新它——Claude 每次会话都会读取它。

---

## 🔄 升级

已经在使用旧版本的 obsidian-mind（或其他 Obsidian 仓库）？`/om-vault-upgrade` 命令可以将你的内容迁移到最新模板：

```bash
# 1. 克隆最新版 obsidian-mind
git clone https://github.com/breferrari/obsidian-mind.git ~/new-vault

# 2. 在 Claude Code 中打开
cd ~/new-vault && claude

# 3. 运行升级命令，指向你的旧仓库
/om-vault-upgrade ~/my-old-vault
```

Claude 将会：
1. **检测** 你的仓库版本（v1–v3.2，或识别为非 obsidian-mind 仓库）
2. **盘点** 每个文件——分类为用户内容、脚手架、基础设施或未分类
3. **展示迁移计划**——你可以确切看到哪些内容将被复制、转换和跳过
4. **经你批准后执行**——转换 frontmatter、修复 wikilinks、重建索引
5. **验证**——检查孤立笔记、断开链接、缺失的 frontmatter

你的旧仓库**永远不会被修改**。使用 `--dry-run` 可以预览计划而不执行。

> [!NOTE]
> 适用于任何 Obsidian 仓库，不仅限于 obsidian-mind。对于非 obsidian-mind 仓库，Claude 会读取每个笔记并进行语义分类——将工作笔记、人员、事件、1:1 和决策路由到正确的文件夹。

---

## 🙏 设计灵感

- [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) — 官方 Obsidian 代理技能
- [James Bedford](https://x.com/jameesy) — 仓库结构理念，AI 生成内容的分离
- [arscontexta](https://github.com/agenticnotetaking/arscontexta) — 通过 description 字段实现渐进式展示，会话钩子

---

## 👤 作者

由 **[Brenno Ferrari](https://brennoferrari.com)** 创建 — 柏林高级 iOS 工程师，使用 Claude Code 构建开发者工具。

---

## 📄 许可证

MIT
