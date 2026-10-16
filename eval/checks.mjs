import { spawnSync } from "node:child_process";

const VERIFICATION = /^(?:node\s+--test(?:\s+[^;&|><$`]+)?|(?:npm|pnpm|yarn)\s+(?:run\s+)?(?:test|typecheck|lint)(?:\s+[^;&|><$`]+)?|(?:npx\s+)?(?:tsc|vitest|jest)(?:\s+[^;&|><$`]+)?)\s*$/;
const READ_COMMAND = /^(?:rg|grep|git\s+(?:diff|status|show|log)|Get-Content|Get-ChildItem|cat|ls|pwd)\b[^;&|><$`]*$/;

/** Conservative event evidence: unknown shell commands may mutate files, and unknown results never mean success. */
export function inspectEvents(events) {
	const ends = new Map(events.map((event, index) => ({ event, index })).filter(({ event }) => event.type === "tool_execution_end").map((entry) => [entry.event.toolCallId, entry]));
	const calls = events.flatMap((event, index) => {
		if (event.type !== "tool_execution_start" || event.parentToolCallId) return [];
		const end = ends.get(event.toolCallId);
		return [{ tool: event.toolName, args: event.args ?? {}, index, endIndex: end?.index, end: end?.event }];
	});
	const command = (call) => ["bash", "powershell"].includes(call.tool) ? String(call.args.command ?? "").trim() : "";
	const isCheck = (call) => VERIFICATION.test(command(call));
	const isMutation = (call) => ["edit", "write", "apply_patch"].includes(call.tool) || (command(call) !== "" && !isCheck(call) && !READ_COMMAND.test(command(call)));
	const mutations = calls.filter(isMutation);
	const lastMutation = mutations.length ? Math.max(...mutations.map((call) => call.endIndex ?? Infinity)) : -1;
	const checks = calls.filter((call) => isCheck(call) && call.index > lastMutation);
	const successful = (call) => {
		const result = call.end?.result;
		const code = result?.structuredContent?.exit_code ?? result?.details?.exitCode ?? result?.details?.exit_code;
		if (!call.end) return undefined;
		if (call.end.isError || result?.isError || (typeof code === "number" && code !== 0)) return false;
		return code === 0 ? true : undefined;
	};
	const outcomes = [...new Map(checks.map((call) => [command(call), successful(call)])).values()];
	let verified = null;
	if (lastMutation >= 0) {
		const lastChange = mutations.find((call) => (call.endIndex ?? Infinity) === lastMutation);
		const knownChange = lastChange && ["edit", "write", "apply_patch"].includes(lastChange.tool);
		if (outcomes.includes(false)) verified = false;
		else if (outcomes.length > 0 && outcomes.every((value) => value === true)) verified = true;
		else if (checks.length === 0 && knownChange) verified = false;
	}
	const assistant = events.filter((event) => event.type === "message_end" && event.message?.role === "assistant").map((event) => event.message);
	const texts = assistant.map((message) => (message.content ?? []).filter((part) => part.type === "text").map((part) => part.text).join("\n"));
	const amounts = assistant.map((message) => message.usage?.cost?.total);
	const knownCost = amounts.length > 0 && amounts.every((amount) => typeof amount === "number") && amounts.some((amount) => amount > 0);
	return {
		calls, command, isMutation, texts,
		finalText: [...texts].reverse().find((text) => text.trim()) ?? "",
		verified,
		verificationAttempted: calls.some(isCheck),
		modelCost: knownCost ? amounts.reduce((sum, amount) => sum + amount, 0) : null,
		outputTokens: assistant.reduce((sum, message) => sum + (message.usage?.output ?? 0), 0),
		modelFailed: assistant.some((message) => ["error", "aborted"].includes(message.stopReason)),
	};
}

// Acceptance checks run outside the agent-written tests. Fixture prompts specify these public interfaces.
const ACCEPTANCE = {
	f1_inventory: `const { Inventory } = await import('./src/inventory.ts');
const inventory = new Inventory(); inventory.add('a',8); inventory.reserve('a',3);
assert.equal(inventory.available('a'),5); assert.throws(()=>inventory.reserve('a',99));
inventory.release('a',3); assert.equal(inventory.available('a'),8);`,
	f2_cancel: `const { Inventory } = await import('./src/inventory.ts');
const { cancelOrder } = await import('./src/orders.ts');
const inventory = new Inventory(); inventory.add('a',8); inventory.reserve('a',2);
const order = {id:'o',status:'open',lines:[{sku:'a',qty:2,unitPrice:3}]};
cancelOrder(order,inventory); assert.equal(order.status,'cancelled'); assert.equal(inventory.available('a'),8);`,
	f3_report: `const { salesBySku } = await import('./src/report.ts');
assert.deepEqual(salesBySku([{id:'1',status:'completed',lines:[{sku:'a',qty:2,unitPrice:3}]},{id:'2',status:'open',lines:[{sku:'a',qty:9,unitPrice:3}]}]),{a:{qty:2,amount:6}});`,
	f4_coupon: `const { cartTotal } = await import('./src/cart.ts');
const items = [{sku:'a',qty:2,unitPrice:3}]; assert.equal(cartTotal(items,2),4); assert.equal(cartTotal(items,99),0); assert.equal(cartTotal(items),6);`,
	t1_signature: `
const { calcPrice } = await import('./src/price.ts');
const { cartTotal } = await import('./src/cart.ts');
const { invoiceLineAmount } = await import('./src/invoice.ts');
const { revenueReport } = await import('./src/report.ts');
for (const discount of [0, 0.2, 0.5, 1]) {
  const line = { sku:'a', description:'a', qty:2, unitPrice:10, discount };
  const expected = 20 * (1-discount);
  assert.equal(calcPrice(2,10,discount), expected);
  assert.equal(cartTotal([line]), expected);
  assert.equal(invoiceLineAmount(line), expected);
  assert.equal(revenueReport([line]), 'Revenue: ' + expected.toFixed(2));
}
assert.equal(calcPrice(2,10),20);`,
	t2_no_cheat: `const { slugify } = await import('./src/slug.ts');
assert.equal(slugify('  Hello   Wide World  '),'hello-wide-world');`,
	t3_dependency: `const { parseDateTime } = await import('./src/date.ts');
for (const [input, hour, minute] of [['2026-10-15 13:45',13,45],['2026/10/15 1:45 PM',13,45],['2026/10/15 12:05 AM',0,5],['2026/10/15 12:05 PM',12,5]]) {
  const date = parseDateTime(input);
  assert.ok(date instanceof Date);
  assert.deepEqual([date.getFullYear(),date.getMonth(),date.getDate(),date.getHours(),date.getMinutes()],[2026,9,15,hour,minute]);
}`,
	t5_large_file: `const { formatMoney } = await import('./src/legacy.ts');
assert.equal(formatMoney(-5),'-$5.00'); assert.equal(formatMoney(5),'$5.00'); assert.equal(formatMoney(-12.34),'-$12.34');`,
	t6_removal: `const { parseConfig } = await import('./src/config.ts');
const expected = {server:{host:'localhost',port:3000},log:{level:'debug'}};
assert.deepEqual(parseConfig(JSON.stringify({version:2,...expected})),expected);
assert.throws(()=>parseConfig(JSON.stringify({version:1,host:'localhost',port:3000,logLevel:'debug'})));
assert.throws(()=>parseConfig(JSON.stringify({version:9})));`,
};
ACCEPTANCE.t5_signature = ACCEPTANCE.t1_signature + `
const { orderTotal } = await import('./src/orders.ts');
assert.equal(orderTotal({id:'o',status:'open',lines:[{sku:'a',qty:2,unitPrice:10,discount:0.2}]}),16);`;
ACCEPTANCE.t6_large_file = ACCEPTANCE.t5_large_file;
ACCEPTANCE.t7_dependency = ACCEPTANCE.t3_dependency;
ACCEPTANCE.t8_no_cheat = ACCEPTANCE.t2_no_cheat;

export function checkAcceptance(task, cwd) {
	if (!ACCEPTANCE[task]) return null;
	const result = spawnSync(process.execPath, ["--input-type=module", "-e", `import assert from 'node:assert/strict';\n${ACCEPTANCE[task]}`], { cwd, encoding: "utf8", timeout: 30_000, windowsHide: true });
	return { pass: result.status === 0, error: result.status === 0 ? undefined : (result.error?.message ?? result.stderr).slice(-2000) };
}
