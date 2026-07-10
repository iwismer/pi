import assert from "node:assert";
import { describe, it } from "node:test";
import { type Component, CURSOR_MARKER, TUI } from "../src/tui.ts";
import { VirtualTerminal } from "./virtual-terminal.ts";

class TestComponent implements Component {
	lines: string[] = [];
	renderCount = 0;
	render(_width: number): string[] {
		this.renderCount += 1;
		return this.lines;
	}
	invalidate(): void {}
}

class LoggingVirtualTerminal extends VirtualTerminal {
	private writes: string[] = [];

	override write(data: string): void {
		this.writes.push(data);
		super.write(data);
	}

	getWrites(): string {
		return this.writes.join("");
	}

	clearWrites(): void {
		this.writes = [];
	}
}

type TuiInternals = {
	doRender(): void;
	handleInput(data: string): void;
	previousLines: string[];
	appViewportTop: number | null;
	lastRenderUsedAppViewport: boolean;
	hardwareCursorRow: number;
	copyRegions: { bufferRow: number; text: string }[];
};

const WHEEL_UP = "\x1b[<64;1;1M";
const WHEEL_DOWN = "\x1b[<65;1;1M";

function makeScrolledTui(lineCount = 30, columns = 40, rows = 5) {
	const terminal = new LoggingVirtualTerminal(columns, rows);
	const tui = new TUI(terminal);
	const internals = tui as unknown as TuiInternals;
	const component = new TestComponent();
	component.lines = Array.from({ length: lineCount }, (_, index) => `line ${index + 1}`);
	tui.addChild(component);
	internals.doRender();
	return { terminal, tui, internals, component };
}

describe("TUI app viewport scrolling", () => {
	it("shows the scrolled slice with a scrollbar column after a wheel-up tick", async () => {
		const { terminal, internals } = makeScrolledTui();

		internals.handleInput(WHEEL_UP);
		internals.doRender();

		// 30 lines, height 5: maxTop=25, one wheel tick of 3 => top at buffer row 22
		assert.equal(internals.appViewportTop, 22);
		const viewport = await terminal.flushAndGetViewport();
		assert.match(viewport[0] ?? "", /^line 23\s+[│█]$/, "first visible row should be buffer row 22 plus scrollbar");
		assert.match(viewport[4] ?? "", /^line 27\s+[│█]$/, "last visible row should be buffer row 26 plus scrollbar");
	});

	it("does not re-render components on scroll-only ticks", () => {
		const { internals, component } = makeScrolledTui();
		const rendersAfterInitial = component.renderCount;

		internals.handleInput(WHEEL_UP);
		internals.doRender();
		internals.handleInput(WHEEL_UP);
		internals.doRender();

		assert.equal(internals.appViewportTop, 19, "two wheel ticks should scroll 6 rows");
		assert.equal(
			component.renderCount,
			rendersAfterInitial,
			"scroll-only repaints must reuse the cached buffer instead of re-rendering components",
		);
		assert.equal(internals.previousLines.length, 5, "viewport repaint tracks only the visible slice");
	});

	it("never writes a full-screen clear (2J) for scroll ticks or return-to-bottom", async () => {
		const { terminal, internals } = makeScrolledTui();
		terminal.clearWrites();

		internals.handleInput(WHEEL_UP);
		internals.doRender();
		internals.handleInput(WHEEL_DOWN);
		internals.doRender();

		assert.doesNotMatch(terminal.getWrites(), /\x1b\[2J/, "wheel scrolling must not clear the whole screen");
		assert.equal(internals.appViewportTop, null, "wheel-down from one tick up returns to follow-bottom");
		assert.equal(internals.lastRenderUsedAppViewport, false);
		const viewport = await terminal.flushAndGetViewport();
		assert.equal(viewport[0], "line 26", "bottom slice restored without scrollbar column");
		assert.equal(viewport[4], "line 30");
	});

	it("repaints fresh content when a component changes while scrolled up", async () => {
		const { terminal, tui, internals, component } = makeScrolledTui();

		internals.handleInput(WHEEL_UP);
		internals.doRender();
		const rendersBeforeChange = component.renderCount;

		component.lines[22] = "updated content";
		tui.requestRender();
		internals.doRender();

		assert.ok(component.renderCount > rendersBeforeChange, "content-dirty render must re-render components");
		const viewport = await terminal.flushAndGetViewport();
		assert.match(viewport[0] ?? "", /^updated content\s+[│█]$/, "changed line is visible while scrolled");
	});

	it("resumes differential bottom rendering after returning from a scroll", async () => {
		const { terminal, tui, internals, component } = makeScrolledTui();

		internals.handleInput(WHEEL_UP);
		internals.doRender();
		internals.handleInput(WHEEL_DOWN);
		internals.doRender();

		component.lines.push("line 31");
		tui.requestRender();
		internals.doRender();

		const viewport = await terminal.flushAndGetViewport();
		assert.equal(viewport[4], "line 31", "appended line reaches the bottom of the screen");
		assert.equal(internals.previousLines.length, 31, "differential renderer tracks the full buffer again");
	});

	it("strips cursor markers outside the extraction window instead of leaking them on scroll", async () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const internals = tui as unknown as TuiInternals;
		const component = new TestComponent();
		component.lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
		// Marker far above the initial bottom extraction window
		component.lines[0] = `top prompt ${CURSOR_MARKER}text`;
		tui.addChild(component);
		internals.doRender();

		terminal.clearWrites();
		for (let i = 0; i < 10; i++) {
			internals.handleInput(WHEEL_UP);
			internals.doRender();
		}

		assert.equal(internals.appViewportTop, 0, "scrolled all the way to the top");
		assert.doesNotMatch(terminal.getWrites(), /_pi:c/, "raw cursor marker must never reach the terminal");
		const viewport = await terminal.flushAndGetViewport();
		assert.match(viewport[0] ?? "", /^top prompt text\s+[│█]$/, "marker is stripped from the visible line");
	});

	it("keeps copy regions registered across scroll-only repaints", () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui = new TUI(terminal);
		const internals = tui as unknown as TuiInternals;
		const component = new TestComponent();
		component.lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
		const baseRender = component.render.bind(component);
		component.render = (width: number) => {
			tui.registerCopyRegion({ bufferRow: 5, startCol: 0, endCol: 6, text: "line 6" });
			return baseRender(width);
		};
		tui.addChild(component);
		internals.doRender();
		assert.equal(internals.copyRegions.length, 1, "region registered during the full render");

		internals.handleInput(WHEEL_UP);
		internals.doRender();

		assert.equal(internals.copyRegions.length, 1, "fast-path scroll must not clear copy regions");
		assert.equal(internals.copyRegions[0]?.bufferRow, 5);
	});

	it("applies the sticky overscroll clamp when content shrinks while scrolled", async () => {
		const { terminal, tui, internals, component } = makeScrolledTui();
		for (let i = 0; i < 3; i++) {
			internals.handleInput(WHEEL_UP);
			internals.doRender();
		}
		assert.equal(internals.appViewportTop, 16);

		// Shrink to 18 lines: maxTop becomes 13, sticky clamp allows staying at 15
		component.lines = component.lines.slice(0, 18);
		tui.requestRender();
		internals.doRender();
		assert.equal(internals.appViewportTop, 15, "shrink clamps to sticky top instead of snapping to maxTop");
		let viewport = await terminal.flushAndGetViewport();
		assert.match(viewport[0] ?? "", /^line 16\s+[│█]$/);
		assert.match(viewport[3] ?? "", /^\s+[│█]$/, "rows past shrunken content stay blank");

		const rendersAfterShrink = component.renderCount;
		internals.handleInput(WHEEL_UP);
		internals.doRender();
		assert.equal(internals.appViewportTop, 12);
		assert.equal(component.renderCount, rendersAfterShrink, "overscrolled wheel tick still uses the fast path");
		viewport = await terminal.flushAndGetViewport();
		assert.match(viewport[0] ?? "", /^line 13\s+[│█]$/);
	});

	it("restores the hardware cursor from the cache on fast return-to-bottom", async () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui = new TUI(terminal, true);
		const internals = tui as unknown as TuiInternals;
		const component = new TestComponent();
		component.lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
		component.lines[29] = `prompt ${CURSOR_MARKER}`;
		tui.addChild(component);
		internals.doRender();

		internals.handleInput(WHEEL_UP);
		internals.doRender();
		internals.handleInput(WHEEL_DOWN);
		internals.doRender();

		await terminal.flush();
		assert.deepEqual(
			terminal.getCursorPosition(),
			{ x: 7, y: 4 },
			"cursor returns to the marker position on the bottom screen row",
		);
	});

	it("ignores a cached cursor position above the bottom slice on return-to-bottom", () => {
		const terminal = new LoggingVirtualTerminal(40, 5);
		const tui = new TUI(terminal, true);
		const internals = tui as unknown as TuiInternals;
		const component = new TestComponent();
		component.lines = Array.from({ length: 30 }, (_, index) => `line ${index + 1}`);
		// Marker far above the bottom extraction window: cached via global strip
		component.lines[0] = `top ${CURSOR_MARKER}rest`;
		tui.addChild(component);
		internals.doRender();

		internals.handleInput(WHEEL_UP);
		internals.doRender();
		internals.handleInput(WHEEL_DOWN);
		internals.doRender();

		assert.equal(internals.appViewportTop, null);
		assert.equal(
			internals.hardwareCursorRow,
			29,
			"cursor bookkeeping must not follow a cached position above the visible slice",
		);
	});

	it("honors PI_WHEEL_SCROLL_LINES for the wheel step", () => {
		const previous = process.env.PI_WHEEL_SCROLL_LINES;
		process.env.PI_WHEEL_SCROLL_LINES = "10";
		try {
			const { internals } = makeScrolledTui();
			internals.handleInput(WHEEL_UP);
			internals.doRender();
			assert.equal(internals.appViewportTop, 15, "one wheel tick should scroll 10 rows (maxTop 25 - 10)");
		} finally {
			if (previous === undefined) {
				delete process.env.PI_WHEEL_SCROLL_LINES;
			} else {
				process.env.PI_WHEEL_SCROLL_LINES = previous;
			}
		}
	});

	it("falls back to the default wheel step for invalid PI_WHEEL_SCROLL_LINES values", () => {
		const previous = process.env.PI_WHEEL_SCROLL_LINES;
		try {
			for (const invalid of ["0", "101", "abc", "-3"]) {
				process.env.PI_WHEEL_SCROLL_LINES = invalid;
				const { internals } = makeScrolledTui();
				internals.handleInput(WHEEL_UP);
				internals.doRender();
				assert.equal(internals.appViewportTop, 22, `value ${JSON.stringify(invalid)} should fall back to step 3`);
			}
		} finally {
			if (previous === undefined) {
				delete process.env.PI_WHEEL_SCROLL_LINES;
			} else {
				process.env.PI_WHEEL_SCROLL_LINES = previous;
			}
		}
	});
});
