# pi-charter

[English](README.md) | 简体中文

面向 [Pi 编程智能体](https://pi.dev) 的规格驱动交付：你与模型共同为一次改动撰写一份简短合约（称为 *charter*），经你批准后，一条由彼此独立的智能体组成、带门禁的流水线会负责实现、运行你项目中的检查、独立审计，并可选择再做整理。你收到的报告依据已记录的事实生成，而不是模型对自己工作的总结。

该工作流是由代码强制执行的状态机。模型不能批准自己写的规格、不能跳过审计、不能在批准之后改动合约，也不能把未经核实的工作宣称为已验证。

```text
 you + model            you          implementer      your checks       auditor(s)        refiner
┌──────────────┐   ┌──────────┐   ┌──────────────┐   ┌───────────┐   ┌─────────────┐   ┌──────────┐   ┌────────┐
│ draft brief  │──▶│ approve  │──▶│ write code,  │──▶│ test/lint │──▶│ verify each │──▶│ simplify │──▶│ report │
│ and spec     │   │ (dialog) │   │ prove each AC│   │ typecheck │   │ AC, no edits│   │ (guarded)│   │        │
└──────────────┘   └──────────┘   └──────┬───────┘   └─────┬─────┘   └──────┬──────┘   └──────────┘   └────────┘
        ▲                                │ questions       │ fail           │ findings
        │                                ▼                 ▼                ▼
        └───── revise ◀──────────── you decide      auto-repair,       you decide:
                                                    then you decide    fix / waive / revise
```

## 快速开始

运行要求：Pi 1.5 或更高版本，Node.js 22.19 或更高版本。Git 是可选的，但建议使用（见 [Git 能带来什么](#git-能带来什么)）。

```bash
git clone <this repository> pi-charter
pi install ./pi-charter
```

（该包尚未发布到 npm；发布之后，用 `pi install npm:pi-charter` 效果相同。）

然后，在你的项目目录中打开 Pi，执行：

```text
/charter
```

这会以合理的默认配置开启 Charter 模式：一名实现者（implementer）和一名审计者（auditor），二者都使用当前会话的模型。描述你想做的改动。模型会与你一同起草 `brief.md` 和 `spec.md`，一次只问一个问题。当你满意时，它会请求批准，你在对话框中确认。随后流水线会持续运行，直到完成或需要你做出决定。

若要为每个角色选择不同的模型、启用整理者（refiner），或把测试和 lint 命令作为门禁运行：

```text
/charter setup
```

## 什么是 charter

一份 charter 存放在 `.charter/<id>/` 中，包含：

| 文件 | 内容 |
| --- | --- |
| `brief.md` | 为什么要做这次改动、期望的结果，以及范围内外分别包括什么。 |
| `spec.md` | 需求（`R1: The <actor> MUST ...`）和验收标准（`AC1`），每条都带有 GIVEN / WHEN / THEN 和一个具体示例。 |
| `design.md` | 可选。必须在实现之前确定的技术决策。 |
| `attachments/` | 可选。原型图、样例文件，以及其他属于合约一部分的材料。 |

`spec.md` 的一个小例子：

```markdown
### R1: The exporter MUST quote values that contain a comma

- Change: added

#### AC1: Comma values are quoted

- GIVEN a row whose name is `Doe, Jane`
- WHEN the CSV export runs
- THEN the name column of that row is `"Doe, Jane"`

| name      | exported    |
| --------- | ----------- |
| Doe, Jane | "Doe, Jane" |
| Ada       | Ada         |
```

在请你批准之前，`charter_lint` 会以确定性的方式检查这些文档：每条需求都陈述一项义务，并且可追溯到一条验收标准或已有测试；每条标准都包含全部三个子句和一个具体示例；id 唯一；不留下占位符；含糊的结果（例如 "works correctly"）会被标出。完整规则列表见 [docs/workflow.md](docs/workflow.md#lint-rules)。

## 由代码强制执行的保证

| 保证 | 方式 |
| --- | --- |
| 只有你能批准。 | 批准只能通过你回答的对话框，或由你输入的 `/charter approve` 命令完成。没有这一步，模型的工具无法批准。 |
| 只有你能决定问题和发现。 | `charter_resolve` 会出示具体决定供你确认。没有界面时，只有 `/charter decide` 能记录这些决定。 |
| 批准之后合约即被冻结。 | 批准时文档会被哈希并归档。文件工具会拒绝编辑；任何其他改动会在下一次运行前被检测出来，智能体所做的改动会被撤销并写入报告。 |
| 每条验收标准都必须被回应。 | 智能体的报告若没有恰好覆盖其负责的标准，并且每条都附有证据，就会被拒绝并给出原因。标准未通过却声称 "Done" 的报告也会被拒绝。 |
| 审计者不能写代码。 | 它的文件工具只能在临时目录中工作，工作树会在运行前后进行对比：它所改动的内容会被还原，并在报告中列明。 |
| 智能体彼此看不到对方的陈述。 | 每个智能体都在新的会话中运行。审计者拿到的是已批准的文档以及 git 列出的改动文件，而不是实现者的报告。 |
| 未通过的检查不会进入审计。 | 实现完成后，你的检查命令会作为真实进程运行。失败会连同输出直接回到实现者，次数有上限，超出后交给你。 |
| 整理不能在不被察觉的情况下改变行为。 | 它只能改动实现阶段改过的文件。如果超出该范围，或破坏了此前已通过的检查，就会被整体回滚。 |
| 循环会结束。 | 实现循环和自动修复都有预算；每次智能体运行都有时限。超出预算需要你表态。 |
| 摘要如实。 | `report.md` 根据已保存的报告、检查结果和决定生成。被跳过、豁免和回退的工作都会如实列出。 |

## 命令

| 命令 | 用途 |
| --- | --- |
| `/charter` | 开启该模式；若已开启，则显示当前状态。 |
| `/charter new <title>` | 创建一份 charter 并开始起草。 |
| `/charter resume [id]` | 继续一份已有的 charter，无论它处于哪个阶段，重启之后也可以。 |
| `/charter status` · `list` · `log [n]` · `report` | 查看信息。 |
| `/charter lint` | 检查文档。 |
| `/charter approve [id]` | 批准并启动流水线。 |
| `/charter decide <ref> <decision> <text> ; ...` | 记录你的决定，例如 `/charter decide audit-1/F1 fix must match the spec ; F2 waive cosmetic`。 |
| `/charter go` | 继续流水线；若预算已用尽，则再授予一个循环。 |
| `/charter skip [reason]` | 跳过待进行的检查、审计或整理。报告中会标明未执行。 |
| `/charter reopen` | 把已批准的 charter 退回起草阶段。 |
| `/charter rollback [checkpoint]` | 将项目文件恢复到某个检查点（默认是批准时的状态）并重新打开。 |
| `/charter prune [id]` | 删除已完成 charter 的 git 检查点。 |
| `/charter setup` · `doctor` | 以交互方式配置；核验配置、模型、git 和检查项。 |
| `/charter off` | 关闭该模式。文件会保留。 |

模型通过六个仅在该模式开启时可见的工具工作：`charter_new`、`charter_lint`、`charter_approve`、`charter_advance`、`charter_resolve`、`charter_status`。

## 配置

没有配置文件，Charter 也可以运行。若要更改设置，在项目中创建 `.pi/charter.json`（或使用 `~/.pi/agent/charter.json` 应用于所有项目；项目文件会叠在上面）：

```json
{
  "version": 1,
  "roles": {
    "implementer": { "model": "anthropic/claude-sonnet-5", "thinking": "high" },
    "auditor": { "model": "openai/gpt-6", "thinking": "medium", "shards": 2 },
    "refiner": { "enabled": true }
  },
  "checks": [
    { "name": "typecheck", "run": "npm run typecheck" },
    { "name": "test", "run": "npm test", "timeoutSeconds": 900 }
  ]
}
```

角色若未指定 `model`，则使用当前会话的模型。给审计者使用与实现者不同系列的模型，可以得到更独立的第二意见。每个字段的说明见 [docs/configuration.md](docs/configuration.md)。

## 性能

在任何智能体工作流中，模型耗时都占主导，因此设计目标是：每份 charter 尽量减少模型往返和 token 用量，并尽量少增加额外开销。

- **一次工具调用驱动整条流水线。** 批准之后，实现、检查、审计和整理都在同一次工具调用内完成。协调模型不会在阶段之间被唤醒，仅仅为了调用下一个工具。
- **智能体在提交报告的那一刻即停止。** 报告工具会结束本次运行，因此不会再多一次收尾的 "summary" 往返；无效报告会在同一、仍可利用缓存的会话中被纠正，而不是让整次运行失败。
- **简报取代自行摸索。** 每个智能体一开始就能拿到内嵌的已批准文档、它需要回应的精确标准、git 列出的改动文件、先前的决定，以及将要运行的检查。
- **先做检查，再花 token。** 确定性失败（测试、lint、类型检查）由进程捕获并直接送回实现者；不会把审计轮次花在尚未通过自身检查的代码上。
- **并行审计。** 当 `shards > 1` 时，验收标准会分配给同时运行的多名审计者，从而缩短较大规格的审计时间。若其中一名审计者失败，其他审计者的结果会保留，只重跑失败的部分。
- **利于缓存的提示。** 较长的协调指令在每个会话中只发送一次；随着 charter 推进，只有一个三行的状态部分会变化。
- **未使用时开销接近为零。** Pi 在启动时只加载一个很小的声明模块；引擎在第一次真正使用 Charter 时才被导入。
- **共享的模型运行时。** 凭据和模型目录在每个会话中只加载一次，并被每一次智能体运行复用。

用 `npm run bench` 测得（Node 22.23，Linux x64，共享容器；各次运行的数字最多可能相差一倍，因此应把它们理解为数量级）：

| 操作 | 耗时 |
| --- | --- |
| 启动模块，每个 Pi 会话都会承担 | ≈ 5 ms |
| 引擎和智能体运行器，首次使用时加载 | ≈ 45 ms |
| 解析并检查一份含 200 条标准的规格（44 KB） | ≈ 2 ms |
| 为含 5,000 个文件的工作树建立检查点 | ≈ 45 ms |
| 在有 21 个文件改动的情况下再次快照 | ≈ 35 ms |
| 将这些文件恢复到检查点 | ≈ 55 ms |
| 整条流水线的引擎开销（含 git：批准、实现、审计、整理、报告） | ≈ 250 ms |
| 从请求批准到出示报告期间的协调模型调用次数，三个智能体 | 2 |
| 提交报告之后的智能体模型调用次数 | 0 |

该基准使用 Pi 内置的伪模型提供器，因此测的是本软件包的开销，而不是任何真实模型的速度。

## Git 能带来什么

Charter 从不执行 commit、stage、stash 或切换分支。在 `git.checkpoints` 开启时（默认开启），它会通过私有索引对工作树做 *快照*，并保存在 `refs/charter/` 下，从而为你提供：

- 自批准以来改动过的精确文件列表，会交给审计者，并作为整理者的范围；
- 检测并撤销审计者对项目所做的改动；
- 在整理超出范围或破坏检查时自动回滚；
- `/charter rollback`，而它本身也可以被撤销。

在任何自动恢复之前，即将被覆盖的状态都会先存为检查点，因此流水线永远不会销毁智能体（或你）写过的内容。

没有仓库时，流水线仍会运行：实现、检查和审计可以工作，整理者会被跳过，上面列出的能力则不可用。`/charter doctor` 会告诉你当前适用的是哪一种情况。

## 与 pi-maestro、OpenSpec 和 Spec Kit 的关系

pi-charter 是在研究 [pi-maestro](https://github.com/emilioSp/pi-maestro) 之后写成的。pi-maestro 率先以 Pi 扩展的形式实现了由代码强制执行、规格驱动的构建/验证工作流；它所借用、并归功于 [OpenSpec](https://github.com/Fission-AI/OpenSpec) 和 [GitHub Spec Kit](https://github.com/github/spec-kit) 的想法，pi-charter 也有吸收：带有 GIVEN/WHEN/THEN 场景和具体示例的行为合约、需求增量，以及从需求到验证的可追溯性。pi-charter 是一套独立实现，有自己的设计、术语和代码；没有复制任何内容。

与所研究的版本 pi-maestro 0.21 的差异：

|  | pi-maestro 0.21 | pi-charter |
| --- | --- | --- |
| 批准 | 模型在读完你的回复后自行记录 | 只有你能回答的对话框或命令 |
| 批准前的检查 | 文档存在、标准编号；其余全靠模型审阅 | 确定性的检查器：结构、可追溯性、子句、示例、占位符、含糊结果 |
| 规格冻结 | 靠指令约束 | 哈希、归档副本、受保护的文件工具、自动恢复 |
| 项目检查 | 交给智能体自行处理 | 由代码作为门禁运行，并带有次数受限的自动修复 |
| 阶段衔接 | 模型为每个阶段分别调用一个工具 | 一次工具调用跑完所有阶段 |
| 智能体运行如何结束 | 智能体在交接之后再回复 | 报告即结束运行 |
| 智能体未提交报告就结束 | 本次运行失败 | 在同一会话中提醒智能体一次 |
| 验证者隔离 | 信任其自行清理 | 仅能在临时目录使用的文件工具、工作树对比与恢复 |
| 并行验证 | 无 | 可选的审计分片（shards） |
| 简化安全性 | 靠指令约束 | 范围强制、检查对比、自动回滚 |
| 中断或失败的运行 | 需人工跟进 | 再次推进；重启后可用 `/charter resume` |
| 撤销 | 无 | 检查点和 `/charter rollback` |
| 预算 | 无 | 每次运行的时限，以及循环和修复预算 |
| 费用可见性 | 无 | 每次运行及累计的 token、费用和耗时 |
| 最终摘要 | 由模型撰写 | 根据已记录的结果生成 |
| 配置 | 必须，按项目，模型为必填 | 可选，分层叠加，模型默认使用当前会话的 |
| 运行时 | Node 26 | Node 22.19 或更高版本 |

## 限制

- **尚未与真实模型一起实跑过。** 测试套件会端到端驱动真实的 Pi 会话和真实的 `pi` 可执行文件，但这些测试中的模型是脚本化的。机制已经过测试；真实模型对角色提示的遵循程度则尚未验证，因此预计需要调优提示。
- 并行审计者共用一份工作副本。会写入固定路径或端口的检查可能互相干扰，这就是 `shards` 默认值为 1 的原因。
- 快照会遵守 `.gitignore`。审计者对已忽略文件的改动不会被检测出来。
- 整理阶段由范围强制和你的检查保护，而不是第二次审计。
- 模型通过 shell 编辑已冻结文档的行为，会在下一次运行前被检测出来，而不是事先阻止。
- 在 RPC 模式下，由宿主应用回答对话框；其背后是否有真人，取决于该宿主。
- 在 Linux 上开发并测试。Windows 未经测试。

## 开发

```bash
npm install
npm run check      # typecheck + tests: unit, engine, and end-to-end against real Pi sessions
npm run bench
```

代码是 Node 可以直接运行的纯 TypeScript，没有构建步骤。参见 [docs/architecture.md](docs/architecture.md)。

## 许可证

[MIT](LICENSE)
