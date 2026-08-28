/**
 * Tests for the model_failover extension event: swapping the model before an auto-retry.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { type AssistantMessage, type AssistantMessageEvent, EventStream, getModel } from "@earendil-works/pi-ai/compat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentSession, type AgentSessionEvent } from "../src/core/agent-session.ts";
import { AuthStorage } from "../src/core/auth-storage.ts";
import type { ExtensionAPI, ModelFailoverEvent, ModelSelectEvent } from "../src/core/extensions/index.ts";
import { SessionManager } from "../src/core/session-manager.ts";
import { SettingsManager } from "../src/core/settings-manager.ts";
import { createModelRegistry, getModelRuntime } from "./model-runtime-test-utils.ts";
import { createTestExtensionsResult, createTestResourceLoader } from "./utilities.ts";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type");
			},
		);
	}
}

function createAssistantMessage(text: string, overrides?: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

interface CreatedSession {
	session: AgentSession;
	getCallCount: () => number;
	sessionEvents: AgentSessionEvent[];
	failoverEvents: ModelFailoverEvent[];
	modelSelectEvents: ModelSelectEvent[];
}

describe("AgentSession model failover", () => {
	let session: AgentSession;
	let tempDir: string;

	beforeEach(() => {
		tempDir = join(tmpdir(), `pi-model-failover-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (session) {
			session.dispose();
		}
		if (tempDir && existsSync(tempDir)) {
			rmSync(tempDir, { recursive: true });
		}
	});

	async function createSession(options: {
		failCount?: number;
		maxRetries?: number;
		/** Model returned by the failover handler, keyed by upcoming attempt number. */
		failoverResponses?: Record<number, { provider: string; id: string } | undefined>;
		/** Register no model_failover handler at all. */
		withoutHandler?: boolean;
	}): Promise<CreatedSession> {
		const failCount = options.failCount ?? 1;
		const maxRetries = options.maxRetries ?? 3;
		let callCount = 0;

		const model = getModel("anthropic", "claude-sonnet-4-5")!;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: "Test", tools: [] },
			streamFn: () => {
				callCount++;
				const stream = new MockAssistantStream();
				queueMicrotask(() => {
					if (callCount <= failCount) {
						const msg = createAssistantMessage("", {
							stopReason: "error",
							errorMessage: "overloaded_error",
						});
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "error", reason: "error", error: msg });
					} else {
						const msg = createAssistantMessage("Success");
						stream.push({ type: "start", partial: msg });
						stream.push({ type: "done", reason: "stop", message: msg });
					}
				});
				return stream;
			},
		});

		const failoverEvents: ModelFailoverEvent[] = [];
		const modelSelectEvents: ModelSelectEvent[] = [];
		const extensionsResult = await createTestExtensionsResult([
			(pi: ExtensionAPI) => {
				pi.on("model_select", (event) => {
					modelSelectEvents.push(event);
				});
				if (options.withoutHandler) return;
				pi.on("model_failover", (event) => {
					failoverEvents.push({ ...event, triedModels: [...event.triedModels] });
					const replacement = options.failoverResponses?.[event.attempt];
					return replacement ? { model: replacement } : undefined;
				});
			},
		]);

		const sessionManager = SessionManager.inMemory();
		const settingsManager = SettingsManager.create(tempDir, tempDir);
		const authStorage = AuthStorage.create(join(tempDir, "auth.json"));
		const modelRegistry = await createModelRegistry(authStorage, tempDir);
		await authStorage.modify("anthropic", async () => ({ type: "api_key", key: "test-key" }));
		await authStorage.modify("openai", async () => ({ type: "api_key", key: "test-key" }));
		settingsManager.applyOverrides({ retry: { enabled: true, maxRetries, baseDelayMs: 1 } });

		session = new AgentSession({
			agent,
			sessionManager,
			settingsManager,
			cwd: tempDir,
			modelRuntime: getModelRuntime(modelRegistry),
			resourceLoader: createTestResourceLoader({ extensionsResult }),
		});

		const sessionEvents: AgentSessionEvent[] = [];
		session.subscribe((event) => {
			if (event.type === "model_failover" || event.type === "auto_retry_start" || event.type === "auto_retry_end") {
				sessionEvents.push(event);
			}
		});

		return { session, getCallCount: () => callCount, sessionEvents, failoverEvents, modelSelectEvents };
	}

	it("switches to the fallback model before retrying", async () => {
		const created = await createSession({
			failCount: 1,
			failoverResponses: { 1: { provider: "openai", id: "gpt-5-mini" } },
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.model?.provider).toBe("openai");
		expect(created.session.model?.id).toBe("gpt-5-mini");

		expect(created.failoverEvents).toHaveLength(1);
		expect(created.failoverEvents[0]).toMatchObject({
			type: "model_failover",
			attempt: 1,
			maxAttempts: 3,
			errorMessage: "overloaded_error",
			model: { provider: "anthropic", id: "claude-sonnet-4-5" },
			triedModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
		});

		const failoverSelect = created.modelSelectEvents.find((event) => event.source === "failover");
		expect(failoverSelect?.model.id).toBe("gpt-5-mini");
		expect(failoverSelect?.previousModel?.id).toBe("claude-sonnet-4-5");

		// The model switch is announced before the retry starts.
		expect(created.sessionEvents.map((event) => event.type)).toEqual([
			"model_failover",
			"auto_retry_start",
			"auto_retry_end",
		]);
		expect(created.sessionEvents[0]).toMatchObject({
			type: "model_failover",
			from: { provider: "anthropic", id: "claude-sonnet-4-5" },
			to: { provider: "openai", id: "gpt-5-mini" },
			reason: "overloaded_error",
		});
	});

	it("keeps the current model when the handler returns undefined", async () => {
		const created = await createSession({ failCount: 1, failoverResponses: {} });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.model?.id).toBe("claude-sonnet-4-5");
		expect(created.failoverEvents).toHaveLength(1);
		expect(created.modelSelectEvents).toHaveLength(0);
		expect(created.sessionEvents.map((event) => event.type)).toEqual(["auto_retry_start", "auto_retry_end"]);
	});

	it("ignores a fallback model without configured auth", async () => {
		vi.stubEnv("GEMINI_API_KEY", undefined);
		const created = await createSession({
			failCount: 1,
			failoverResponses: { 1: { provider: "google", id: "gemini-2.5-flash" } },
		});

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.model?.id).toBe("claude-sonnet-4-5");
		expect(created.modelSelectEvents).toHaveLength(0);
		expect(created.sessionEvents.map((event) => event.type)).toEqual(["auto_retry_start", "auto_retry_end"]);
	});

	it("ignores a fallback model that is not in the registry", async () => {
		const created = await createSession({
			failCount: 1,
			failoverResponses: { 1: { provider: "openai", id: "does-not-exist" } },
		});

		await created.session.prompt("Test");

		expect(created.session.model?.id).toBe("claude-sonnet-4-5");
		expect(created.modelSelectEvents).toHaveLength(0);
	});

	it("accumulates tried models across retries and resets on a new prompt", async () => {
		const created = await createSession({
			failCount: 99,
			maxRetries: 2,
			failoverResponses: {
				1: { provider: "openai", id: "gpt-5-mini" },
				2: { provider: "openai", id: "gpt-5-nano" },
			},
		});

		await created.session.prompt("Test");

		expect(created.failoverEvents.map((event) => event.triedModels)).toEqual([
			[{ provider: "anthropic", id: "claude-sonnet-4-5" }],
			[
				{ provider: "anthropic", id: "claude-sonnet-4-5" },
				{ provider: "openai", id: "gpt-5-mini" },
			],
		]);

		created.failoverEvents.length = 0;
		await created.session.prompt("Test again");

		expect(created.failoverEvents[0].triedModels).toEqual([{ provider: "openai", id: "gpt-5-nano" }]);
	});

	it("retries unchanged when no extension handles model_failover", async () => {
		const created = await createSession({ failCount: 1, withoutHandler: true });

		await created.session.prompt("Test");

		expect(created.getCallCount()).toBe(2);
		expect(created.session.model?.id).toBe("claude-sonnet-4-5");
		expect(created.failoverEvents).toHaveLength(0);
		expect(created.sessionEvents.map((event) => event.type)).toEqual(["auto_retry_start", "auto_retry_end"]);
	});
});
