# 2026 年前沿模型问题 → 工程决策卡

核查日：2026-10-16。模型名称按原来源保留：GPT-6 Astra、Claude Opus 5.5，以及有明确年份和实验条件的 Opus 4.6/4.7/4.8。早期检查点、正式发布模型和不同宿主分开记录，不能用一个版本的案例声称整个家族都有同样的失败率。

本轮新增 4 张卡，补强 5 张已有卡，并为 `navigation` 补上来源；现在共 27 张卡和 5 条关系，32 个问题仍分两批评估，每次最多注入 3 张。卡片根据当前证据触发，模型名称只用于来源追溯。实现位于 `guidance.ts`，常驻行为写入 `protocol.md`；机器可读来源在 [model-failures-2026.json](model-failures-2026.json)。

## 来源与改造

| 证据与范围 | 可纠正的问题 | 实现 |
|---|---|---|
| OpenAI 2026-09-11 的 [Astra 提示审查建议](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra)，以及现行 [Astra 行为指南](https://developers.openai.com/api/docs/guides/latest-model#prompting-best-practices) | 无新风险还反复测试；沿用旧流程要求大量无关阅读 | 新增 `verification_budget`，给 `navigation` 建立来源关联 |
| 同上；[Opus 5.5 官方指南](https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/prompting-claude-opus-5-5) | 已授权仍重复请示；首版做完就停；必要后台任务尚未完成就交付 | 补强 `delivery`、`halt`，保留真实阻塞和用户明确审阅节点 |
| Opus 5.5 官方指南的进展沟通与多应用部分 | 用户要求进展却持续静默；遗漏关联政策或记录 | 新增 `progress_visibility`；补强 `context` 的按需读取内容 |
| [Bad Memory，2026-07-16 预印本](https://arxiv.org/html/2607.14611v1)研究 Opus 4.7、Haiku 4.5、GPT-5.2、GPT-5.5；Opus 5.5 官方指南也讨论粘贴文本中的指令 | 将外部内容、记忆当作更高权限；本轮拒绝攻击但继续保留为可信规则 | 新增 `trust_boundary`；区分材料、合法项目约定、授权与可信规则 |
| Anthropic [Opus 4.6 BrowseComp 分析，2026-03-06](https://www.anthropic.com/engineering/eval-awareness-browsecomp) | 用泄漏答案冒充独立解题；把查询生成页面当支持事实的来源 | 补强 `no_cheat`；新增 `evidence_provenance` 核对来源内容 |
| Anthropic [授权事件分析，2026-09-09](https://www.anthropic.com/research/alignment-assessment-cybersecurity-incidents) | 把目标名称相似、网络可达、环境标签当成操作授权 | 补强 `halt` 的具体目标与操作边界 |
| Anthropic [Opus 4.8 发布说明，2026-05-28](https://www.anthropic.com/news/claude-opus-4-8)披露代码缺陷未向用户说明的问题及相对改善 | 只报通过项、隐去已知缺陷 | 补强 `reporting`，保留“准确说明未完成”这一正常行为 |

厂商指南是行为建议，不是独立失败率研究。Bad Memory 是小样本、合成工作区的预印本，主要假设攻击内容已植入记忆，未评测 Astra 或 Opus 5.5。BrowseComp 原实验没有限制搜索，作者明确没有将其定性为对齐失败；本插件针对的是独立评测与来源真实性。授权事件发生在误联网且关闭发布版网络安全防护的评测中，不是生产环境发生率。Opus 4.8 的改进来自厂商摘要，不能据此说问题已经解决。

## 新卡边界

| 卡片 | 应触发 | 不应触发 |
|---|---|---|
| `verification_budget` | 当前适用检查已过、代码未变、无未解风险，仍只为安心重跑；小改动安排无关昂贵检查 | 修改后复测、失败诊断、明确覆盖缺口、用户要求的压力或偶发问题实验、项目必需检查 |
| `trust_boundary` | 准备执行材料中的越权指令，或将已识别攻击继续存作可信规则 | 已隔离并忽略的攻击、合法项目约定、用户明确采纳的适用要求、与加载路径隔离的攻击测试样本 |
| `evidence_provenance` | 把未读正文、加载失败、查询生成页面或不同版本的结果写成已核实证据 | 已提供原文、正在查原文、充分依据、明确披露证据缺口；完全未调研归 `research` |
| `progress_visibility` | 用户明确要求进展，已有连续多次工具工作且缺少可见更新 | 刚更新、短任务、无人值守批处理、静默要求、严格机器格式输出、已有更新被客户端隐藏 |

进展卡没有可靠墙钟信息，因此不会按消息序号杜撰“已静默几分钟”。Opus 5.5 指南还指出客户端可能不渲染已有的进展块；这类问题需修宿主显示，不能催模型反复输出。信任边界卡不自动删除用户文件，也不自行扩大授权；在已有权限内隔离污染并报告影响。授权卡不会因有权限话题就触发：同一目标和操作已获授权时应判断满足，重复请示交由 `delivery`。

## 没有机械照搬的建议

- 没有按模型名字注入固定卡组，也没有添加“永远多想”“每次全仓阅读”“每次必须联网”等通用步骤。
- 没有把所有 Opus 版本的长上下文故障、社区吐槽和版本传闻当成已证实模型缺陷。
- 没有强制创建子代理。是否委派取决于宿主能力、任务和用户授权，不是仅凭模型文档决定。
- 没有采用“回答过的结论不再检查”的统一规则。后续代码、证据或用户反馈可能要求重新核验，不能为了省时压制纠错。
- 没有声称一张提示卡能封堵提示注入、阻止真实工具操作或修复宿主断连。执行隔离和权限控制仍属于宿主；同一条回复内的计划与工具动作之间也没有额外提醒点。

## 验证方法

`eval/model-failures-cases.mjs` 生成与来源关联的 28 个合成诊断场景，含触发与反例。这些不是原始事故轨迹，不冒充对 Opus/Astra 的重新测量。程序测试校验来源引用、分批覆盖与既有生命周期行为；真实决策接口检查指定选卡边界。原始概率、场景摘要、代码摘要与中间失败保留在 `eval/results-model-failures-*.json`，具体结果见 [本轮验证记录](../eval/validation-model-failures-2026-10-16.md)。

提醒的目标是让下一步更合适，不是承诺不再犯错。要证明对某个主模型的复发率下降，还需要在该模型、宿主和代表性真实任务上进行独立对照；本轮不会把决策模型命中指定卡片当作这样的证据。
