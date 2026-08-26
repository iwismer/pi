/**
 * Regression test for pc-0057.
 *
 * `pi -p --mode json "prompt"` hung forever when stdin was an open pipe that
 * never carried data and never closed (a harness that spawns pi with
 * `stdio: "pipe"` and keeps the write end open). pi waited for stdin's "end"
 * event before building the initial message, even though the prompt argument
 * already contained everything it needed.
 *
 * With an explicit prompt argument, pi now waits only a short grace period for
 * the first byte. Piped content that starts arriving (`cat file | pi -p "..."`)
 * is still read to completion.
 */
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { readPipedStdin } from "../../../src/cli/piped-stdin.ts";

function createPipe(): PassThrough & { isTTY?: boolean } {
	return new PassThrough();
}

describe("readPipedStdin", () => {
	it("gives up on an open, silent stdin pipe when a prompt argument exists", async () => {
		const stream = createPipe();
		const warn = vi.fn();

		const content = await readPipedStdin({
			stream,
			hasExplicitPrompt: true,
			idleTimeoutMs: 20,
			onIdleTimeout: warn,
		});

		expect(content).toBeUndefined();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(stream.isPaused()).toBe(true);
	});

	it("ignores stdin data that arrives after it gave up", async () => {
		const stream = createPipe();

		const content = await readPipedStdin({
			stream,
			hasExplicitPrompt: true,
			idleTimeoutMs: 20,
			onIdleTimeout: () => {},
		});
		expect(content).toBeUndefined();

		expect(stream.listenerCount("data")).toBe(0);
		expect(stream.listenerCount("end")).toBe(0);
		stream.write("late data");
		stream.end();
		await new Promise((resolve) => setTimeout(resolve, 20));
	});

	it("handles a stdin stream error without crashing", async () => {
		const stream = createPipe();
		const pending = readPipedStdin({
			stream,
			hasExplicitPrompt: true,
			idleTimeoutMs: 100,
		});

		stream.emit("error", new Error("stdin failed"));
		expect(await pending).toBeUndefined();
	});

	it("reads piped content to completion once the first chunk arrives", async () => {
		const stream = createPipe();
		const warn = vi.fn();

		const pending = readPipedStdin({
			stream,
			hasExplicitPrompt: true,
			idleTimeoutMs: 20,
			onIdleTimeout: warn,
		});

		stream.write("first chunk\n");
		setTimeout(() => {
			stream.write("second chunk\n");
			stream.end();
		}, 60);

		expect(await pending).toBe("first chunk\nsecond chunk");
		expect(warn).not.toHaveBeenCalled();
	});

	it("keeps waiting for stdin when there is no prompt argument", async () => {
		const stream = createPipe();
		let settled = false;
		const pending = readPipedStdin({
			stream,
			hasExplicitPrompt: false,
			idleTimeoutMs: 20,
			onIdleTimeout: () => {},
		}).then((value) => {
			settled = true;
			return value;
		});

		await new Promise((resolve) => setTimeout(resolve, 60));
		expect(settled).toBe(false);

		stream.end("piped prompt\n");
		expect(await pending).toBe("piped prompt");
	});

	it("returns undefined for a TTY stdin", async () => {
		const stream = createPipe();
		stream.isTTY = true;

		expect(await readPipedStdin({ stream, hasExplicitPrompt: true })).toBeUndefined();
	});
});
