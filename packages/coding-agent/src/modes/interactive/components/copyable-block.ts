import { type Component, Container, sliceByColumn, type TUI, visibleWidth } from "@earendil-works/pi-tui";

const COPY_LABEL = "[copy]";
const COPIED_LABEL = "[copied]";
const COPY_RIGHT_PAD = 1;
const COPY_FEEDBACK_MS = 2000;
const DIM_COPY_LABEL = "\x1b[2m[copy]\x1b[0m";
const DIM_COPIED_LABEL = "\x1b[2m[copied]\x1b[0m";
// Columns at the right edge that must be free of text for the label to sit on a line.
// Sized for the widest label ([copied]) plus padding and a one-column gap, and kept
// constant across the copy/copied states so toggling feedback does not move the label.
const COPY_REGION = COPIED_LABEL.length + COPY_RIGHT_PAD + 1;
const MIN_CHILD_WIDTH = 20;

// Matches CSI, OSC, and APC escape sequences (same families extractAnsiCode supports).
const ANSI_SEQUENCE_RE = /\x1b(?:\[[0-9;:?]*[ -/]*[@-~]|[\]_][^\x07\x1b]*(?:\x07|\x1b\\)?)/g;

/** True if the given column range of the line contains visible non-space characters. */
function regionHasText(line: string, start: number, length: number): boolean {
	const region = sliceByColumn(padToWidth(line, start + length), start, length, true);
	return /\S/.test(region.replace(ANSI_SEQUENCE_RE, ""));
}

function padToWidth(line: string, width: number): string {
	const lineWidth = visibleWidth(line);
	return lineWidth >= width ? line : line + " ".repeat(width - lineWidth);
}

function overlayCopyLabel(
	line: string,
	width: number,
	labelStart: number,
	plainLabel: string,
	styledLabel: string,
): string {
	const padded = padToWidth(line, width);
	const before = sliceByColumn(padded, 0, labelStart, true);
	const afterStart = labelStart + plainLabel.length;
	const after = sliceByColumn(padded, afterStart, Math.max(0, width - afterStart), true);
	return `${before}${styledLabel}${after}`;
}

function mouseCopyEnabled(): boolean {
	return process.env.PI_PROMPT_MOUSE === "1";
}

export class CopyableBlockComponent extends Container {
	readonly child: Component;
	private readonly tui: TUI;
	private readonly getCopyText: () => string;

	constructor(child: Component, tui: TUI, getCopyText: () => string) {
		super();
		this.child = child;
		this.tui = tui;
		this.getCopyText = getCopyText;
	}

	private copiedUntil = 0;
	private copiedTimer?: ReturnType<typeof setTimeout>;

	private showCopiedFeedback(): void {
		this.copiedUntil = Date.now() + COPY_FEEDBACK_MS;
		this.tui.requestRender?.();
		if (this.copiedTimer) clearTimeout(this.copiedTimer);
		this.copiedTimer = setTimeout(() => {
			this.copiedUntil = 0;
			this.tui.requestRender?.();
		}, COPY_FEEDBACK_MS);
		this.copiedTimer.unref?.();
	}

	override invalidate(): void {
		this.child.invalidate?.();
	}

	override render(width: number): string[] {
		return this.renderWithBounds(width, 1, 1);
	}

	private renderChild(width: number, rowStart: number, colStart: number): string[] {
		const inheritedContainerBounds =
			this.child instanceof Container &&
			this.child.renderWithBounds === Container.prototype.renderWithBounds &&
			this.child.render !== Container.prototype.render;
		if (this.child.renderWithBounds && !inheritedContainerBounds) {
			return this.child.renderWithBounds(width, rowStart, colStart);
		}
		return this.child.render(width);
	}

	override renderWithBounds(width: number, rowStart = 1, colStart = 1): string[] {
		const lines = this.renderChild(width, rowStart, colStart);
		const text = this.getCopyText()?.trim();
		const copied = Date.now() < this.copiedUntil;
		const plainLabel = copied ? COPIED_LABEL : COPY_LABEL;
		const styledLabel = copied ? DIM_COPIED_LABEL : DIM_COPY_LABEL;
		if (!mouseCopyEnabled() || !text || width - COPY_REGION < MIN_CHILD_WIDTH || lines.length === 0) {
			return lines;
		}
		// Overlay the label on the first visible line (for boxed content this is the top
		// padding row, so the label sits on the box background). If that line has text under
		// the label region, walk up to the nearest earlier blank line; if none is free, skip
		// the label rather than paint over content.
		const regionStart = width - COPY_REGION;
		const firstVisible = Math.max(
			0,
			lines.findIndex((line) => visibleWidth(line) > 0),
		);
		let lineIndex = -1;
		for (let i = firstVisible; i >= 0; i--) {
			if (!regionHasText(lines[i]!, regionStart, COPY_REGION)) {
				lineIndex = i;
				break;
			}
		}
		if (lineIndex === -1) {
			return lines;
		}
		const labelStart = width - plainLabel.length - COPY_RIGHT_PAD;
		// Copy before mutating: some components (e.g. Text) return their internal cache array.
		const result = lines.slice();
		result[lineIndex] = overlayCopyLabel(result[lineIndex]!, width, labelStart, plainLabel, styledLabel);
		this.tui.registerCopyRegion?.({
			bufferRow: rowStart - 1 + lineIndex,
			startCol: labelStart,
			endCol: labelStart + plainLabel.length,
			text,
			onCopy: () => this.showCopiedFeedback(),
		});
		return result;
	}
}
