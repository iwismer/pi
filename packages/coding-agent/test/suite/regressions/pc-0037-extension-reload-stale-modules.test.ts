/**
 * Regression test for pc-0037.
 *
 * Node caches ESM modules by URL. jiti re-transpiles an extension entry on every
 * load, but the entry's `.mjs` (or ESM `.js`) siblings are imported natively, so a
 * reloaded extension kept running the module instances from the previous load:
 *
 *  (a) stale code: the extension called a helper that no longer exists
 *  (b) missing export: a newly added named export was absent, so the reloaded
 *      extension failed to link and did not load at all
 *
 * Reloading must give the extension fresh instances of its own local modules,
 * including modules those modules import (the transitive case).
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clearExtensionCache, loadExtensionsCached } from "../../../src/core/extensions/loader.ts";
import { DefaultResourceLoader } from "../../../src/core/resource-loader.ts";

interface ReloadState {
	value?: string;
	deep?: string;
	extra?: string;
}

function state(): ReloadState {
	const global = globalThis as typeof globalThis & { __extensionReloadTest?: ReloadState };
	return global.__extensionReloadTest ?? {};
}

function resetState(): void {
	delete (globalThis as typeof globalThis & { __extensionReloadTest?: ReloadState }).__extensionReloadTest;
}

const supportsModuleHooks = typeof nodeModule.registerHooks === "function";

describe("extension reload module cache (pc-0037)", () => {
	const roots: string[] = [];

	function fixture(options?: { manifest?: boolean }) {
		const root = join(tmpdir(), `pi-extension-reload-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		const cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		mkdirSync(join(root, "lib"), { recursive: true });
		mkdirSync(join(root, "extensions"), { recursive: true });
		if (options?.manifest !== false) {
			writeFileSync(join(root, "package.json"), JSON.stringify({ name: "reload-fixture", private: true }), "utf-8");
		}
		roots.push(root);
		return { root, cwd };
	}

	beforeEach(() => {
		resetState();
		clearExtensionCache();
	});

	afterEach(() => {
		while (roots.length > 0) {
			const root = roots.pop();
			if (root && existsSync(root)) {
				rmSync(root, { recursive: true, force: true });
			}
		}
		resetState();
		clearExtensionCache();
	});

	it.skipIf(!supportsModuleHooks)("reloads local lib modules the extension imports", async () => {
		const { root, cwd } = fixture();
		const deepPath = join(root, "lib", "deep.mjs");
		const libPath = join(root, "lib", "helper.mjs");
		const extensionPath = join(root, "extensions", "reloading.ts");

		writeFileSync(deepPath, `export const DEEP = "deep-1";\n`, "utf-8");
		writeFileSync(libPath, `export { DEEP } from "./deep.mjs";\nexport const VALUE = "value-1";\n`, "utf-8");
		writeFileSync(
			extensionPath,
			`import { DEEP, VALUE } from "../lib/helper.mjs";

export default function () {
	const state = ((globalThis as any).__extensionReloadTest ??= {});
	state.value = VALUE;
	state.deep = DEEP;
}
`,
			"utf-8",
		);

		const first = await loadExtensionsCached([extensionPath], cwd);
		expect(first.errors).toEqual([]);
		expect(state().value).toBe("value-1");
		expect(state().deep).toBe("deep-1");

		// Change the whole local module graph, and add a named export that only the
		// reloaded extension knows about.
		writeFileSync(deepPath, `export const DEEP = "deep-2";\n`, "utf-8");
		writeFileSync(
			libPath,
			`export { DEEP } from "./deep.mjs";\nexport const VALUE = "value-2";\nexport const EXTRA = "extra-2";\n`,
			"utf-8",
		);
		writeFileSync(
			extensionPath,
			`import { DEEP, EXTRA, VALUE } from "../lib/helper.mjs";

export default function () {
	const state = ((globalThis as any).__extensionReloadTest ??= {});
	state.value = VALUE;
	state.deep = DEEP;
	state.extra = EXTRA;
}
`,
			"utf-8",
		);

		clearExtensionCache();
		const second = await loadExtensionsCached([extensionPath], cwd);

		expect(second.errors).toEqual([]);
		expect(state().value).toBe("value-2");
		expect(state().deep).toBe("deep-2");
		expect(state().extra).toBe("extra-2");
	});

	it.skipIf(!supportsModuleHooks)("reloads libs next to an extension directory without a manifest", async () => {
		const { root, cwd } = fixture({ manifest: false });
		const libPath = join(root, "lib", "helper.mjs");
		const extensionPath = join(root, "extensions", "reloading.ts");

		writeFileSync(libPath, `export const VALUE = "value-1";\n`, "utf-8");
		const extensionSource = `import { VALUE } from "../lib/helper.mjs";

export default function () {
	const state = ((globalThis as any).__extensionReloadTest ??= {});
	state.value = VALUE;
}
`;
		writeFileSync(extensionPath, extensionSource, "utf-8");

		const first = await loadExtensionsCached([extensionPath], cwd);
		expect(first.errors).toEqual([]);
		expect(state().value).toBe("value-1");

		writeFileSync(libPath, `export const VALUE = "value-2";\n`, "utf-8");
		clearExtensionCache();
		const second = await loadExtensionsCached([extensionPath], cwd);

		expect(second.errors).toEqual([]);
		expect(state().value).toBe("value-2");
	});

	it.skipIf(!supportsModuleHooks)("reloads lib modules through a resource loader reload", async () => {
		const { root, cwd } = fixture({ manifest: false });
		const agentDir = join(root, "agent");
		const extensionDir = join(agentDir, "extensions");
		mkdirSync(join(agentDir, "lib"), { recursive: true });
		mkdirSync(extensionDir, { recursive: true });
		const libPath = join(agentDir, "lib", "helper.mjs");
		writeFileSync(libPath, `export const VALUE = "value-1";\n`, "utf-8");
		writeFileSync(
			join(extensionDir, "reloading.ts"),
			`import { VALUE } from "../lib/helper.mjs";

export default function () {
	const state = ((globalThis as any).__extensionReloadTest ??= {});
	state.value = VALUE;
}
`,
			"utf-8",
		);

		const loader = new DefaultResourceLoader({
			cwd,
			agentDir,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});

		await loader.reload();
		expect(state().value).toBe("value-1");

		writeFileSync(libPath, `export const VALUE = "value-2";\n`, "utf-8");
		await loader.reload();

		expect(loader.getExtensions().errors).toEqual([]);
		expect(state().value).toBe("value-2");
	});

	it.skipIf(!supportsModuleHooks)("shares one lib instance across extensions loaded in the same pass", async () => {
		const { root, cwd } = fixture();
		const libPath = join(root, "lib", "counter.mjs");
		const firstPath = join(root, "extensions", "first.ts");
		const secondPath = join(root, "extensions", "second.ts");

		writeFileSync(libPath, `export const counter = { loads: 0 };\ncounter.loads++;\n`, "utf-8");
		const extensionSource = (key: string) =>
			`import { counter } from "../lib/counter.mjs";

export default function () {
	const state = ((globalThis as any).__extensionReloadTest ??= {});
	state.${key} = String(counter.loads);
}
`;
		writeFileSync(firstPath, extensionSource("value"), "utf-8");
		writeFileSync(secondPath, extensionSource("deep"), "utf-8");

		clearExtensionCache();
		const result = await loadExtensionsCached([firstPath, secondPath], cwd);

		expect(result.errors).toEqual([]);
		expect(state().value).toBe("1");
		expect(state().deep).toBe("1");
	});
});
