import { trackLateCleanup } from "@oh-my-pi/pi-utils";

const ABORT_CLEANUP_GRACE_MS = 100;
export const TOOL_EXECUTION_CANCELLED = Symbol("tool-execution-cancelled");

/** Bound explicit cancellation without bounding physical execution or its resource lifetime. */
export async function settleToolExecution(
	execution: Promise<unknown>,
	signal: AbortSignal | undefined,
	context: { toolCallId: string; toolName: string },
	onStarted: ((completion: Promise<void>) => void) | undefined,
	onDetached: () => void,
): Promise<unknown> {
	try {
		// Ownership starts before a caller can abort and dispose; this completion always fulfills.
		onStarted?.(
			execution.then(
				() => {},
				() => {},
			),
		);
	} catch (error) {
		onDetached();
		trackLateCleanup(
			execution.then(() => {}),
			context,
		);
		throw error;
	}
	if (!signal) return execution;
	const cancelled = Promise.withResolvers<typeof TOOL_EXECUTION_CANCELLED>();
	let timer: Timer | undefined;
	const onAbort = (): void => {
		timer = setTimeout(() => cancelled.resolve(TOOL_EXECUTION_CANCELLED), ABORT_CLEANUP_GRACE_MS);
	};
	signal.addEventListener("abort", onAbort, { once: true });
	if (signal.aborted) onAbort();
	try {
		const outcome = await Promise.race([execution, cancelled.promise]);
		if (outcome === TOOL_EXECUTION_CANCELLED) {
			onDetached();
			trackLateCleanup(
				execution.then(() => {}),
				context,
			);
		}
		return outcome;
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", onAbort);
	}
}
