/**
 * Regression test for pc-0094.
 *
 * With strict tools enabled, Anthropic compiles the strict JSON schemas into a
 * sampling grammar and rejects the whole request when that grammar exceeds its
 * size limit:
 *
 *   400 invalid_request_error "The compiled grammar is too large, which would
 *   cause performance issues. Simplify your tool schemas or reduce the number of
 *   strict tools."
 *
 * Strict mode is only an optimization for tools that ask for it with
 * `strict: "prefer"`, so the request is retried once without strict tools
 * instead of failing the turn. Tools that require strict sampling keep failing,
 * because silently dropping strict would change their contract.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Tool } from "../src/types.ts";

const GRAMMAR_TOO_LARGE_MESSAGE =
	"400 invalid_request_error: The compiled grammar is too large, which would cause performance issues. " +
	"Simplify your tool schemas or reduce the number of strict tools.";

function createSseResponse(): Response {
	const events = [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_pc0094",
					usage: {
						input_tokens: 12,
						output_tokens: 0,
						cache_read_input_tokens: 0,
						cache_creation_input_tokens: 0,
					},
				},
			}),
		},
		{
			event: "content_block_start",
			data: JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text", text: "ok" } }),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: {
					input_tokens: 12,
					output_tokens: 5,
					cache_read_input_tokens: 0,
					cache_creation_input_tokens: 0,
				},
			}),
		},
		{ event: "message_stop", data: JSON.stringify({ type: "message_stop" }) },
	];
	return new Response(events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n"), {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

function providerError(status: number, message: string): Error {
	const error = new Error(message) as Error & { status: number; headers: Headers };
	error.status = status;
	error.headers = new Headers();
	return error;
}

/** Fake client that fails the first request and records every request it receives. */
function createFakeClient(firstError: Error): { client: Anthropic; requests: Array<Record<string, any>> } {
	const requests: Array<Record<string, any>> = [];
	const client = {
		messages: {
			create: (params: Record<string, any>) => {
				requests.push(params);
				if (requests.length === 1) {
					throw firstError;
				}
				return { asResponse: async () => createSseResponse() };
			},
		},
	} as unknown as Anthropic;
	return { client, requests };
}

function toolWithStrict(strict: "prefer" | "require"): Tool {
	return {
		name: "edit",
		description: "Edit a file.",
		parameters: Type.Object({
			path: Type.String(),
			text: Type.String(),
			optionalNote: Type.Optional(Type.String()),
		}),
		constrainedSampling: { type: "json_schema", strict },
	};
}

function contextWith(tools: Tool[]): Context {
	return {
		messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
		tools,
	};
}

const model = getModel("anthropic", "claude-haiku-4-5");

describe("Anthropic compiled-grammar-too-large retry (pc-0094)", () => {
	it("retries without strict tools when the compiled grammar is too large", async () => {
		const { client, requests } = createFakeClient(providerError(400, GRAMMAR_TOO_LARGE_MESSAGE));

		const result = await streamAnthropic(model, contextWith([toolWithStrict("prefer")]), { client }).result();

		expect(result.stopReason).toBe("stop");
		expect(requests).toHaveLength(2);
		expect(requests[0].tools[0].strict).toBe(true);
		expect(requests[1].tools[0].strict).toBeUndefined();
		// The unconstrained schema keeps the original optionality.
		expect(requests[1].tools[0].input_schema.required).toEqual(["path", "text"]);
	});

	it("does not retry other 400 errors", async () => {
		const { client, requests } = createFakeClient(
			providerError(400, "400 invalid_request_error: bad thinking config"),
		);

		const result = await streamAnthropic(model, contextWith([toolWithStrict("prefer")]), { client }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/bad thinking config/);
		expect(requests).toHaveLength(1);
	});

	it("does not drop strict sampling for tools that require it", async () => {
		const { client, requests } = createFakeClient(providerError(400, GRAMMAR_TOO_LARGE_MESSAGE));

		const result = await streamAnthropic(model, contextWith([toolWithStrict("require")]), { client }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/compiled grammar is too large/);
		expect(requests).toHaveLength(1);
	});

	it("does not retry when no tool was sent with strict sampling", async () => {
		const plainTool: Tool = {
			name: "edit",
			description: "Edit a file.",
			parameters: Type.Object({ path: Type.String() }),
		};
		const { client, requests } = createFakeClient(providerError(400, GRAMMAR_TOO_LARGE_MESSAGE));

		const result = await streamAnthropic(model, contextWith([plainTool]), { client }).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toMatch(/compiled grammar is too large/);
		expect(requests).toHaveLength(1);
	});
});
