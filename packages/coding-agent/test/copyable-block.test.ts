import { Box, Container, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { CopyableBlockComponent } from "../src/modes/interactive/components/copyable-block.ts";

const WIDTH = 60;
const OSC133_ZONE_START = "\x1b]133;A\x07";

function stripAnsi(line: string): string {
	return line.replace(/\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|[\]_][^\x07\x1b]*(?:\x07|\x1b\\))/g, "");
}

function makeTui(): TUI & { lastRegion?: { bufferRow: number; startCol: number; endCol: number; text: string } } {
	const tui = {
		requestRender() {},
		registerCopyRegion(region: { bufferRow: number; startCol: number; endCol: number; text: string }) {
			tui.lastRegion = region;
		},
	} as any;
	return tui;
}

function labelLineIndexes(lines: string[]): number[] {
	const indexes: number[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (stripAnsi(lines[i]!).includes("[copy]")) indexes.push(i);
	}
	return indexes;
}

describe("CopyableBlockComponent label placement", () => {
	let previousMouse: string | undefined;

	beforeEach(() => {
		previousMouse = process.env.PI_PROMPT_MOUSE;
		process.env.PI_PROMPT_MOUSE = "1";
	});

	afterEach(() => {
		if (previousMouse === undefined) delete process.env.PI_PROMPT_MOUSE;
		else process.env.PI_PROMPT_MOUSE = previousMouse;
	});

	test("boxed content: label lands on the top padding row at full width", () => {
		const child = new Container();
		child.addChild(new Spacer(1));
		const box = new Box(1, 1, (t) => `\x1b[42m${t}\x1b[0m`);
		box.addChild(new Text("$ some long command that wraps around and around the box", 0, 0));
		child.addChild(box);

		const block = new CopyableBlockComponent(child, makeTui(), () => "copy text");
		const lines = block.renderWithBounds(WIDTH, 1, 1);

		// Line 0 is the blank spacer; line 1 is the box's top padding row.
		expect(labelLineIndexes(lines)).toEqual([1]);
		// Child rendered at full width: box background spans all columns.
		expect(stripAnsi(lines[1]!)).toHaveLength(WIDTH);
		expect(stripAnsi(lines[1]!).trimEnd().endsWith("[copy]")).toBe(true);
		// Box background is preserved after the label's SGR reset.
		expect(lines[1]!.indexOf("\x1b[42m")).toBeLessThan(lines[1]!.indexOf("[copy]"));
		expect(lines[1]!.slice(lines[1]!.indexOf("[copy]"))).toContain("\x1b[42m");
	});

	test("short first text line: label sits beside the text", () => {
		const child = new Container();
		child.addChild(new Spacer(1));
		child.addChild(new Text("Short reply.", 1, 0));

		const block = new CopyableBlockComponent(child, makeTui(), () => "copy text");
		const lines = block.renderWithBounds(WIDTH, 1, 1);

		expect(labelLineIndexes(lines)).toEqual([1]);
		expect(stripAnsi(lines[1]!)).toContain("Short reply.");
	});

	test("long first text line: label walks up to the blank line above", () => {
		const child = new Container();
		child.addChild(new Spacer(1));
		child.addChild(
			new Text(
				"This is a very long prose line that definitely extends all the way into the label region at the right edge.",
				1,
				0,
			),
		);

		const block = new CopyableBlockComponent(child, makeTui(), () => "copy text");
		const lines = block.renderWithBounds(WIDTH, 1, 1);

		expect(labelLineIndexes(lines)).toEqual([0]);
	});

	test("no free line: label is skipped instead of painting over text", () => {
		const child = new Text("x".repeat(200), 0, 0);

		const block = new CopyableBlockComponent(child, makeTui(), () => "copy text");
		const lines = block.renderWithBounds(WIDTH, 1, 1);

		expect(labelLineIndexes(lines)).toEqual([]);
		// The Text cache array must not have been mutated.
		expect(child.render(WIDTH).some((line) => stripAnsi(line).includes("[copy]"))).toBe(false);
	});

	test("OSC133 prefix on line 0 does not count as text", () => {
		const child = new Container();
		child.addChild(new Spacer(1));
		child.addChild(new Text("hello", 1, 0));

		const block = new CopyableBlockComponent(child, makeTui(), () => "copy text");
		const plain = block.renderWithBounds(WIDTH, 1, 1);
		expect(labelLineIndexes(plain)).toEqual([1]);

		// Simulate a component that prefixes OSC133 zone markers on its first line.
		const prefixed = new Container();
		prefixed.addChild(
			new (class extends Container {
				override renderWithBounds(width: number, rowStart = 1, colStart = 1): string[] {
					const lines = child.renderWithBounds(width, rowStart, colStart).slice();
					lines[0] = OSC133_ZONE_START + lines[0]!;
					return lines;
				}
			})(),
		);
		const block2 = new CopyableBlockComponent(prefixed, makeTui(), () => "copy text");
		const lines = block2.renderWithBounds(WIDTH, 1, 1);
		expect(labelLineIndexes(lines)).toEqual([1]);
	});

	test("registerCopyRegion reports the buffer row of the label line", () => {
		const child = new Container();
		child.addChild(new Spacer(1));
		const box = new Box(1, 1, (t) => `\x1b[42m${t}\x1b[0m`);
		box.addChild(new Text("hello", 0, 0));
		child.addChild(box);

		const tui = makeTui();
		const block = new CopyableBlockComponent(child, tui, () => "copy text");
		block.renderWithBounds(40, 5, 1);

		// rowStart 5 (1-indexed) + lineIndex 1 => 0-indexed buffer row 5.
		expect(tui.lastRegion).toMatchObject({ bufferRow: 5, text: "copy text" });
		expect(tui.lastRegion!.endCol - tui.lastRegion!.startCol).toBe("[copy]".length);
	});

	test("label is not shown when width is too narrow or copy text is empty", () => {
		const child = new Container();
		child.addChild(new Spacer(1));
		child.addChild(new Text("hello", 1, 0));

		const narrow = new CopyableBlockComponent(child, makeTui(), () => "copy text");
		expect(labelLineIndexes(narrow.renderWithBounds(20, 1, 1))).toEqual([]);

		const empty = new CopyableBlockComponent(child, makeTui(), () => "");
		expect(labelLineIndexes(empty.renderWithBounds(WIDTH, 1, 1))).toEqual([]);
	});
});
