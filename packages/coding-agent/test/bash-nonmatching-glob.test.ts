/**
 * Regression test for pc-0022.
 *
 * zsh aborts an entire command line when a glob matches nothing (its default
 * `nomatch` option). `grep -n foo /nonexistent/*.md` or
 * `grep -rn foo dir --include=*.ts` therefore never ran, and the model saw
 * "(eval):1: no matches found: ..." instead of the real command result, which
 * reads like "the search found nothing".
 *
 * The bash tool must keep bash's behavior (unmatched patterns are passed through
 * literally) regardless of which shell `shellPath` points at.
 */
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createBashTool } from "../src/core/tools/bash.ts";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

function findZsh(): string | undefined {
	return ["/bin/zsh", "/usr/bin/zsh", "/usr/local/bin/zsh"].find((candidate) => existsSync(candidate));
}

const zshPath = process.platform === "win32" ? undefined : findZsh();
const roots: string[] = [];

function fixtureDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "pi-glob-nomatch-"));
	roots.push(dir);
	return dir;
}

async function runCommand(command: string, options?: { shellPath?: string }): Promise<string> {
	const cwd = fixtureDir();
	const tool = createBashTool(cwd, options);
	const result = await tool.execute("glob-nomatch-test", { command });
	return getTextOutput(result as { content: Array<{ type: string; text?: string }> });
}

describe("bash tool with non-matching globs (pc-0022)", () => {
	afterAll(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root) rmSync(root, { recursive: true, force: true });
		}
	});

	it("runs the command when a path glob matches nothing", async () => {
		const output = await runCommand('grep -n model /nonexistent-dir/*.md 2>/dev/null; echo "RAN=$?"');
		expect(output).not.toContain("no matches found");
		expect(output).toContain("RAN=2");
	});

	it("runs the command when an option value looks like a glob", async () => {
		const output = await runCommand('grep -rln needle . --include=*.nomatchext 2>/dev/null; echo "RAN=$?"');
		expect(output).not.toContain("no matches found");
		expect(output).toContain("RAN=1");
	});

	it.skipIf(!zshPath)("runs the command when the configured shell is zsh", async () => {
		const output = await runCommand('grep -n model /nonexistent-dir/*.md 2>/dev/null; echo "RAN=$?"', {
			shellPath: zshPath,
		});
		expect(output).not.toContain("no matches found");
		expect(output).toContain("RAN=2");
	});

	it.skipIf(!zshPath)("runs the command when shellPath is a zsh wrapper script", async () => {
		const dir = fixtureDir();
		const wrapper = join(dir, "zsh-wrapper");
		writeFileSync(
			wrapper,
			`#!${zshPath}\nif [[ "$1" == "-c" ]]; then\n  shift\nfi\n_cmd="$1"\nshift || true\neval "$_cmd"\n`,
			"utf-8",
		);
		chmodSync(wrapper, 0o755);

		const output = await runCommand('grep -rln needle . --include=*.nomatchext 2>/dev/null; echo "RAN=$?"', {
			shellPath: wrapper,
		});
		expect(output).not.toContain("no matches found");
		expect(output).toContain("RAN=1");
	});

	it("still reports the real command result", async () => {
		const dir = fixtureDir();
		writeFileSync(join(dir, "hit.md"), "model: sonnet\n", "utf-8");
		const tool = createBashTool(dir, zshPath ? { shellPath: zshPath } : undefined);
		const result = await tool.execute("glob-nomatch-test", { command: "grep -n model ./*.md" });
		const output = getTextOutput(result as { content: Array<{ type: string; text?: string }> });
		expect(output).toContain("model: sonnet");
	});
});
