import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { closeDecisionClient, evaluateDecision } from "./decision.ts";
import { buildDecisionState } from "./guidance.ts";

const questions = Array.from({ length: 40 }, (_, i) => ({ id: `rule_${i}`, instructions: "Classify the current obligation.", criteria: { needed: "Needs action", satisfied: "Already fulfilled" } }));
const state = buildDecisionState([{ role: "user", content: "完成工作" }], { sendReasoning: false });
const answer = (payload, response) => response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(payload.questions).map((id) => [id, { probabilities: { needed: 0.9, satisfied: 0.1 } }])) }));

async function serve(t, handler) {
	const server = http.createServer((request, response) => {
		let body = "";
		request.on("data", (chunk) => { body += chunk; });
		request.on("end", () => handler(JSON.parse(body), response));
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => {
		closeDecisionClient();
		server.closeAllConnections();
		await new Promise((resolve) => server.close(resolve));
	});
	return { endpoint: `http://127.0.0.1:${server.address().port}`, model: "test", apiKey: "test" };
}

test("all batches use one snapshot and at most two requests run concurrently", { timeout: 3000 }, async (t) => {
	const received = [];
	let release;
	const firstTwo = new Promise((resolve) => { release = resolve; });
	let active = 0;
	let maximum = 0;
	const source = await serve(t, (payload, response) => {
		active++;
		maximum = Math.max(maximum, active);
		response.on("finish", () => active--);
		received.push({ payload, response });
		if (received.length === 2) release();
		if (received.length > 2) answer(payload, response);
	});
	const pending = evaluateDecision(source, state, AbortSignal.timeout(2000), questions);
	await firstTwo;
	assert.equal(received.length, 2);
	answer(received[0].payload, received[0].response);
	answer(received[1].payload, received[1].response);
	const result = await pending;
	assert.equal(maximum, 2);
	assert.equal(result.batchCount, 3);
	assert.equal(result.questionCount, 40);
	assert.equal(Object.keys(result.probabilities).length, 40);
	assert.deepEqual(received.map(({ payload }) => Object.keys(payload.questions).length), [16, 16, 8]);
	for (const { payload } of received) assert.deepEqual(payload.state, JSON.parse(JSON.stringify(state)));
});

test("a failed batch cancels its sibling and never schedules queued batches or returns partial success", { timeout: 3000 }, async (t) => {
	let calls = 0;
	let first;
	let closed;
	const siblingClosed = new Promise((resolve) => { closed = resolve; });
	const source = await serve(t, (_payload, response) => {
		calls++;
		if (calls === 1) { first = response; response.on("close", closed); return; }
		response.writeHead(503);
		response.end();
	});
	await assert.rejects(evaluateDecision(source, state, AbortSignal.timeout(2000), questions), /HTTP 503/);
	await siblingClosed;
	assert.equal(calls, 2);
	assert.ok(first.destroyed);
});

test("malformed late batch discards already completed batches", { timeout: 3000 }, async (t) => {
	let calls = 0;
	const source = await serve(t, (payload, response) => {
		if (++calls < 3) answer(payload, response);
		else response.end(JSON.stringify({ answers: {} }));
	});
	await assert.rejects(evaluateDecision(source, state, AbortSignal.timeout(2000), questions), /选项不完整/);
	assert.equal(calls, 3);
});

test("one deadline covers active and queued batches", { timeout: 3000 }, async (t) => {
	let calls = 0;
	const source = await serve(t, (payload, response) => {
		calls++;
		if (calls < 3) setTimeout(() => answer(payload, response), 100);
	});
	await assert.rejects(evaluateDecision(source, state, AbortSignal.timeout(180), questions), /超时/);
	assert.equal(calls, 3, "the later batch shares the original deadline");
});

test("an already cancelled decision sends no requests", async (t) => {
	let calls = 0;
	const source = await serve(t, () => calls++);
	await assert.rejects(evaluateDecision(source, state, AbortSignal.abort(), questions));
	assert.equal(calls, 0);
});
