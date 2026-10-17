import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";
import { closeDecisionClient } from "./decision.ts";
import { buildDecisionQuestions, buildDecisionState, CARDS } from "./guidance.ts";
import { getDecisionProvider, resolveProviderResult } from "./providers.ts";

const snapshot = buildDecisionState([{ role: "user", content: "检查实现" }], { sendReasoning: false });
async function serve(t, handler) {
	const requests = [];
	const server = http.createServer((request, response) => {
		let text = "";
		request.on("data", (chunk) => { text += chunk; });
		request.on("end", () => { const body = JSON.parse(text); requests.push(body); handler(body, response, request.headers); });
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	t.after(async () => { closeDecisionClient(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
	return { source: { endpoint: `http://127.0.0.1:${server.address().port}`, apiKey: "test", model: "test" }, requests };
}

for (const provider of ["openai", "anthropic"]) {
	test(`${provider} sends one schema-constrained request and returns enums without invented confidence`, async (t) => {
		const questions = buildDecisionQuestions();
		const { source, requests } = await serve(t, (body, response, headers) => {
			const schema = provider === "openai" ? body.response_format.json_schema.schema : body.output_config.format.schema;
			assert.deepEqual(schema.required, questions.map((q) => q.id));
			assert.equal(schema.additionalProperties, false);
			assert.equal(provider === "openai" ? headers.authorization : headers["x-api-key"], provider === "openai" ? "Bearer test" : "test");
			if (provider === "anthropic") assert.equal(headers["anthropic-version"], "2023-06-01");
			const content = JSON.stringify(Object.fromEntries(questions.map((q) => [q.id, q.id.startsWith("relation_") ? "independent" : "needed"])));
			response.end(JSON.stringify(provider === "openai" ? { choices: [{ finish_reason: "stop", message: { content } }] } : { stop_reason: "end_turn", content: [{ type: "text", text: content }] }));
		});
		const result = await getDecisionProvider({ provider }).evaluate({ ...source, provider }, snapshot, questions, AbortSignal.timeout(2000));
		assert.equal(requests.length, 1);
		assert.equal(result.questionCount, questions.length);
		const resolved = resolveProviderResult(result, CARDS, 0.6);
		assert.equal(resolved.assessments.context.state, "needed");
		assert.deepEqual(resolved.assessments.context.probabilities, {});
	});
}

test("structured provider rejects truncation, refusal, invalid JSON and missing/extra states", async (t) => {
	const questions = buildDecisionQuestions().slice(0, 2);
	let reply;
	const { source } = await serve(t, (_body, response) => response.end(JSON.stringify(reply)));
	const provider = getDecisionProvider({ provider: "openai" });
	const call = () => provider.evaluate({ ...source, provider: "openai" }, snapshot, questions, AbortSignal.timeout(2000));
	for (const choice of [{ finish_reason: "length", message: { content: "{}" } }, { finish_reason: "stop", message: { refusal: "no", content: "{}" } }, { finish_reason: "stop", message: { content: "not JSON" } }, { finish_reason: "stop", message: { content: "{}" } }, { finish_reason: "stop", message: { content: JSON.stringify({ [questions[0].id]: "needed", [questions[1].id]: "needed", unexpected: "needed" }) } }]) {
		reply = { choices: [choice] };
		await assert.rejects(call());
	}
});

test("JSON mode compatibility remains explicitly selected and locally validated", async (t) => {
	const questions = buildDecisionQuestions().slice(0, 1);
	const { source } = await serve(t, (body, response) => {
		assert.deepEqual(body.response_format, { type: "json_object" });
		response.end(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ [questions[0].id]: "satisfied" }) } }] }));
	});
	const result = await getDecisionProvider({ provider: "openai" }).evaluate({ ...source, provider: "openai", structuredOutput: "json_object" }, snapshot, questions, AbortSignal.timeout(2000));
	assert.equal(result.answers[questions[0].id].state, "satisfied");
});

test("SubQ partial failures keep independent components and use at most two active requests", async (t) => {
	let active = 0;
	let peak = 0;
	let attempts = 0;
	const questions = buildDecisionQuestions();
	const { source } = await serve(t, (body, response) => {
		active++; peak = Math.max(peak, active);
		response.on("finish", () => active--);
		const fail = Object.hasOwn(body.questions, "relation_decision_blocks_continuation");
		setTimeout(() => {
			if (fail) { response.writeHead(503); response.end(); }
			else response.end(JSON.stringify({ answers: Object.fromEntries(Object.entries(body.questions).map(([id, question]) => [id, { probabilities: Object.fromEntries(Object.keys(question.criteria).map((key) => [key, key === (id.startsWith("relation_") ? "independent" : "needed") ? 1 : 0])) }])) }));
		}, 10);
	});
	const result = await getDecisionProvider(source).evaluate(source, snapshot, questions, AbortSignal.timeout(2000), () => attempts++);
	assert.ok(result.errors.length);
	assert.equal(peak, 2);
	assert.equal(attempts, result.batchCount);
	const resolved = resolveProviderResult(result, CARDS, 0.6);
	assert.equal(resolved.assessments.delivery.state, "unknown");
	assert.equal(resolved.assessments.ui.state, "needed");
});

test("provider cancellation cannot return partial results and an aborted call sends nothing", async (t) => {
	const { source, requests } = await serve(t, () => {});
	for (const provider of ["subq", "openai", "anthropic"]) {
		await assert.rejects(getDecisionProvider({ provider }).evaluate({ ...source, provider }, snapshot, buildDecisionQuestions(), AbortSignal.abort()));
	}
	assert.equal(requests.length, 0);
	await assert.rejects(getDecisionProvider(source).evaluate(source, snapshot, buildDecisionQuestions(), AbortSignal.timeout(30)));
});
