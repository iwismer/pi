/**
 * Regression test for pc-0073 / pc-0081 / pc-0106 (three duplicate reports).
 *
 * The bash tool schema had no `cwd` parameter, and a `cwd` passed anyway was
 * silently dropped: the command ran in the session cwd instead. Commands aimed
 * at another worktree therefore failed in ways that looked like real build or
 * test failures in that worktree.
 *
 * `cwd` is now part of the schema and resolved against the session cwd. Local
 * execution validates that the resolved path is an existing directory before
 * spawning; custom (possibly remote) operations do their own validation.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { type BashOperations, createBashTool, createLocalShellOperations } from "../src/core/tools/bash.ts";
import { createPowerShellToolDefinition } from "../src/core/tools/powershell.ts";

function getTextOutput(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content
		.filter((content) => content.type === "text")
		.map((content) => content.text ?? "")
		.join("\n");
}

const roots: string[] = [];

function fixtureDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-bash-cwd-")));
	roots.push(dir);
	return dir;
}

async function run(
	sessionCwd: string,
	args: { command: string; cwd?: string },
): Promise<{ ok: boolean; output: string }> {
	const tool = createBashTool(sessionCwd);
	try {
		const result = await tool.execute("bash-cwd-test", args);
		return { ok: true, output: getTextOutput(result as { content: Array<{ type: string; text?: string }> }) };
	} catch (err) {
		return { ok: false, output: err instanceof Error ? err.message : String(err) };
	}
}

describe("bash tool cwd parameter (pc-0073, pc-0081, pc-0106)", () => {
	afterAll(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root) rmSync(root, { recursive: true, force: true });
		}
	});

	it("exposes cwd as an optional string parameter", () => {
		const tool = createBashTool(fixtureDir());
		const schema = tool.parameters as {
			properties: Record<string, { type?: string }>;
			required?: string[];
		};
		expect(schema.properties.cwd).toBeDefined();
		expect(schema.properties.cwd.type).toBe("string");
		expect(schema.required ?? []).not.toContain("cwd");
	});

	it("runs the command in an absolute cwd instead of the session cwd", async () => {
		const sessionCwd = fixtureDir();
		const otherCwd = fixtureDir();
		writeFileSync(join(otherCwd, "marker.txt"), "other\n", "utf-8");

		const result = await run(sessionCwd, { command: "pwd && ls", cwd: otherCwd });
		expect(result.ok).toBe(true);
		expect(result.output).toContain(otherCwd);
		expect(result.output).toContain("marker.txt");
		expect(result.output).not.toContain(sessionCwd);
	});

	it("resolves a relative cwd against the session cwd", async () => {
		const sessionCwd = fixtureDir();
		const nested = join(sessionCwd, "nested", "deeper");
		mkdirSync(nested, { recursive: true });

		const result = await run(sessionCwd, { command: "pwd", cwd: "nested/deeper" });
		expect(result.ok).toBe(true);
		expect(result.output.trim()).toBe(nested);
	});

	it("defaults to the session cwd when cwd is omitted", async () => {
		const sessionCwd = fixtureDir();
		const result = await run(sessionCwd, { command: "pwd" });
		expect(result.ok).toBe(true);
		expect(result.output.trim()).toBe(sessionCwd);
	});

	it("falls back to the session cwd when cwd is blank", async () => {
		const sessionCwd = fixtureDir();
		const result = await run(sessionCwd, { command: "pwd", cwd: "   " });
		expect(result.ok).toBe(true);
		expect(result.output.trim()).toBe(sessionCwd);
	});

	it("fails with a clear error when cwd does not exist", async () => {
		const sessionCwd = fixtureDir();
		const missing = join(sessionCwd, "no-such-worktree");

		const result = await run(sessionCwd, { command: "pwd", cwd: "no-such-worktree" });
		expect(result.ok).toBe(false);
		expect(result.output).toContain("cwd");
		expect(result.output).toContain(missing);
		expect(result.output).toContain("not an existing directory");
	});

	it("fails with a clear error when cwd is a file", async () => {
		const sessionCwd = fixtureDir();
		const file = join(sessionCwd, "not-a-dir.txt");
		writeFileSync(file, "x\n", "utf-8");

		const result = await run(sessionCwd, { command: "pwd", cwd: "not-a-dir.txt" });
		expect(result.ok).toBe(false);
		expect(result.output).toContain(file);
		expect(result.output).toContain("not an existing directory");
	});

	it("expands a leading ~ to the home directory", async () => {
		const sessionCwd = fixtureDir();
		const result = await run(sessionCwd, { command: "pwd", cwd: "~" });
		expect(result.ok).toBe(true);
		expect(realpathSync(result.output.trim())).toBe(realpathSync(homedir()));
	});

	it("treats a leading @ as part of the directory name", async () => {
		const sessionCwd = fixtureDir();
		const atDir = join(sessionCwd, "@types");
		mkdirSync(atDir);

		const result = await run(sessionCwd, { command: "pwd", cwd: "@types" });
		expect(result.ok).toBe(true);
		expect(result.output.trim()).toBe(atDir);
	});

	it("accepts a symlinked directory", async () => {
		const sessionCwd = fixtureDir();
		const target = join(sessionCwd, "real");
		mkdirSync(target);
		writeFileSync(join(target, "marker.txt"), "real\n", "utf-8");
		symlinkSync(target, join(sessionCwd, "link"));

		const result = await run(sessionCwd, { command: "ls", cwd: "link" });
		expect(result.ok).toBe(true);
		expect(result.output).toContain("marker.txt");
	});

	// Custom BashOperations may execute remotely (see examples/extensions/ssh.ts), where the
	// resolved cwd only has to exist on the far side. The tool must not check it locally.
	it("does not check cwd locally when custom operations are supplied", async () => {
		const sessionCwd = fixtureDir();
		const seen: string[] = [];
		const operations: BashOperations = {
			exec: async (_command, execCwd) => {
				seen.push(execCwd);
				return { exitCode: 0 };
			},
		};
		const tool = createBashTool(sessionCwd, { operations });

		await tool.execute("bash-cwd-remote", { command: "pwd", cwd: "/remote/only/path" });
		expect(seen).toEqual(["/remote/only/path"]);
	});

	it("exposes cwd on the PowerShell tool too", () => {
		const definition = createPowerShellToolDefinition(fixtureDir());
		const properties = (definition.parameters as unknown as { properties: Record<string, { type?: string }> })
			.properties;
		expect(properties.cwd?.type).toBe("string");
	});

	// The shared local-execution path (bash and PowerShell) owns cwd validation.
	it("reports a missing cwd from local shell operations with the shell name", async () => {
		const missing = join(fixtureDir(), "no-such-dir");
		const operations = createLocalShellOperations("PowerShell", () => ({ shell: "pwsh", args: ["-Command"] }));

		await expect(operations.exec("pwd", missing, { onData: () => {} })).rejects.toThrow(
			`Invalid cwd: "${missing}" is not an existing directory\nCannot execute PowerShell commands.`,
		);
	});
});
