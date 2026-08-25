/**
 * Generic selector component for extensions.
 * Displays a list of string options with keyboard navigation.
 */

import { type Component, Container, getKeybindings, Spacer, Text, type TUI } from "@earendil-works/pi-tui";
import { theme } from "../theme/theme.ts";
import { CountdownTimer } from "./countdown-timer.ts";
import { DynamicBorder } from "./dynamic-border.ts";
import { keyHint, rawKeyHint } from "./keybinding-hints.ts";

export interface ExtensionSelectorOptions {
	tui?: TUI;
	timeout?: number;
	onToggleToolsExpanded?: () => void;
}

/** Rows the dialog spends on its borders, spacers, and key-hint row. */
const DIALOG_CHROME_LINES = 8;
/** Rows the surrounding fullscreen dock keeps for the transcript, status, and footer. */
const DOCK_RESERVED_LINES = 4;
/**
 * Floor so a very short terminal still shows one title line plus the scroll
 * indicator. Two rows is the smallest useful viewport: one row less renders the
 * indicator alone. Terminals shorter than roughly 16 rows cannot fit the whole
 * dialog even at this floor, so their bottom chrome is still clipped.
 */
const MIN_TITLE_LINES = 2;
const FALLBACK_TERMINAL_ROWS = 24;

/**
 * Title block that never renders taller than the rows it is allowed.
 *
 * In fullscreen mode the dock allocates the dialog a bounded height, and the
 * layout paints only the leading lines of an over-tall component (see
 * `layoutComponent` in packages/tui/src/layout.ts). An unbounded title therefore
 * pushed the option rows and key hints off screen, leaving no way to answer or
 * read the rest of the prompt. Clamping the title to the available rows keeps
 * the options visible and pages the overflow instead.
 */
class ScrollableTitle implements Component {
	private text: Text;
	private getMaxLines: () => number;
	private scrollOffset = 0;
	private visibleLines = 0;
	private totalLines = 0;

	constructor(text: string, getMaxLines: () => number) {
		this.text = new Text(text, 1, 0);
		this.getMaxLines = getMaxLines;
	}

	setText(text: string): void {
		this.text.setText(text);
	}

	invalidate(): void {
		this.text.invalidate();
	}

	/** Lines to move per page, or 0 when the whole title already fits. */
	pageSize(): number {
		return this.totalLines > this.visibleLines ? Math.max(1, this.visibleLines - 1) : 0;
	}

	/** Scrolls the title viewport. Returns true when the offset actually moved. */
	scrollBy(lines: number): boolean {
		const maxOffset = Math.max(0, this.totalLines - this.visibleLines);
		const next = Math.min(maxOffset, Math.max(0, this.scrollOffset + lines));
		if (next === this.scrollOffset) return false;
		this.scrollOffset = next;
		return true;
	}

	render(width: number): string[] {
		const lines = this.text.render(width);
		this.totalLines = lines.length;
		const maxLines = Math.max(MIN_TITLE_LINES, this.getMaxLines());

		if (lines.length <= maxLines) {
			this.visibleLines = lines.length;
			this.scrollOffset = 0;
			return lines;
		}

		// Spend one row of the viewport on the scroll position and its keys.
		this.visibleLines = maxLines - 1;
		this.scrollOffset = Math.min(this.scrollOffset, lines.length - this.visibleLines);
		const start = this.scrollOffset;
		const end = start + this.visibleLines;
		const position = theme.fg("muted", `lines ${start + 1}-${end} of ${lines.length}`);
		const scrollHints = `${keyHint("tui.select.pageUp", "scroll up")}  ${keyHint("tui.select.pageDown", "scroll down")}`;
		return [...lines.slice(start, end), ` ${position}  ${scrollHints}`];
	}
}

export class ExtensionSelectorComponent extends Container {
	private options: string[];
	private selectedIndex = 0;
	private listContainer: Container;
	private onSelectCallback: (option: string) => void;
	private onCancelCallback: () => void;
	private titleText: ScrollableTitle;
	private baseTitle: string;
	private countdown: CountdownTimer | undefined;
	private onToggleToolsExpanded: (() => void) | undefined;
	private tui: TUI | undefined;

	constructor(
		title: string,
		options: string[],
		onSelect: (option: string) => void,
		onCancel: () => void,
		opts?: ExtensionSelectorOptions,
	) {
		super();

		this.options = options;
		this.onSelectCallback = onSelect;
		this.onCancelCallback = onCancel;
		this.onToggleToolsExpanded = opts?.onToggleToolsExpanded;
		this.baseTitle = title;
		this.tui = opts?.tui;

		this.addChild(new DynamicBorder());
		this.addChild(new Spacer(1));

		this.titleText = new ScrollableTitle(theme.fg("accent", theme.bold(title)), () => this.maxTitleLines());
		this.addChild(this.titleText);
		this.addChild(new Spacer(1));

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				(s) => this.titleText.setText(theme.fg("accent", theme.bold(`${this.baseTitle} (${s}s)`))),
				() => this.onCancelCallback(),
			);
		}

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				rawKeyHint("↑↓", "navigate") +
					"  " +
					keyHint("tui.select.confirm", "select") +
					"  " +
					keyHint("tui.select.cancel", "cancel"),
				1,
				0,
			),
		);
		this.addChild(new Spacer(1));
		this.addChild(new DynamicBorder());

		this.updateList();
	}

	/** Rows the title may use before the option rows would be pushed out of view. */
	private maxTitleLines(): number {
		const rows = this.tui?.terminal.rows ?? FALLBACK_TERMINAL_ROWS;
		return rows - this.options.length - DIALOG_CHROME_LINES - DOCK_RESERVED_LINES;
	}

	private updateList(): void {
		this.listContainer.clear();
		for (let i = 0; i < this.options.length; i++) {
			const isSelected = i === this.selectedIndex;
			const text = isSelected
				? theme.fg("accent", "→ ") + theme.fg("accent", this.options[i])
				: `  ${theme.fg("text", this.options[i])}`;
			this.listContainer.addChild(new Text(text, 1, 0));
		}
	}

	handleInput(keyData: string): void {
		const kb = getKeybindings();
		if (kb.matches(keyData, "app.tools.expand")) {
			this.onToggleToolsExpanded?.();
		} else if (kb.matches(keyData, "tui.select.up") || keyData === "k") {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.down") || keyData === "j") {
			this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
			this.updateList();
		} else if (kb.matches(keyData, "tui.select.pageUp")) {
			if (this.titleText.scrollBy(-this.titleText.pageSize())) this.tui?.requestRender();
		} else if (kb.matches(keyData, "tui.select.pageDown")) {
			if (this.titleText.scrollBy(this.titleText.pageSize())) this.tui?.requestRender();
		} else if (kb.matches(keyData, "tui.select.confirm") || keyData === "\n") {
			const selected = this.options[this.selectedIndex];
			if (selected) this.onSelectCallback(selected);
		} else if (kb.matches(keyData, "tui.select.cancel")) {
			this.onCancelCallback();
		}
	}

	dispose(): void {
		this.countdown?.dispose();
	}
}
