import * as logger from "./logger";

const pendingCleanups = new Set<Promise<void>>();

/** Keep deferred work reachable and observe failures until its resources really settle. */
export function trackLateCleanup(work: Promise<void>, context: Record<string, unknown>): Promise<void> {
	const tracked = work
		.catch(error => {
			logger.warn("Deferred cleanup failed", {
				...context,
				error: error instanceof Error ? error.message : String(error),
			});
		})
		.finally(() => pendingCleanups.delete(tracked));
	pendingCleanups.add(tracked);
	return tracked;
}
