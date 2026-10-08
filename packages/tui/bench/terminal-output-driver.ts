/**
 * In-PTY driver for the terminal-output benchmark.
 *
 * Spawned by terminal-output.bench.ts on a fresh native PTY via
 * PtySession.startArgv. stdout/stderr are the PTY slave, so ProcessTerminal
 * takes its real production path (raw mode, capability probes, TtyWriter
 * output pump) and children spawned with inherited stdio write straight onto
 * the terminal — the exact inherited-output scenario the isolation work
 * targets.
 *
 * The driver prints NOTHING while measuring: any direct write would corrupt
 * the terminal the TUI owns. Timings are written as JSON to the file named by
 * OMP_BENCH_SAMPLE_OUT; the exit code reports success.
 *
 * Every measurement below is driver-side wall clock, independent of the
 * optional PI_TUI_OUTPUT_METRICS instrumentation (the outer runner attaches
 * those JSONL records separately when the variable is set).
 */
import { ProcessTerminal } from "../src/terminal";
import { TUI } from "../src/tui";
import {
	CHILD_KILL_GUARD_MS,
	DIAG_CHILD_RUNS,
	DIAGNOSTICS_CHILD_BYTES,
	FRAME_SETTLE_CAP_MS,
	QUIET_CHILD_RUNS,
	RAW_WRITE_BURSTS,
	RAW_WRITE_CALLS,
	RENDER_INTERVAL_MS,
	RENDER_UPDATES,
	type TerminalOutputSample,
	buildRawWriteChunk,
	diagnosticsChildScript,
	quietChildScript,
} from "./terminal-output-workloads";

const samplePath = process.env.OMP_BENCH_SAMPLE_OUT;
if (!samplePath) throw new Error("OMP_BENCH_SAMPLE_OUT must name the sample JSON file");
if (!process.stdout.isTTY) throw new Error("driver must run with stdout attached to the benchmark PTY");

const nowMs = (): number => Number(Bun.nanoseconds()) / 1e6;

let paints = 0;
let settleFailures = 0;
let paintArrived: (() => void) | undefined;

const terminal = new ProcessTerminal();
const ui = new TUI(terminal, undefined, {
	onPaint: () => {
		paints++;
		paintArrived?.();
	},
});

let statusRow = "STARTING";
let updates = 0;
ui.addChild({
	render: width =>
		[
			"OMP_TERMINAL_OUTPUT_BENCH",
			"Real ProcessTerminal + TUI on a native PTY; fixed synthetic workloads.",
			"Phases: startup, idle render, quiet child, diagnostics child, raw pump writes, stop.",
			`STATUS ${statusRow}`,
			`UPDATES ${updates}`,
		].map(row => row.slice(0, width)),
});

interface PaintResult {
	frameCostMs: number;
	timedOut: boolean;
}

/** Resolve on the next completed paint (armed BEFORE triggering the render). */
async function nextPaint(capMs = FRAME_SETTLE_CAP_MS): Promise<PaintResult> {
	const { promise, resolve } = Promise.withResolvers<void>();
	paintArrived = resolve;
	let timedOut = false;
	const cap = setTimeout(() => {
		timedOut = true;
		resolve();
	}, capMs);
	await promise;
	clearTimeout(cap);
	paintArrived = undefined;
	return { frameCostMs: ui.lastFrameCostMs, timedOut };
}

/** Wait until the output pump has handed every queued byte to the PTY. */
async function awaitDrain(capMs = FRAME_SETTLE_CAP_MS): Promise<boolean> {
	const deadline = nowMs() + capMs;
	for (;;) {
		if ((terminal.pendingOutputBytes ?? 0) === 0) return true;
		if (nowMs() >= deadline) return false;
		await Bun.sleep(2);
	}
}

interface SettleResult {
	latencyMs: number;
	frameCostMs: number;
	timedOut: boolean;
	drained: boolean;
}

/** requestRender → completed paint → pump drain, timed end to end. */
async function renderAndSettle(): Promise<SettleResult> {
	const t0 = nowMs();
	const paint = nextPaint();
	ui.requestRender();
	const done = await paint;
	const drained = await awaitDrain();
	if (done.timedOut || !drained) settleFailures++;
	return { latencyMs: nowMs() - t0, frameCostMs: done.frameCostMs, timedOut: done.timedOut, drained };
}

/** Run a `bun -e` child with INHERITED stdio (the corruption path) and time it. */
async function runChild(script: string): Promise<{ wallMs: number; exitCode: number }> {
	const t0 = nowMs();
	const child = Bun.spawn([process.execPath, "-e", script], {
		stdin: "ignore",
		stdout: "inherit",
		stderr: "inherit",
	});
	const guard = setTimeout(() => child.kill(), CHILD_KILL_GUARD_MS);
	const exitCode = await child.exited;
	clearTimeout(guard);
	return { wallMs: nowMs() - t0, exitCode };
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

const sample: TerminalOutputSample = {
	driver: "terminal-output-driver",
	pid: process.pid,
	platform: process.platform,
	paints: 0,
	settleFailures: 0,
	phases: {
		startup: { startCallMs: 0, firstFrameMs: 0, drained: false },
		idleRender: { latencyMs: [], frameCostMs: [] },
		quietChild: { childWallMs: [], exitCodes: [], frameAfterMs: [] },
		diagnosticsChild: { childWallMs: [], exitCodes: [], frameAfterMs: [], childBytes: DIAGNOSTICS_CHILD_BYTES },
		rawWrite: { enqueueMs: [], drainMs: [], perCallUsMedian: [], chunkBytes: 0, postRawFrameMs: 0 },
		stop: { stopMs: 0 },
	},
};

try {
	// Phase 1 — startup: TUI.start() call cost, first paint, first pump drain.
	const t0 = nowMs();
	const firstPaint = nextPaint();
	ui.start();
	sample.phases.startup.startCallMs = nowMs() - t0;
	const first = await firstPaint;
	sample.phases.startup.firstFrameMs = nowMs() - t0;
	sample.phases.startup.drained = await awaitDrain();
	if (first.timedOut || !sample.phases.startup.drained) settleFailures++;

	// Phase 2 — idle renderer: pipeline latency with no child output at all.
	for (let i = 0; i < RENDER_UPDATES; i++) {
		updates++;
		statusRow = `IDLE_RENDER_${i}_${"x".repeat(1 + (i % 5))}`;
		const settled = await renderAndSettle();
		sample.phases.idleRender.latencyMs.push(settled.latencyMs);
		sample.phases.idleRender.frameCostMs.push(settled.frameCostMs);
		if (i < RENDER_UPDATES - 1) await Bun.sleep(RENDER_INTERVAL_MS);
	}

	// Phase 3 — quiet children: spawn/exit under terminal ownership, zero bytes.
	for (let i = 0; i < QUIET_CHILD_RUNS; i++) {
		const child = await runChild(quietChildScript());
		sample.phases.quietChild.childWallMs.push(child.wallMs);
		sample.phases.quietChild.exitCodes.push(child.exitCode);
		statusRow = `QUIET_CHILD_DONE_${i}`;
		sample.phases.quietChild.frameAfterMs.push((await renderAndSettle()).latencyMs);
	}

	// Phase 4 — diagnostics children: ~1 MiB inherited synthetic compiler output.
	for (let i = 0; i < DIAG_CHILD_RUNS; i++) {
		const child = await runChild(diagnosticsChildScript());
		sample.phases.diagnosticsChild.childWallMs.push(child.wallMs);
		sample.phases.diagnosticsChild.exitCodes.push(child.exitCode);
		statusRow = `DIAG_CHILD_DONE_${i}`;
		sample.phases.diagnosticsChild.frameAfterMs.push((await renderAndSettle()).latencyMs);
	}

	// Phase 5 — raw pump: write() enqueue vs drain, no diff rendering.
	const chunk = buildRawWriteChunk();
	sample.phases.rawWrite.chunkBytes = Buffer.byteLength(chunk);
	for (let b = 0; b < RAW_WRITE_BURSTS; b++) {
		const perCallUs: number[] = [];
		const t1 = nowMs();
		for (let c = 0; c < RAW_WRITE_CALLS; c++) {
			const w0 = nowMs();
			terminal.write(chunk);
			perCallUs.push((nowMs() - w0) * 1000);
		}
		sample.phases.rawWrite.enqueueMs.push(nowMs() - t1);
		sample.phases.rawWrite.perCallUsMedian.push(median(perCallUs));
		const d0 = nowMs();
		const drained = await awaitDrain();
		if (!drained) settleFailures++;
		sample.phases.rawWrite.drainMs.push(nowMs() - d0);
	}
	statusRow = "RAW_WRITE_DONE";
	sample.phases.rawWrite.postRawFrameMs = (await renderAndSettle()).latencyMs;

	// Phase 6 — stop: teardown including pump flush.
	const t2 = nowMs();
	ui.stop();
	sample.phases.stop.stopMs = nowMs() - t2;
} catch (err) {
	sample.error = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
	try {
		ui.stop();
	} catch {}
}

sample.paints = paints;
sample.settleFailures = settleFailures;
await Bun.write(samplePath, JSON.stringify(sample));
process.exit(sample.error ? 1 : 0);
