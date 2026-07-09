import { type Component, Container, sliceByColumn, type TUI, visibleWidth } from "@earendil-works/pi-tui";

const COPY_LABEL = "[copy]";
const COPIED_LABEL = "[copied]";
const COPY_RIGHT_PAD = 1;
const COPY_FEEDBACK_MS = 2000;
const DIM_COPY_LABEL = "\x1b[2m[copy]\x1b[0m";
const DIM_COPIED_LABEL = "\x1b[2m[copied]\x1b[0m";

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
		if (!mouseCopyEnabled() || !text || width < plainLabel.length + COPY_RIGHT_PAD + 2 || lines.length === 0) {
			return lines;
		}
		const lineIndex = Math.max(
			0,
			lines.findIndex((line) => visibleWidth(line) > 0),
		);
		const labelStart = width - plainLabel.length - COPY_RIGHT_PAD;
		lines[lineIndex] = overlayCopyLabel(lines[lineIndex]!, width, labelStart, plainLabel, styledLabel);
		this.tui.registerCopyRegion?.({
			bufferRow: rowStart - 1 + lineIndex,
			startCol: labelStart,
			endCol: labelStart + plainLabel.length,
			text,
			onCopy: () => this.showCopiedFeedback(),
		});
		return lines;
	}
}
