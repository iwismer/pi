import { setKeybindings, type TUI } from "@earendil-works/pi-tui";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { ExtensionSelectorComponent } from "../src/modes/interactive/components/extension-selector.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const TERMINAL_ROWS = 24;
/** Rows the fullscreen dock keeps for the transcript, status, and footer. */
const DOCK_RESERVED_LINES = 4;
const OPTIONS = ["Deny", "Allow command"];

function fakeTui(rows: number = TERMINAL_ROWS): { tui: TUI; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	const tui = { terminal: { rows, columns: 80 }, requestRender } as unknown as TUI;
	return { tui, requestRender };
}

function longTitle(lines: number): string {
	return ["Dangerous command:", ""]
		.concat(Array.from({ length: lines }, (_, index) => `  | step-${index + 1} --flag`))
		.join("\n");
}

describe("ExtensionSelectorComponent with a tall title", () => {
	beforeAll(() => {
		initTheme("dark");
	});

	beforeEach(() => {
		setKeybindings(new KeybindingsManager());
	});

	it("keeps the options and key hints visible within the terminal height", () => {
		const { tui } = fakeTui();
		const selector = new ExtensionSelectorComponent(
			longTitle(200),
			OPTIONS,
			() => {},
			() => {},
			{ tui },
		);

		const lines = selector.render(80);
		const output = stripAnsi(lines.join("\n"));

		// Must also leave the dock its rows, or the fullscreen layout clips the
		// bottom of the dialog and the options disappear again.
		expect(lines.length).toBeLessThanOrEqual(TERMINAL_ROWS - DOCK_RESERVED_LINES);
		for (const option of OPTIONS) expect(output).toContain(option);
		expect(output).toContain("navigate");
		expect(output).toContain("of 202");
	});

	it("still shows the options and a title line on a short terminal", () => {
		const { tui } = fakeTui(16);
		const selector = new ExtensionSelectorComponent(
			longTitle(200),
			OPTIONS,
			() => {},
			() => {},
			{ tui },
		);

		const lines = selector.render(80);
		const output = stripAnsi(lines.join("\n"));

		expect(lines.length).toBeLessThanOrEqual(16 - DOCK_RESERVED_LINES);
		expect(output).toContain("Dangerous command:");
		for (const option of OPTIONS) expect(output).toContain(option);
	});

	it("pages through the title without losing the options", () => {
		const { tui, requestRender } = fakeTui();
		const selector = new ExtensionSelectorComponent(
			longTitle(200),
			OPTIONS,
			() => {},
			() => {},
			{ tui },
		);

		selector.render(80);
		const firstPage = stripAnsi(selector.render(80).join("\n"));
		expect(firstPage).toContain("step-1 ");

		selector.handleInput("\x1b[6~"); // pageDown
		expect(requestRender).toHaveBeenCalled();

		const secondPage = stripAnsi(selector.render(80).join("\n"));
		expect(secondPage).not.toContain("step-1 ");
		for (const option of OPTIONS) expect(secondPage).toContain(option);
	});

	it("scrolls back to the top and stops there", () => {
		const { tui } = fakeTui();
		const selector = new ExtensionSelectorComponent(
			longTitle(200),
			OPTIONS,
			() => {},
			() => {},
			{ tui },
		);

		selector.render(80);
		selector.handleInput("\x1b[6~"); // pageDown
		selector.render(80);
		selector.handleInput("\x1b[5~"); // pageUp
		selector.handleInput("\x1b[5~"); // pageUp again, already at the top
		const output = stripAnsi(selector.render(80).join("\n"));

		expect(output).toContain("lines 1-");
	});

	it("leaves a short title unclamped and unscrolled", () => {
		const { tui } = fakeTui();
		const selector = new ExtensionSelectorComponent(
			"Pick one",
			OPTIONS,
			() => {},
			() => {},
			{ tui },
		);

		const output = stripAnsi(selector.render(80).join("\n"));

		expect(output).toContain("Pick one");
		expect(output).not.toContain("scroll up");
		for (const option of OPTIONS) expect(output).toContain(option);
	});

	it("selects the highlighted option after scrolling the title", () => {
		const onSelect = vi.fn();
		const { tui } = fakeTui();
		const selector = new ExtensionSelectorComponent(longTitle(200), OPTIONS, onSelect, () => {}, { tui });

		selector.render(80);
		selector.handleInput("\x1b[6~"); // pageDown scrolls the title, not the selection
		selector.handleInput("\r");

		expect(onSelect).toHaveBeenCalledWith("Deny");
	});
});
