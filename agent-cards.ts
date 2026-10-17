import type { GuidanceCard } from "./guidance.ts";

// Engineering risk categories requested for this plugin. These do not claim a
// measured failure rate, an RL cause, or applicability to every model/version.
export const AGENT_CARDS: readonly GuidanceCard[] = [
	{
		id: "toolchain_gap", title: "必要工具链与能力缺口", phase: "diagnosis", priority: 3, agency: true,
		when: "Concrete missing tooling, credentials, permission or environment capability blocks the current goal, and the next plan hides that gap or builds a demonstrably brittle, disproportionate workaround. A missing optional tool, a reliable installed alternative, a small appropriate assertion script or already-authorized environment repair is not a reason to stop. Request user action only for the specific capability the agent cannot obtain within existing authority; continue independent work. Never ask the user to paste secrets into chat.",
		rules: ["必要能力缺失且替代方案明显脆弱时，说明缺口、影响和推荐的安装或配置办法；命令须匹配实际环境。可用可靠现有工具或授权内修复时直接推进。", "确需用户提供权限或环境条件时，提出具体、带推荐的选择，并继续不依赖它的工作；密钥通过安全配置渠道提供，不要求粘贴到对话。"],
	},
	{
		id: "intent_discovery", title: "真实目标与关键方案分叉", phase: "diagnosis", priority: 2, agency: true,
		when: "Concrete ambiguity or a flawed means-to-goal premise leaves materially different product/architecture outcomes, and the next action would commit to a costly branch without checking intent. State the inferred goal as a hypothesis, not as knowing better than the user. Clear requests, already-resolved choices, low-cost reversible implementation details and ordinary investigation do not need another question. A broad task alone is insufficient.",
		rules: ["发现高代价的目标分叉或 XY 问题时，简述对真实目标的推断，给出 2–3 个有区别的方向、主要代价和明确推荐，再对齐关键选择。已有明确决定直接执行；低代价且可逆的实现细节自主判断。"],
	},
	{
		id: "leverage_proposal", title: "有依据的更简方案", phase: "implementation", agency: true,
		when: "Current code or applicable authoritative evidence establishes a materially simpler, more maintainable way to achieve the SAME goal than a concretely wasteful plan, and that alternative has not been considered. Require an identified reusable capability and actual tradeoff, not fashionable patterns, hypothetical scale or novelty. Respect a user's informed rejection. In-scope small reversible improvements can proceed; broader proposals are discussion, not authorization to implement.",
		rules: ["发现可复用的现有能力或明显更简方案时，简短对比实际收益、限制与成本，并给出推荐。授权内的小幅内部改进可直接完成；超出范围的方案先提出供选择，不擅自扩大修改。不要为展示创新强造新架构。"],
	},
	{
		id: "foresight", title: "交付中的具体后续影响", phase: "delivery", agency: true,
		when: "Evidence establishes a consequential second-order effect of THIS change that the planned delivery would omit, such as a real migration dependency or operational impact. Offer only one or two actionable insights. Hypothetical scale, generic best practices, already-addressed implications, repetitive upselling and requested silence/strict output are inapplicable. Required work within the current scope must be completed, not rebranded as an optional follow-up. Specific migration/concurrency cards handle immediate fixes; use this for a separate communication obligation.",
		rules: ["交付时只补充有证据、与本次改动直接相关的 1–2 条后续影响，说明具体场景和可执行建议。当前范围内必要工作先完成；额外想法作为可选建议，不自动执行、不固定以追问结尾，尊重静默和输出格式要求。"],
	},
	{
		id: "anti_reward_hacking", title: "测试约束与类型约束完整性", phase: "implementation", priority: 3,
		when: "Concrete evidence shows the agent reacting to a failed check by weakening a required assertion, skipping a required test, mocking away the behavior under test, hardcoding a benchmark input or suppressing a real type/lint error. Merely modifying tests, using an intentional mock or a documented compatibility annotation is not evidence. Authoritative contract changes and justified corrections of invalid tests are legitimate; user approval is not the only possible evidence that a test is wrong. Select only the actual evasion obligation; unrelated contract conflicts remain separate.",
		rules: ["核对失败对应的权威契约。不要通过削弱断言、跳过必要用例、Mock 掉被测行为或类型逃逸来隐藏真实错误；修复根因。", "确需修正旧测试或使用边界类型适配时说明依据并保留有效覆盖；只撤销本任务中确认有问题的妥协，保留用户改动和已授权的新契约。"],
	},
	{
		id: "thrashing", title: "连续受挫后的诊断转向", phase: "diagnosis", priority: 3,
		when: "At least two completed operations against the SAME target have materially similar failures, and the next action repeats blind patches, flags or retries without new diagnostic evidence. A first expected reproduction failure, bounded retries for a transient service, independent failures or an ongoing investigation are not thrashing. This can concern command/environment failures without two code-fix cycles.",
		rules: ["同一目标连续受挫且没有新依据时，暂停该目标上的盲改或重试，先读取关键报错并做能区分原因的小检查。", "继续其他可独立完成的已授权工作；确认外部环境或待决需求阻塞后说明证据与所需条件，不把一个局部失败扩大成整项任务停工。"],
	},
	{
		id: "abandoned_cleanup", title: "替代方案后的遗留清理", phase: "delivery",
		when: "An observed implementation strategy was replaced and concrete files, symbols or configuration from the abandoned attempt remain unused or conflicting. A change of plan alone or lack of a git diff excerpt is insufficient. Cleanup already underway, intentionally retained alternatives and pre-existing user work do not need intervention.",
		rules: ["方案替换后检查本任务旧尝试留下的代码与配置，移除已确认无用或冲突的部分，并核对相关调用与 Diff。保留最终方案仍需要的内容和用户原有改动；不机械回滚整个文件。"],
	},
	{
		id: "no_silent_swallow", title: "内部异常的可诊断性", phase: "implementation",
		when: "Concrete proposed or observed code hides a violated internal invariant with an empty catch, unjustified fallback or optional chain, converting a real failure into misleading success/data. Optional external inputs, explicitly designed fail-open behavior with diagnostics and documented best-effort cleanup are legitimate. Syntax alone is insufficient; require evidence of the contract being hidden.",
		rules: ["区分合法可选输入与内部契约破坏。对后者修复产生源或返回/抛出带必要上下文的错误，避免用空 catch 或无依据默认值伪装成功。保留项目明确设计且可诊断的 fail-open 行为。"],
	},
	{
		id: "reproduce_before_fix", title: "修复所依据的故障证据", phase: "diagnosis",
		when: "For an actual bug fix, the next production patch is speculative because neither a reproduction nor adequate logs/runtime/static causal evidence establish the failing path. Existing reliable reproduction supplied by the user, a clear demonstrated cause, or investigation already underway is sufficient; never require a new test merely as ceremony. Feature work and requested contract changes are inapplicable.",
		rules: ["推测性修复前，用已有失败用例、最小复现、日志或足够明确的因果证据确认触发路径；已有可靠证据直接使用。修复后用适用检查确认原故障消失，无法复现时明确证据限制。"],
	},
	{
		id: "local_version_truth", title: "项目实际依赖与接口版本", phase: "diagnosis",
		when: "A concrete upcoming third-party API call or framework configuration assumes a version contradicted by the project, or relies on unresolved version assumptions without inspecting applicable manifests, lockfiles, installed definitions or established usages. A relevant version already established is satisfied. Do not demand rereading all manifests for routine usage or assume an absent excerpt means no inspection. Research must match the version actually used.",
		rules: ["第三方接口存在版本疑问时，先核对项目声明、锁文件、已安装定义或同库用法，再查匹配版本的官方资料。区分声明范围与实际解析版本；已有适用证据直接复用。"],
	},
	{
		id: "artifact_cleanup", title: "调试产物与进程清理", phase: "delivery",
		when: "Concrete temporary debug output, disposable scripts/configuration or background processes created for THIS task remain when the agent intends to finish. Permanent regression tests, requested deliverables, useful retained reproducers and pre-existing changes/processes are legitimate. No git status excerpt alone proves no cleanup. Require identifiable ownership and temporary intent before removal.",
		rules: ["交付前核对本任务临时加入的调试输出、脚本、配置及后台进程，清理已不再需要且归属明确的副作用。保留应交付的回归测试、复现材料和用户原有工作。", "用适用的状态或 Diff 检查确认剩余改动都可解释；无需把工作区强制变成空 Diff，不删除不明归属文件或终止不明进程。"],
	},
];
