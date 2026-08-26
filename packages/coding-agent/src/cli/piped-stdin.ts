import type { Readable } from "node:stream";

/**
 * Grace period for the first stdin byte when a prompt argument is already
 * present. Long enough for a real producer to start writing, short enough that
 * an idle inherited pipe does not look like a hang.
 */
export const STDIN_FIRST_CHUNK_TIMEOUT_MS = 2000;

export interface PipedStdinStream extends Readable {
	isTTY?: boolean;
	unref?: () => void;
}

export interface ReadPipedStdinOptions {
	stream: PipedStdinStream;
	/** True when a message argument already provides the prompt. */
	hasExplicitPrompt: boolean;
	idleTimeoutMs?: number;
	onIdleTimeout?: () => void;
}

/**
 * Read all content from piped stdin.
 *
 * Returns undefined if stdin is a TTY (interactive terminal), or if a prompt
 * argument is present and stdin stays silent for the grace period: a parent
 * process that spawns pi with an open but unused stdin pipe would otherwise
 * block startup forever. Once the first chunk arrives the stream is read to
 * completion, so slow producers are not truncated mid-stream.
 */
export async function readPipedStdin(options: ReadPipedStdinOptions): Promise<string | undefined> {
	const { stream, hasExplicitPrompt, idleTimeoutMs = STDIN_FIRST_CHUNK_TIMEOUT_MS, onIdleTimeout } = options;
	if (stream.isTTY) {
		return undefined;
	}

	return new Promise((resolve) => {
		let data = "";
		let timeout: NodeJS.Timeout | undefined;

		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			stream.off("data", onData);
			stream.off("end", onEnd);
			stream.off("error", onError);
		};
		const finish = () => {
			cleanup();
			resolve(data.trim() || undefined);
		};
		const onData = (chunk: string) => {
			if (timeout) {
				clearTimeout(timeout);
				timeout = undefined;
			}
			data += chunk;
		};
		const onEnd = () => finish();
		const onError = () => finish();

		stream.setEncoding("utf8");
		stream.on("data", onData);
		stream.once("end", onEnd);
		stream.once("error", onError);

		if (hasExplicitPrompt) {
			timeout = setTimeout(() => {
				cleanup();
				// Stop holding the event loop open on a pipe nobody is writing to.
				stream.pause();
				stream.unref?.();
				onIdleTimeout?.();
				resolve(undefined);
			}, idleTimeoutMs);
		}

		stream.resume();
	});
}
