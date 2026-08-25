import { describe, expect, it } from "vitest";
import { transformMessages } from "../src/api/transform-messages.ts";
import type { AssistantMessage, Message, Model, ToolCall, ToolResultMessage } from "../src/types.ts";

function makeModel(): Model<"anthropic-messages"> {
	return {
		id: "claude-sonnet-4.6",
		name: "Claude Sonnet 4.6",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
	};
}

function makeAssistant(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "toolUse",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4.6",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: Date.now(),
	};
}

function makeToolResult(toolCallId: string, text = "output"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: Date.now(),
	};
}

describe("transformMessages: orphaned tool results from error/aborted assistants", () => {
	it("drops tool results whose tool call was from an aborted assistant", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			makeAssistant([{ type: "toolCall", id: "toolu_001", name: "bash", arguments: { command: "ls" } }], "aborted"),
			makeToolResult("toolu_001", "file1\nfile2"),
			{ role: "user", content: "try again", timestamp: Date.now() },
			makeAssistant([{ type: "toolCall", id: "toolu_002", name: "bash", arguments: { command: "pwd" } }]),
			makeToolResult("toolu_002", "/home"),
		];

		const result = transformMessages(messages, model);

		// The aborted assistant and its tool result should be gone
		const assistantMsgs = result.filter((m) => m.role === "assistant") as AssistantMessage[];
		expect(assistantMsgs).toHaveLength(1);
		expect((assistantMsgs[0].content[0] as ToolCall).id).toBe("toolu_002");

		// Only the valid tool result should remain
		const toolResults = result.filter((m) => m.role === "toolResult") as ToolResultMessage[];
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("toolu_002");
	});

	it("drops tool results whose tool call was from an errored assistant", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "do something", timestamp: Date.now() },
			makeAssistant([{ type: "toolCall", id: "toolu_001", name: "bash", arguments: { command: "ls" } }], "error"),
			makeToolResult("toolu_001", "output"),
		];

		const result = transformMessages(messages, model);

		// Both the errored assistant and its tool result should be dropped
		expect(result.filter((m) => m.role === "assistant")).toHaveLength(0);
		expect(result.filter((m) => m.role === "toolResult")).toHaveLength(0);
	});

	it("drops multiple tool results from an aborted assistant with parallel tool calls", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "run commands", timestamp: Date.now() },
			makeAssistant(
				[
					{ type: "toolCall", id: "toolu_001", name: "bash", arguments: { command: "ls" } },
					{ type: "toolCall", id: "toolu_002", name: "read", arguments: { path: "README.md" } },
				],
				"aborted",
			),
			makeToolResult("toolu_001", "file1\nfile2"),
			makeToolResult("toolu_002", "# README"),
			{ role: "user", content: "continue", timestamp: Date.now() },
			makeAssistant([{ type: "toolCall", id: "toolu_003", name: "bash", arguments: { command: "pwd" } }]),
			makeToolResult("toolu_003", "/home"),
		];

		const result = transformMessages(messages, model);

		const toolResults = result.filter((m) => m.role === "toolResult") as ToolResultMessage[];
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("toolu_003");
	});

	it("preserves valid tool results that precede an aborted assistant", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "step 1", timestamp: Date.now() },
			makeAssistant([{ type: "toolCall", id: "toolu_001", name: "bash", arguments: { command: "echo hi" } }]),
			makeToolResult("toolu_001", "hi"),
			// This assistant aborts — its results should be dropped, not the previous ones
			makeAssistant(
				[{ type: "toolCall", id: "toolu_002", name: "bash", arguments: { command: "false" } }],
				"aborted",
			),
			makeToolResult("toolu_002", ""),
			{ role: "user", content: "retry", timestamp: Date.now() },
		];

		const result = transformMessages(messages, model);

		const toolResults = result.filter((m) => m.role === "toolResult") as ToolResultMessage[];
		expect(toolResults).toHaveLength(1);
		expect(toolResults[0].toolCallId).toBe("toolu_001");
	});

	it("does not insert synthetic tool results for dropped tool calls", () => {
		const model = makeModel();
		const messages: Message[] = [
			{ role: "user", content: "run a command", timestamp: Date.now() },
			makeAssistant([{ type: "toolCall", id: "toolu_001", name: "bash", arguments: { command: "ls" } }], "aborted"),
			makeToolResult("toolu_001", "output"),
		];

		const result = transformMessages(messages, model);

		// No synthetic "No result provided" for the dropped tool call
		const synthetic = result.filter((m) => m.role === "toolResult" && (m as ToolResultMessage).isError);
		expect(synthetic).toHaveLength(0);
	});
});
