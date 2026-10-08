/**
 * Fixed synthetic workloads and shared sample types for the terminal-output
 * benchmark (`terminal-output.bench.ts` outer runner, `terminal-output-driver.ts`
 * in-PTY driver).
 *
 * Both sides import this module so constants, child scripts, and byte counts
 * stay byte-identical across runs and across before/after comparisons. No
 * model, no network, no repository state: every payload is deterministic.
 */

/** PTY geometry handed to PtySession (matches ~/tmp/omp-terminal-repro/verify.py). */
export const PTY_COLS = 100;
export const PTY_ROWS = 24;

/**
 * Idle renderer workload: TUI-owned updates with no child output. Isolates the
 * render pipeline (requestRender → paint → pump drain) from child interference.
 */
export const RENDER_UPDATES = 40;
/** Above the TUI's ~33ms minimum render interval so each update paints its own frame. */
export const RENDER_INTERVAL_MS = 50;

/**
 * Raw pump workload: `ProcessTerminal.write()` enqueue cost and drain, with no
 * diff rendering involved. Keeps "renderer overhead" and "sink/pump cost"
 * separately measurable — a benchmark that only swapped the write sink would
 * show up here unchanged while the renderer metrics moved (or vice versa).
 */
export const RAW_WRITE_CHUNK_BYTES = 4096;
export const RAW_WRITE_CALLS = 64;
export const RAW_WRITE_BURSTS = 4;

/** Quiet child workload: spawn/exit while the TUI owns the terminal, zero output. */
export const QUIET_CHILD_RUNS = 8;
export const QUIET_CHILD_LIFETIME_MS = 200;

/** Noisy child workload: inherited synthetic compiler diagnostics, ~1 MiB. */
export const DIAG_CHILD_RUNS = 3;
export const DIAG_TOTAL_BYTES = 1_048_576;

/** Wall-clock caps so a hung phase fails the run instead of stalling it. */
export const FRAME_SETTLE_CAP_MS = 15_000;
export const CHILD_KILL_GUARD_MS = 30_000;

/** Every workload knob in one object, embedded in the saved aggregate. */
export const WORKLOAD_CONSTANTS = {
	ptyCols: PTY_COLS,
	ptyRows: PTY_ROWS,
	renderUpdates: RENDER_UPDATES,
	renderIntervalMs: RENDER_INTERVAL_MS,
	rawWriteChunkBytes: RAW_WRITE_CHUNK_BYTES,
	rawWriteCalls: RAW_WRITE_CALLS,
	rawWriteBursts: RAW_WRITE_BURSTS,
	quietChildRuns: QUIET_CHILD_RUNS,
	quietChildLifetimeMs: QUIET_CHILD_LIFETIME_MS,
	diagChildRuns: DIAG_CHILD_RUNS,
	diagTotalBytes: DIAG_TOTAL_BYTES,
} as const;

/** Synthetic diagnostics block (same shape as ~/tmp/omp-terminal-repro/repro.ts). */
const DIAGNOSTICS_BLOCK = [
	"SYNTHETIC_COMPILER_OUTPUT_LEAK",
	"worker.ts:539: error TS2322: Synthetic incompatible types.",
	"    await deliverTaskLifecycle({ codec }, event.id);",
	"                                ~~~~~",
	"Found 1 synthetic error. No compiler was executed.",
	"",
].join("\n");

const DIAGNOSTICS_BLOCK_BYTES = Buffer.byteLength(DIAGNOSTICS_BLOCK);
/** Whole-block repeats that fit inside DIAG_TOTAL_BYTES (payload truncates at a line boundary). */
export const DIAGNOSTICS_BLOCK_REPEATS = Math.floor(DIAG_TOTAL_BYTES / DIAGNOSTICS_BLOCK_BYTES);
/** Exact byte count the diagnostics child writes; deterministic across runs. */
export const DIAGNOSTICS_CHILD_BYTES = DIAGNOSTICS_BLOCK_BYTES * DIAGNOSTICS_BLOCK_REPEATS;

/** Self-contained `bun -e` source for the noisy child (constants inlined, no imports). */
export function diagnosticsChildScript(): string {
	return (
		`const block = ${JSON.stringify(DIAGNOSTICS_BLOCK)}.repeat(${DIAGNOSTICS_BLOCK_REPEATS});` +
		"process.stdout.write(block);process.exitCode = 1;"
	);
}

/** Self-contained `bun -e` source for the quiet child: alive briefly, zero output. */
export function quietChildScript(): string {
	return `setTimeout(() => process.exit(0), ${QUIET_CHILD_LIFETIME_MS});`;
}

/** SGR bytes wrapped around the padding line of {@link buildRawWriteChunk}. */
const PAD_SGR_BYTES = Buffer.byteLength("\x1b[36m") + Buffer.byteLength("\x1b[0m");

/**
 * Deterministic frame-ish payload for the raw pump burst: whole lines with SGR
 * color wraps, padded to the exact byte budget without cutting an escape.
 */
export function buildRawWriteChunk(bytes = RAW_WRITE_CHUNK_BYTES): string {
	const lines: string[] = [];
	let total = 0;
	for (let i = 0; ; i++) {
		const line = `\x1b[32m${String(i % 1000).padStart(3, "0")} fixed-width pump payload row for enqueue cost\x1b[0m\n`;
		if (total + Buffer.byteLength(line) > bytes - PAD_SGR_BYTES) break;
		lines.push(line);
		total += Buffer.byteLength(line);
	}
	lines.push(`\x1b[36m${" ".repeat(Math.max(0, bytes - total - PAD_SGR_BYTES))}\x1b[0m`);
	return lines.join("");
}

/** Raw per-run sample emitted by the in-PTY driver; all timings are wall-clock. */
export interface TerminalOutputSample {
	driver: "terminal-output-driver";
	pid: number;
	platform: string;
	paints: number;
	settleFailures: number;
	error?: string;
	phases: {
		startup: { startCallMs: number; firstFrameMs: number; drained: boolean };
		idleRender: { latencyMs: number[]; frameCostMs: number[] };
		quietChild: { childWallMs: number[]; exitCodes: number[]; frameAfterMs: number[] };
		diagnosticsChild: { childWallMs: number[]; exitCodes: number[]; frameAfterMs: number[]; childBytes: number };
		rawWrite: {
			enqueueMs: number[];
			drainMs: number[];
			perCallUsMedian: number[];
			chunkBytes: number;
			postRawFrameMs: number;
		};
		stop: { stopMs: number };
	};
}
