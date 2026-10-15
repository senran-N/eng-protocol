# eng-protocol

Pi 扩展：在 AI **行动之前**把《自主软件工程代理规范》(`protocol.md`) 中与下一步相关的条款递给它，执行完全由 AI 自主判断。

## 机制

| 层 | Pi 事件 | 内容 |
|---|---|---|
| 常驻规范 | `before_agent_start` → `systemPromptOptions.sections` | `protocol.md` 全文作为 `engineering_protocol` 段，处在不会被压缩的系统提示区；`.pi/eng-protocol.md` 作为 `project_engineering_rules` |
| 可见计划 | `before_agent_start` → `sections.engineering_plan` | 要求 AI 动手前和计划变化时，用“计划：”写 1–3 行可见计划。这是决策模型提前一步看到意图的**唯一途径**：GPT 经 Chat Completions 不返回思考内容，Claude 只给摘要，而动作本身要等执行后才看得到 |
| 决策路由 | `context_with_system` | 每次请求主模型前，把用户请求（含此前两条）、AI 最近写的计划、本轮工具调用与结果、AI 最新的文字（以及服务商若提供的思考内容）交给决策模型，对 16 张卡片各问一个“下一步是否明确相关”，取 P ≥ 0.6 中最高的至多 3 张 |
| 末尾注入 | `context_with_system` | 选中卡片的规范原文以 `<engineering-guidance>` 附在本次请求最末尾；只对这一次请求生效，不写入会话，也不会被压缩掉 |

## 设计依据

| 设计 | 依据 |
|---|---|
| 每次请求都在末尾重新注入 | 多轮对话中指令遵守率逐轮下降：Laban et al. 2025 测得多轮比单轮差 39%；Li et al. 2024 观察到 8 轮内显著漂移，且对系统提示的注意力逐轮衰减；Claude Code 会话中，每多生成一个函数，合规几率下降 5.6%（arXiv 2605.10039）。Manus 的 recitation 做法：把目标重述到上下文末尾 |
| 用可见计划提供意图信号 | 读推理链判断意图比只看动作有效得多（Baker et al. 2025, arXiv 2503.11926），但主流服务商不给完整推理链。实测：srapi/gpt-6-luna（openai-completions）思考内容为 0；srapi/claude-sonnet-4-6 只有约 100 字的任务复述。可见计划把意图提前到动作之前；Manus 的 recitation 是同一思路 |
| 开局就做判断，设“假设核验” | CLI 编码 agent 的失败以认知错误为主，在前几步就开始，直到无法挽回才暴露（arXiv 2607.09510） |
| 偏向精确：0.6 阈值、最多 3 张、提问强调“明确相关” | 上下文文件里的指令会被逐字执行，即使不合时宜；无关内容使成本上升 20% 以上（Gloaguen et al. 2026, arXiv 2602.11988） |
| 规则用正向表述（“做 X，而不是 Y”） | “include X instead of Y”式表述明显优于单纯禁止（arXiv 2404.15154）；对小模型影响尤其大 |
| “任务锚点与行动边界”卡，报告要求标明未验证项 | 真实会话中开发者与 agent 的冲突集中在越界行动、违反规则、进度汇报失实，且后两类占比随时间上升（arXiv 2605.29442） |
| 代码、测试、注释和文档只写现状，改动历史进 commit message 和交付报告 | agent 写产物时带着本次对话和 Diff 的上下文，会把“删了什么、为什么不做”写进代码和文档；读者没有这些上下文，这类内容只会把注意力引向不存在的东西 |
| 规范放在系统提示 + 每次请求重算注入 | 上下文压缩会悄悄删掉约束，违规率从 0% 升到 30%；把约束固定在压缩范围之外可恢复到 0%（arXiv 2606.22528） |

## 卡片（16 张 = System One 单次请求的问题上限）

上下文与假设核验 · 拓扑与爆炸半径 · HALT 熔断事项 · 任务锚点与行动边界 · 类型与状态建模 · 手术刀式修改 · 控制流扁平化 · 读写分离 · 注释、报错与文档 · 系统与宿主防线 · UI 与设计系统 · 零作弊 · 实证验证 · 二次失败法则 · 交付报告 · 零迎合

## 配置

全局 `~/.pi/agent/eng-protocol.json`：

```json
{
  "enabled": true,
  "maxCards": 3,
  "minProbability": 0.6,
  "sendReasoning": true,
  "decision": {
    "endpoint": "https://api.subq.ai/v1/systemone",
    "model": "subq-snap-preview",
    "apiKey": "!powershell.exe -NoProfile -NonInteractive -File C:/Users/21143/.pi/agent/secrets/read-subq.ps1",
    "timeoutMs": 4000
  }
}
```

- `decision.apiKey` 沿用 Pi 的配置值约定：`!命令` 取命令输出，`$VAR` / `${VAR}` 取环境变量，其他值按字面量。命令在会话开始时执行一次。
- 项目级 `<repo>/.pi/eng-protocol.json` 可以覆盖除 `decision` 以外的字段。`decision` 决定对话内容发往哪里、执行什么命令取 key，仓库不能改它。项目专属规则写在 `<repo>/.pi/eng-protocol.md`。
- 决策失败（超时 / HTTP 错误）时：本轮内沿用上一次结果，否则不注入；有界面时弹出提示，无界面时写到 stderr。

`/protocol [status|on|off|reload|show]`：`show` 显示最近一次决策中各卡片的得分和实际注入的内容。

## 开发

```bash
node --test guidance.test.ts
D:/Myproject/SoL-Pi/node_modules/.bin/tsc -p tsconfig.json
```

`guidance.ts` 是纯函数核心（卡片、状态构建、请求/响应、选卡、渲染），`decision.ts` 是 HTTP 客户端，`index.ts` 是事件外壳。

## 须知

- 发送给决策服务商（api.subq.ai）的内容包括：用户请求、AI 的计划、工具参数、截断后的输出摘录，以及服务商若提供的思考内容末尾 1500 字（`sendReasoning: false` 可关闭；对 GPT / Claude 基本没有影响）。
- 每次主模型请求对应一次决策请求（复用连接时约 0.8 秒）；pi-subagents 的子代理同样会加载本插件。
