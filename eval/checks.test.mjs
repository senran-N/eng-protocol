import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import test from "node:test";
import { checkAcceptance, inspectEvents } from "./checks.mjs";

let sequence = 0;
function call(toolName, args, exitCode, isError = false) {
	const toolCallId = `call-${++sequence}`;
	return [
		{ type: "tool_execution_start", toolCallId, toolName, args },
		{ type: "tool_execution_end", toolCallId, isError, result: { structuredContent: exitCode === undefined ? undefined : { exit_code: exitCode } } },
	];
}
const edit = () => call("edit", { path: "src/code.ts" });
const check = (code = 0) => call("bash", { command: "npm test" }, code);

test("verification uses completed successful checks after the last mutation", () => {
	assert.equal(inspectEvents([...edit(), ...check()]).verified, true);
	assert.equal(inspectEvents([...edit(), ...check(1)]).verified, false);
	assert.equal(inspectEvents([...edit(), check()[0]]).verified, null);
	assert.equal(inspectEvents([...edit(), ...call("bash", { command: "npm test" })]).verified, null);
	assert.equal(inspectEvents([...edit(), ...check(), ...edit()]).verified, false);
	assert.equal(inspectEvents([...check()]).verified, null);
	assert.equal(inspectEvents([...edit(), ...check(1), ...check()]).verified, true);
});

test("shell writes, overlapping tools and failed results cannot imply verification", () => {
	assert.equal(inspectEvents([...edit(), ...check(), ...call("powershell", { command: "Set-Content src/code.ts changed" }, 0)]).verified, null);
	assert.equal(inspectEvents([...edit(), ...call("bash", { command: "echo npm test" }, 0)]).verified, null);
	assert.equal(inspectEvents([...edit(), ...call("bash", { command: "npm test; echo ok" }, 0)]).verified, null);
	assert.equal(inspectEvents([...edit(), ...check(), ...call("bash", { command: "cat old.ts > src/code.ts" }, 0)]).verified, null);
	assert.equal(inspectEvents([...edit(), ...call("bash", { command: "npm test" }, 0, true)]).verified, false);
	const [startEdit, endEdit] = edit();
	const [startCheck, endCheck] = check();
	assert.equal(inspectEvents([startEdit, startCheck, endCheck, endEdit]).verified, false);
});

test("missing pricing stays unknown, and failed model responses are visible", () => {
	const message = (cost, stopReason = "stop") => ({ type: "message_end", message: { role: "assistant", content: [], usage: { cost: { total: cost }, output: 10 }, stopReason } });
	assert.equal(inspectEvents([message(undefined)]).modelCost, null);
	assert.equal(inspectEvents([message(0)]).modelCost, null);
	assert.equal(inspectEvents([message(0.5), message(0.25)]).modelCost, 0.75);
	assert.equal(inspectEvents([message(0, "error")]).modelFailed, true);
});

test("independent acceptance rejects absent and empty date implementations", () => {
	const directory = mkdtempSync(join(tmpdir(), "eng-protocol-acceptance-"));
	try {
		mkdirSync(join(directory, "src"));
		writeFileSync(join(directory, "package.json"), '{"type":"module"}');
		assert.equal(checkAcceptance("t3_dependency", directory).pass, false);
		writeFileSync(join(directory, "src/date.ts"), "export function parseDateTime() {}\n");
		assert.equal(checkAcceptance("t3_dependency", directory).pass, false);
		writeFileSync(join(directory, "src/date.ts"), `export function parseDateTime(text) {
  const [date, time, period] = text.split(' ');
  const [year,month,day] = date.split(/[-/]/).map(Number);
  let [hour,minute] = time.split(':').map(Number);
  if (period) hour = hour % 12 + (period === 'PM' ? 12 : 0);
  return new Date(year,month-1,day,hour,minute);
}`);
		assert.equal(checkAcceptance("t3_dependency", directory).pass, true);
	} finally {
		assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep));
		rmSync(directory, { recursive: true, force: true });
	}
});
