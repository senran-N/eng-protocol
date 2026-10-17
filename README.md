# eng-protocol

在模型请求之间，根据当前证据选取少量工程提醒。行动尊重授权，思考主动：发现关键目标分叉、能力缺口或更简方案时给出有依据的引导，目标明确时继续完成工作。

运行时零第三方依赖。提醒仅附在本次请求末尾，不写入持久化历史，不拦截工具。五分类状态、分支事实账本、预算调度与关系图共同决定是否干预；允许没有提醒。

## 工作方式

1. `before_agent_start` 安装 `protocol.md`、计划要求、主动模式及完整项目规则。
2. `context_with_system` 收集有界意图/工具窗口和当前分支事实账本。
3. 相同快照使用缓存；重复且未变化的只读证据可跳过。否则按阶段、风险和等待轮次安排候选。
4. 默认最多 **16 个问题**，SubQ 至多 **1 次 HTTP 请求**。未安排的卡标为 `unknown / deferred`，不伪装成“不适用”。
5. 处理覆盖、阻塞、前置、仲裁与合并，加上提醒冷却，最多注入 3 组提醒，每组最多 2 张正文。
6. 故障退避并使用有限的本地事实提醒；取消、分支切换或被新请求取代后，旧结果不再注入。

当前有 **38 张语义卡、23 条关系（4 条结构边、19 条条件边）**，穷举为 57 题；另有 4 张离线事实提醒，不占远端预算。新增 11 张卡覆盖反测试作弊、连续受挫、弃用方案、吞错、复现、本地版本、临时产物，以及意图引导、工具能力、更简方案和二阶影响。

六维[覆盖矩阵](research/coverage-matrix.md)为每张卡指定主责维度与邻近规则边界。这是工程审计分类，**不是所有模型失败的因果解释或 MECE 完备性证明**。多假设诊断、不确定性校准、存量复用增强已有卡，避免重复堆卡。研究来源与适用限制见[来源登记](research/model-failures-2026.json)，新增工程假设与实证来源分开记录。

## 证据、预算与冷却

账本优先读取宿主当前活动分支，遵守 `context_edit`，不混合其他分支。如果可见工具结果更新，则使用当前可见历史。记录读写文件数、有界路径样本、检查起止与明确退出状态、未知副作用、待完成工具、连续错误、相同目标相同报错及工具缺失文本线索。

检查开始于最后一次写入之前不能证明当前版本。任意 shell、失败写入、缺少退出码和未知工具均保留不确定性。读取不等于理解，检查通过不证明覆盖充分，缺失记录不证明未做过。压缩后能否恢复早期事实取决于活动分支是否仍保留记录；插件不提供跨会话持久化记忆。本地全文扫描与哈希仍有 CPU 成本。

文本预算：最新请求 2000 字符；用户历史共 3000（单条最多 1000）；最近 10 次工具的参数/输出各 600；最新回复 800；计划 600；可用思考尾部 1500；项目规则 1500。项目摘录保留首尾与按任务词匹配的中段，不保证找全所有重要规范。完整意图/历史哈希使摘录外变化也能失效缓存，但不能恢复原文。

阶段只影响排序，不是完成证明：最近检查偏向收敛，观察到写入或未知副作用偏向实现，否则偏向诊断。没有“尚无写入就禁用授权/反作弊卡”的规则。宿主没有可靠的下一次最终回复预告，同一回复里的计划和工具之间也没有注入点。

预算优先安排核心风险，并按等待轮次轮转，候选的阻塞前置与相应关系题一起评估。**单批可能延后短暂风险，不能同时保证每步全库覆盖。** `maxQuestions: 32` 加快覆盖，`0` 恢复穷举；SubQ 每批最多 16 题，最多两路并发。[SubQ 接口](https://docs.subq.ai/endpoints/decisions-api/)

默认 `readOnlyGating: "duplicates"` 仅跳过完整参数/结果未变化的重复只读证据，最多连续 2 次，不重放旧提醒。新意图、计划、回复、工具错误或未知副作用触发重新评估。`"bounded"` 允许跳过新的只读结果，会增加反应延迟；`"off"` 关闭。

冷却从**实际注入**计时，默认 3 个新证据轮次；相同快照重试不算新轮次。新修改、错误、目标或计划解除相应冷却，事实类卡也关注新阅读证据。授权、信任边界和反作弊核心卡不冷却。提醒送达不代表完成，冷却也不解除真实依赖阻塞。

## 关系与后端

状态为 `needed / addressing / satisfied / inapplicable / unknown`。SubQ 某状态达到阈值且为唯一最高概率时采用它。结构化后端返回枚举，**不伪造概率，不套用概率阈值**。所有模型状态都是当前证据判断，不是永久完成标记。

关系图检查重复 ID、引用与循环。`covers` 消除同义务的重复提醒，`blocks / requires` 推迟依赖它的提醒，`arbitrates` 保留解决张力的范围说明，`fuses` 保留双方正文但占一槽。结构边只用于无损合并，不因两个高分就全局阻塞独立工作。条件边仅两端入选候选时发题。

SubQ 部分批次失败只保留条件关系组件完整的结果；缺失前置或关系的组件标为未知。共同超时/主动取消不发布部分结果。服务故障默认退避 30 秒，避免每步重复等待超时；可用 `fallback: "none"` 关闭本地兜底。

离线引擎识别：最近检查失败、并发检查开始于最新写入前、失败命令报告缺少工具/脚本/模块、相同目标及报错连续重复。提醒核对诊断证据、可靠替代与真实阻塞，不自动安装、清理或索权。普通编辑不会被当成即将交付。

## 配置

全局 `~/.pi/agent/eng-protocol.json`，主要默认值：

```json
{
  "enabled": true,
  "maxCards": 3,
  "maxQuestions": 16,
  "minProbability": 0.6,
  "agencyLevel": "balanced",
  "sendReasoning": true,
  "localPrefilter": true,
  "cooldownSteps": 3,
  "readOnlyGating": "duplicates",
  "maxReadSkips": 2,
  "decision": {
    "provider": "subq",
    "endpoint": "https://api.subq.ai/v1/systemone",
    "model": "subq-snap-preview",
    "apiKey": "$SUBQ_API_KEY",
    "timeoutMs": 4000,
    "fallback": "local",
    "retryAfterMs": 30000,
    "maxOutputTokens": 4096,
    "structuredOutput": "json_schema"
  }
}
```

`maxQuestions` 接受 16–32 或 0；`cooldownSteps: 0` 关闭冷却。`apiKey` 支持字面值、`$VAR` / `${VAR}` 和 `!命令` 标准输出。取密钥命令仅在加载/重载全局配置时执行，日志不回显命令内容、密钥或无效配置值。

| provider | endpoint 示例 | 输出 |
| --- | --- | --- |
| `subq` | `https://api.subq.ai/v1/systemone` | 概率分布 |
| `openai` | `https://api.openai.com/v1/chat/completions` | JSON Schema 枚举 |
| `anthropic` | `https://api.anthropic.com/v1/messages` | JSON Schema 枚举 |
| `local` | 无网络 | 账本事实提醒 |

切换远端后端须在全局 `decision` 显式配置对应 `endpoint`、`model`、`apiKey`。OpenAI 兼容服务须支持 Chat Completions 的 `max_completion_tokens` 与 `response_format`；不支持严格 schema 时可显式使用 `structuredOutput: "json_object"`，仍在本地拒绝缺项、额外项、非法枚举、截断和拒绝输出。[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs?api-mode=chat)

Anthropic 使用 `output_config.format`、`max_tokens`、`x-api-key`，模型须支持该结构化输出契约；不使用 JSON mode 选项。[Anthropic Structured Outputs](https://platform.claude.com/docs/en/build-with-claude/structured-outputs)

纯离线只需 `"decision": { "provider": "local" }`，不执行取密钥命令。本地模型用 `openai` 与完整环回 HTTP 地址，`apiKey: ""` 只允许本机服务。远端要求 HTTPS，故障不自动切换到另一网络目的地。

项目 `.pi/eng-protocol.json` 可覆盖普通配置，**不能覆盖任何 `decision` 字段**。完整项目规范放在 `.pi/eng-protocol.md`。最多 3 张自定义纯文本卡：

```json
{
  "customCards": [{
    "id": "project_migration",
    "title": "迁移要求",
    "question": "当前持久化变更是否遗漏规定的可回滚迁移？只在有具体证据且尚未处理时提醒。",
    "guidance": "核对迁移约定，补齐本次变更所需的迁移及回滚路径。"
  }]
}
```

只允许这 4 个字段，ID 以 `project_` 开头；标题/问题/正文上限为 120/1200/1600 字符。项目卡替换上一层自定义列表，进入相同预算与冷却。纯文本规则仍是项目提供的提示内容，不是安全隔离沙箱。

| agencyLevel | 行为 |
| --- | --- |
| `passive` | 关闭 4 张主动卡；保留原 27 张和新增 7 张工程风险卡，必要纠错与阻塞说明仍适用 |
| `balanced` | 默认；明确目标分叉、能力缺口或具体后续影响才提醒 |
| `proactive` | 4 张主动卡的 SubQ 阈值降至最多 0.45；仍需具体证据，不强制每任务提问或创新 |

- `/protocol mode passive|balanced|proactive`：本会话切换，清空旧决策，下一次决策生效。
- `/protocol status`：后端、模式与会话指标。
- `/protocol show`：状态、来源、暂缓/冷却/压制原因、关系与实际注入文本。
- `/protocol on` / `off`：本会话开关。
- `/protocol reload`：重载规范、配置、项目规则及架构索引，清空缓存/冷却；常驻提示用于下一次代理运行。

指标包括缓存、节流、请求/题数、暂缓、冷却、故障、兜底和总等待时间；p50/p95 使用最近最多 256 次决策尝试，不含缓存/跳过。指标随会话开始清空。

远端会接收有界用户原话、项目摘录、工具参数/结果、计划、可用思考、账本和历史哈希。`sendReasoning: false` 关闭思考文本发送。加载插件的子代理也有调用开销。请求上限降低不等于固定降低 50% 费用/延迟，后两者取决于 token、定价和网络。

## 开发与验证

`guidance.ts` 管理配置、状态与图；`agent-cards.ts` 管理新增卡；`ledger.ts` 收集观察；`scheduling.ts` 管理预算/门控/冷却；`providers.ts` 适配后端与兜底；`decision.ts` 负责 HTTP；`index.ts` 接入 Pi 生命周期。

```powershell
node --test guidance.test.ts optimization.test.ts decision.test.mjs providers.test.mjs index.test.mjs runtime.test.mjs eval/checks.test.mjs
node D:/Myproject/SoL-Pi/node_modules/typescript/bin/tsc -p tsconfig.json
node eval/optimization-replay.mjs
node eval/agent-cases.mjs
```

类型检查路径沿用本机 Pi 安装。本地 HTTP 与生命周期测试覆盖取消、超时、部分失败、协议、分支、预算、公平轮转、合并、仲裁、冷却与消息不变性。调度回放测请求数，不测模型正确率或真实费用。见[本次验证记录](eval/validation-optimization-2026-10-17.md)。

## 模型评测

`eval/agent-cases.mjs` 提供 26 个合成正反例，含 `xy-problem-intent-fork`、`missing-cli-brute-force`、`reward-hacking-test-edit`、`sunk-cost-3-failures`，以及可靠替代、明确选择、合法测试更新、诊断已有进展等反例。

```powershell
# 使用实际预算和后端，会调用服务并产生费用
$env:MAX_QUESTIONS = '16' # 可设 32 或 0 对照暂缓影响
node eval/agent-routing.mjs > eval/routing-agent-result.json
```

支持 `CASE_IDS`、`CASE_FILE`、`AGENCY_LEVEL`。每例从冷状态开始；必选卡被预算暂缓也算未命中。故障保留记录。合成标签不能视为全库精确率或生产失败率。

`eval/routing.mjs` 保留 SubQ 穷举历史对照，**不应用生产调度**。支持 `BASELINE_REF`、`BASELINE_FILE`、`ROUTING_ARMS`；文件基线需携带同版本本地依赖文件。`candidate-flat` 复用概率检查关系图影响。

完整编码对照沿用相同静态规范、主动模式与项目规则，仅 `plugin` 组动态选卡：

```powershell
node eval/fixtures.mjs
$env:RUNS_DIR = 'runs-example'
$env:ARMS = 'static,plugin'
$env:TASKS = 't1_signature,t3_dependency,t4_conflict,t6_removal'
node eval/run.mjs 2 2
node eval/score.mjs | node eval/summary.mjs
```

`fixtures.mjs` 重建其 `eval/fixtures` 目录，并生成 `agent-routing/cases.json`。新的 `RUNS_DIR` 隔离实验；`PI_CLI`、`EVAL_MODEL` 覆盖 CLI 与模型；长任务用 `eval/long/run.mjs`、`score.mjs`，其 `RUNS_DIR` 相对 `eval/long`。

独立验收检查实际行为，模型测试只是补充；未知命令、缺失退出码、模型错误和超时不能冒充成功。记录代码/规范摘要、非秘密配置、主模型 token 与已知费用；决策费用未计入主模型费用，价格未知保持未知。主动建议质量及停工合理性仍需人工审阅，不能用关键词/风格评分。

历史结果见 [2026 模型问题验证](eval/validation-model-failures-2026-10-16.md)、[规则图验证](eval/validation-graph-2026-10-16.md)、[提醒边界验证](eval/validation-2026-10-16.md)，只反映当时实现。本地回归不替代真实模型校准或代表性生产评测。
