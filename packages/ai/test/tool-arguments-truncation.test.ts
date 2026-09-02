/**
 * Regression test for pc-0025.
 *
 * A large edit tool call failed twice with `edits.0.newText: must have required
 * properties newText`, and the echoed "Received arguments" showed a complete
 * `oldText` with no `newText` at all. The arguments were not dropped by
 * validation: the provider's tool-call JSON ended mid-payload, and
 * `parseStreamingJson` fell back to `partial-json`, which silently returns the
 * well-formed prefix. Trailing properties therefore disappear before validation
 * ever runs, and the resulting schema error reads like a malformed tool call.
 *
 * Truncated payloads are now marked, and the validation error says the arguments
 * were cut off instead of only reporting the missing property.
 */
import type Anthropic from "@anthropic-ai/sdk";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { stream as streamAnthropic } from "../src/api/anthropic-messages.ts";
import { getModel } from "../src/compat.ts";
import type { Context, Tool, ToolCall } from "../src/types.ts";
import { isTruncatedJson, parseStreamingJson } from "../src/utils/json-parse.ts";
import { validateToolArguments } from "../src/utils/validation.ts";

const editTool: Tool = {
	name: "edit",
	description: "Edit a file.",
	parameters: Type.Object({
		path: Type.String(),
		edits: Type.Array(
			Type.Object({
				oldText: Type.String(),
				newText: Type.String(),
			}),
		),
	}),
};

const fullEditArguments = JSON.stringify({
	path: "packages/coding-agent/src/core/tools/bash.ts",
	edits: [{ oldText: "old\n".repeat(45), newText: "new\n".repeat(60) }],
});

/** The stream cuts off right where `newText` would have started. */
const truncatedEditArguments = fullEditArguments.slice(0, fullEditArguments.indexOf('"newText"'));

function createSseResponse(events: Array<{ event: string; data: string }>): Response {
	const body = events.map(({ event, data }) => `event: ${event}\ndata: ${data}\n`).join("\n");
	return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function createFakeAnthropicClient(response: Response): Anthropic {
	return {
		messages: { create: () => ({ asResponse: async () => response }) },
	} as unknown as Anthropic;
}

function anthropicToolCallEvents(partialJson: string, stopReason: string): Array<{ event: string; data: string }> {
	return [
		{
			event: "message_start",
			data: JSON.stringify({
				type: "message_start",
				message: {
					id: "msg_pc0025",
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
			data: JSON.stringify({
				type: "content_block_start",
				index: 0,
				content_block: { type: "tool_use", id: "toolu_pc0025", name: "edit", input: {} },
			}),
		},
		{
			event: "content_block_delta",
			data: JSON.stringify({
				type: "content_block_delta",
				index: 0,
				delta: { type: "input_json_delta", partial_json: partialJson },
			}),
		},
		{ event: "content_block_stop", data: JSON.stringify({ type: "content_block_stop", index: 0 }) },
		{
			event: "message_delta",
			data: JSON.stringify({
				type: "message_delta",
				delta: { stop_reason: stopReason },
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
}

async function streamToolCall(partialJson: string, stopReason: string): Promise<ToolCall | undefined> {
	const model = getModel("anthropic", "claude-haiku-4-5");
	const context: Context = {
		messages: [{ role: "user", content: "Use the edit tool.", timestamp: Date.now() }],
		tools: [editTool],
	};
	const stream = streamAnthropic(model, context, {
		client: createFakeAnthropicClient(createSseResponse(anthropicToolCallEvents(partialJson, stopReason))),
	});
	const result = await stream.result();
	return result.content.find((block): block is ToolCall => block.type === "toolCall");
}

describe("truncated tool call arguments (pc-0025)", () => {
	it("drops trailing properties when the argument JSON is cut off", () => {
		const parsed = parseStreamingJson<{ edits: Array<Record<string, unknown>> }>(truncatedEditArguments);
		expect(Object.keys(parsed.edits[0])).toEqual(["oldText"]);
	});

	it("marks arguments parsed from incomplete JSON as truncated", () => {
		expect(isTruncatedJson(parseStreamingJson(truncatedEditArguments))).toBe(true);
	});

	it("does not mark arguments parsed from complete JSON", () => {
		expect(isTruncatedJson(parseStreamingJson(fullEditArguments))).toBe(false);
	});

	it("explains the truncation instead of only reporting the missing property", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "toolu_pc0025",
			name: "edit",
			arguments: parseStreamingJson(truncatedEditArguments),
		};

		expect(() => validateToolArguments(editTool, toolCall)).toThrow(/truncated/i);
		try {
			validateToolArguments(editTool, toolCall);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain("cut off");
			// The schema detail stays, but it is no longer the whole story.
			expect(message).toContain("newText");
		}
	});

	it("keeps validation errors unchanged for complete arguments", () => {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "toolu_pc0025",
			name: "edit",
			arguments: { path: "a.ts", edits: [{ oldText: "a" }] },
		};

		try {
			validateToolArguments(editTool, toolCall);
			throw new Error("expected validation to fail");
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			expect(message).toContain("newText");
			expect(message).not.toMatch(/truncated/i);
		}
	});

	it("marks a truncated Anthropic tool call so validation can explain it", async () => {
		const toolCall = await streamToolCall(truncatedEditArguments, "max_tokens");
		expect(toolCall).toBeDefined();
		expect(toolCall?.arguments.edits[0].newText).toBeUndefined();
		expect(isTruncatedJson(toolCall?.arguments)).toBe(true);
		expect(() => validateToolArguments(editTool, toolCall as ToolCall)).toThrow(/truncated/i);
	});

	it("leaves complete Anthropic tool calls unmarked", async () => {
		const toolCall = await streamToolCall(fullEditArguments, "tool_use");
		expect(toolCall).toBeDefined();
		expect(isTruncatedJson(toolCall?.arguments)).toBe(false);
		expect(() => validateToolArguments(editTool, toolCall as ToolCall)).not.toThrow();
	});
});
