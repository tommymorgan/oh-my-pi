import * as fs from "node:fs";
import * as path from "node:path";
import * as logger from "@oh-my-pi/pi-utils/logger";

/** Allocated only when PI_TUI_OUTPUT_METRICS names a JSONL destination. */
export class TerminalOutputMetrics {
	readonly startedAt = performance.now();
	startMs = 0;
	isolationMs = 0;
	writeCalls = 0;
	writeBytes = 0;
	writeMs = 0;
	peakPendingBytes = 0;
	isolated = false;
	pump = false;

	constructor(readonly destination: string) {}

	finish(stopMs: number): void {
		try {
			fs.mkdirSync(path.dirname(this.destination), { recursive: true });
			fs.appendFileSync(
				this.destination,
				`${JSON.stringify({
					pid: process.pid,
					platform: process.platform,
					elapsedMs: performance.now() - this.startedAt,
					startMs: this.startMs,
					isolationMs: this.isolationMs,
					writeCalls: this.writeCalls,
					writeBytes: this.writeBytes,
					writeMs: this.writeMs,
					peakPendingBytes: this.peakPendingBytes,
					stopMs,
					isolated: this.isolated,
					pump: this.pump,
				})}\n`,
			);
		} catch (err) {
			logger.warn("could not save terminal output measurements", { err });
		}
	}
}
