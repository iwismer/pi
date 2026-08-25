/**
 * Fresh module instances for reloaded extensions.
 *
 * Node caches ESM modules by URL. jiti re-transpiles an extension entry on every
 * load, but any `.mjs` (or ESM `.js`) module that entry imports is handed to Node's
 * native loader, so `/reload` kept serving the instances from the previous load.
 * Two failure modes were observed: a reloaded extension called a helper that no
 * longer existed ("x is not a function"), and a newly added named export was
 * missing from the cached module, so the extension failed to link and did not load
 * at all.
 *
 * Fix: once the extension cache has been cleared at least once, resolve
 * extension-owned modules to a URL carrying a `?piExtensionReload=<generation>`
 * query. The generation only changes when the cache is cleared, so all extensions
 * in one load pass still share a single instance of a common lib, while the next
 * reload gets a completely fresh graph.
 *
 * The rewrite is transitive: a module resolved with the marker becomes the
 * `parentURL` of its own imports, and those are rewritten too. Busting only the
 * entry URL would not reload its unchanged-URL lib imports.
 *
 * Limitations:
 * - Requires `module.registerHooks()` (Node >= 22.15). Where it is missing (for
 *   example the Bun binary), reload behavior is unchanged and stale lib modules can
 *   still be served.
 * - Modules under `node_modules` and under pi's own package are deliberately never
 *   re-instantiated: extensions must keep sharing those instances with the host.
 * - Superseded instances stay in Node's module registry, so every reload keeps the
 *   previous generation of extension modules alive.
 */

import { existsSync, realpathSync } from "node:fs";
import * as nodeModule from "node:module";
import { homedir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Query parameter that makes a reloaded extension module a distinct Node module. */
const RELOAD_QUERY_KEY = "piExtensionReload";

/** How far above an extension file to look for the package root that owns its libs. */
const MAX_SCOPE_ROOT_DEPTH = 5;

/** How far above this file to look for pi's own package root. */
const MAX_PI_ROOT_DEPTH = 6;

/** Directories whose files belong to extensions and may be re-instantiated. */
const scopeRoots = new Set<string>();

/** Current generation token; empty until the extension cache is cleared once. */
let generationToken = "";

let hooks: nodeModule.ModuleHooks | undefined;

let piPackageRoot: string | null | undefined;

function findPackageRoot(startDir: string, maxDepth: number): string | undefined {
	const stopAt = homedir();
	let current = startDir;
	for (let depth = 0; depth < maxDepth; depth++) {
		if (existsSync(path.join(current, "package.json"))) return current;
		if (path.basename(current) === "node_modules" || current === stopAt) return undefined;
		const parent = path.dirname(current);
		if (parent === current) return undefined;
		current = parent;
	}
	return undefined;
}

/** pi's own package directory; its modules are shared with extensions and never reloaded. */
function getPiPackageRoot(): string | null {
	if (piPackageRoot !== undefined) return piPackageRoot;
	try {
		const here = path.dirname(fileURLToPath(import.meta.url));
		piPackageRoot = findPackageRoot(here, MAX_PI_ROOT_DEPTH) ?? null;
	} catch {
		piPackageRoot = null;
	}
	return piPackageRoot;
}

function isUnder(child: string, parent: string): boolean {
	const relative = path.relative(parent, child);
	return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function addScopeRoot(dir: string): void {
	scopeRoots.add(dir);
	try {
		scopeRoots.add(realpathSync(dir));
	} catch {
		// Directory may have been removed; the literal path is still useful.
	}
}

function addScopeRootForEntry(entryPath: string): void {
	const dir = path.dirname(entryPath);
	const packageRoot = findPackageRoot(dir, MAX_SCOPE_ROOT_DEPTH);
	if (packageRoot) {
		addScopeRoot(packageRoot);
		return;
	}
	addScopeRoot(path.basename(dir) === "extensions" ? path.dirname(dir) : dir);
}

/**
 * Remember which directory owns an extension's local modules.
 *
 * Extensions ship as `<package>/extensions/foo.ts` importing `<package>/lib/*.mjs`,
 * so the scope is the nearest package root, falling back to the extension directory
 * (or its parent when the extension sits in an `extensions/` directory). Symlinked
 * entries are registered for both the link and its target, because Node resolves
 * imports against the real path.
 */
export function registerExtensionModuleScope(extensionEntryPath: string): void {
	const entryPath = path.resolve(extensionEntryPath);
	let realEntryPath: string;
	try {
		realEntryPath = realpathSync(entryPath);
	} catch {
		// Pseudo path (for example "<inline>") or missing file: it owns no modules.
		return;
	}
	addScopeRootForEntry(entryPath);
	if (realEntryPath !== entryPath) addScopeRootForEntry(realEntryPath);
}

/** Modules shared with the host must keep their identity across reloads. */
function isReloadable(filePath: string): boolean {
	if (filePath.split(path.sep).includes("node_modules")) return false;
	const piRoot = getPiPackageRoot();
	return !(piRoot && isUnder(filePath, piRoot));
}

function isInExtensionScope(filePath: string): boolean {
	for (const root of scopeRoots) {
		if (isUnder(filePath, root)) return true;
	}
	return false;
}

function rewriteResolvedUrl(url: string, parentURL: string | undefined): string | undefined {
	if (!generationToken) return undefined;
	if (!url.startsWith("file:")) return undefined;
	if (url.includes(`${RELOAD_QUERY_KEY}=`)) return undefined;

	let filePath: string;
	try {
		filePath = fileURLToPath(url);
	} catch {
		return undefined;
	}

	if (!isReloadable(filePath)) return undefined;

	// A module that was itself reloaded must not link against cached imports, even
	// when it reaches outside the extension's own directory.
	const parentWasReloaded = parentURL?.includes(`${RELOAD_QUERY_KEY}=`) ?? false;
	if (!parentWasReloaded && !isInExtensionScope(filePath)) return undefined;

	return `${url}${url.includes("?") ? "&" : "?"}${RELOAD_QUERY_KEY}=${generationToken}`;
}

function ensureHooksRegistered(): void {
	if (hooks) return;
	if (typeof nodeModule.registerHooks !== "function") return;
	hooks = nodeModule.registerHooks({
		resolve(specifier, context, nextResolve) {
			const resolved = nextResolve(specifier, context);
			const url = rewriteResolvedUrl(resolved.url, context.parentURL);
			return url === undefined ? resolved : { ...resolved, url, shortCircuit: true };
		},
	});
}

/**
 * Point extension module resolution at a new generation.
 *
 * Called whenever the extension cache is cleared (reload, cwd change). Generation 0
 * is the initial load: it resolves modules normally so a session that never reloads
 * behaves exactly as before.
 */
export function setExtensionModuleGeneration(generation: number): void {
	if (generation <= 0) {
		generationToken = "";
		return;
	}
	generationToken = String(generation);
	ensureHooksRegistered();
}
