# 2026 模型问题转为决策卡：验证与限制

## 实现范围

根据 7 份原始来源，新增 `verification_budget`、`trust_boundary`、`evidence_provenance`、`progress_visibility`，补强 `context`、`halt`、`no_cheat`、`delivery`、`reporting`，并为 `navigation` 补上来源。来源分别属于厂商指南、事故分析、评估摘要和研究预印本；版本、日期、适用条件与外推限制见 [研究记录](../research/model-failures-2026.md)和[机器可读登记](../research/model-failures-2026.json)。

目前共 27 张卡、5 条关系、32 个问题，仍为两批请求、最多注入 3 张。没有新增关系、改阈值或按模型名字固定注入。相对本轮开始的 23 张卡、28 个问题，请求数相同，但问题文本增加，不能声称 token 或费用不变。

`evidence` 只用于审计，不发送到决策提示。常驻规范同步相应行为要求；卡片提醒发生在模型请求之间，不拦截工具，也无法保证消除提示注入或修复宿主显示问题。

## 程序检查

最终规则文本通过 48 项测试、TypeScript 检查和场景生成器语法检查：

```powershell
node --test guidance.test.ts decision.test.mjs index.test.mjs eval/checks.test.mjs
D:/Myproject/SoL-Pi/node_modules/.bin/tsc -p tsconfig.json
node --check eval/model-failures-cases.mjs
git diff --check
```

本轮新增来源登记检查：相关卡引用存在、来源有版本与限制、审计 ID 不进入决策问题。其他测试验证分批、状态与关系选择、HTTP 失败和取消、生命周期、缓存及记录完整性；不能证明模型理解正确。

## 决策接口检查

使用实际 `subq-snap-preview` 接口，阈值 0.6、最多 3 张、总超时 4000ms。`candidate-flat` 复用相同概率，只关闭关系处理，不是独立重复实验。记录中的 `experiment.model = srapi/gpt-6-luna` 是通用评测元数据默认值；本轮 `routing.mjs` 没有调用该主模型，也没有调用 Opus 或 Astra 执行任务。

诊断场景根据文献中的机制人工构造，标签在各次调用前确定；不是来源报告的原始轨迹。它们用于开发规则，不能作为独立留出集。检查指定必选、排除卡片，未对每张额外卡标注完整精确率。

| 原始记录 | 范围与结果 |
|---|---|
| [first](results-model-failures-first-20261016.json) | 新场景首轮 24/25；已授权继续工作的场景误选 `halt` |
| [regression](results-model-failures-regression-20261016.json) | 原有 30 个场景，当前候选版指定条件 30/30 |
| [authorization](results-model-failures-authorization-20261016.json) | 澄清授权规则后，5 个定向场景 5/5 |
| [final](results-model-failures-final-20261016.json) | 加入“拒绝但保留污染”和惰性攻击样本，27/27；此文件仍为中间版本 |
| [comparison](results-model-failures-comparison-20261016.json) | 原有 30 场景，保存的 23 卡基线与 27 卡候选均 30/30 |
| [verified](results-model-failures-verified-20261016.json) | 最终文本，加入客户端隐藏进展的反例，28/28；没有服务错误 |

上述各次调用未出现服务错误。所有中间记录与失败保留，不用最后一轮覆盖第一次失败。`verified` 的源码及来源登记摘要已与当前文件核对；`comparison` 发生在最后补充进展卡的客户端排除条件之前，不能称为最终文本的全部旧场景复测。基线来自本轮开始时保存的未提交工作区文件，使用 `baselineHash` 标识，不是当前 `HEAD`。

首轮失败暴露的是规则间职责冲突：用户已经授权，但再次请示被 `halt` 判为需要暂停。修订后明确同一目标、同一操作已获授权时满足授权条件，冗余请示由 `delivery` 处理；同时保留目标不同、缺少授权和真实高代价待决事项的暂停边界。

最终结果仍有额外误选。例如“拒绝攻击但保留可信污染”同时选出 `halt`、`candor`，来源无法读取却声称已核实的场景还选出 `no_cheat`。28/28 仅表示预先列明的必选与排除条件通过，不表示全部选卡正确，也不等于所有问题已解决。图组与平铺组在指定条件上同样通过，不能据此宣称图结构提高了成功率。

## 可支持的结论

现在能按当前证据提醒重复验证、外部指令与记忆污染、引用失实和缺少进展，并将提前收尾、重复请示、答案污染、授权范围和隐藏已知缺陷纳入已有卡。已确认这些规则能通过现有分批接口运行，并覆盖本轮指定的触发与反例。

尚未证明 Opus/Astra 的任务成功率、复发率或费用改善。要检验这些收益，需要在指定主模型与宿主上，用代表性任务及独立验收做对照。厂商建议、旧版本事故、小样本预印本和本轮合成选卡检查都不能替代这一证据。
