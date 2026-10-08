/**
 * Terminal-output benchmark: outer runner and before/after comparison.
 *
 * Spawns terminal-output-driver.ts on a fresh native PTY (PtySession.startArgv)
 * once per run, captures the full PTY byte stream as raw evidence, and
 * aggregates the warmed measured runs into medians/p95 saved next to the raw
 * samples. Same driver, same fixed workloads before and after the isolation
 * change — only the production code under test differs.
 *
 * Usage:
 *   bun packages/tui/bench/terminal-output.bench.ts [--runs 7] [--warmup 2] [--label before] [--out DIR]
 *   bun packages/tui/bench/terminal-output.bench.ts compare [BEFORE_JSON AFTER_JSON]
 *
 * Post-change comparison (defaults read performance-{before,after}.json from --out):
 *   bun packages/tui/bench/terminal-output.bench.ts --label after
 *   bun packages/tui/bench/terminal-output.bench.ts compare
 *
 * PI_TUI_OUTPUT_METRICS: when set in this process's environment it is
 * forwarded to the driver, and any JSONL records appended during a run are
 * attached to that run's raw sample as "pumpMetrics". Baseline runs do not
 * need it — every renderer/child timing here is measured independently of
 * that opt-in instrumentation.
 */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { PtySession } from "@oh-my-pi/pi-natives";
import {
	DIAGNOSTICS_CHILD_BYTES,
	PTY_COLS,
	PTY_ROWS,
	type TerminalOutputSample,
	WORKLOAD_CONSTANTS,
} from "./terminal-output-workloads";

const DRIVER_PATH = path.join(import.meta.dir, "terminal-output-driver.ts");
const RUN_TIMEOUT_MS = 180_000;

/** Aggregate record appended per terminal-ownership interval (PI_TUI_OUTPUT_METRICS JSONL). */
const pumpMetricSchema = type({
	pid: "number",
	platform: "string",
	elapsedMs: "number",
	startMs: "number",
	isolationMs: "number",
	writeCalls: "number",
	writeBytes: "number",
	writeMs: "number",
	peakPendingBytes: "number",
	stopMs: "number",
	isolated: "boolean",
	pump: "boolean",
});
type PumpMetric = typeof pumpMetricSchema.infer;

/** Validate one JSONL record; malformed instrumentation output fails the run loudly. */
function parsePumpMetric(line: string): PumpMetric {
	const parsed = pumpMetricSchema(JSON.parse(line));
	if (parsed instanceof type.errors) throw new Error(`malformed PI_TUI_OUTPUT_METRICS record: ${parsed.summary}`);
	return parsed;
}

interface RunRecord {
	index: number;
	kind: "warmup" | "measured";
	wallMs: number;
	ptyBytes: number;
	capturePath: string;
	sample: TerminalOutputSample;
	pumpMetrics: PumpMetric[] | null;
}

interface MetricSummary {
	unit: "ms" | "bytes";
	n: number;
	median: number;
	p95: number;
	min: number;
	max: number;
	mean: number;
	perRunMedian: number[];
}

interface AggregateFile {
	meta: {
		createdAt: string;
		label: string;
		runs: number;
		warmup: number;
		pty: { cols: number; rows: number };
		bun: string;
		platform: string;
		workloads: Record<string, number>;
		diagnosticsChildBytes: number;
		metricsDestination: string | null;
	};
	metrics: Record<string, MetricSummary>;
}

interface MetricSpec {
	key: string;
	unit: "ms" | "bytes";
	perRun: (sample: TerminalOutputSample) => number[];
}

/**
 * Metric extraction. Idle-renderer, quiet-child, noisy-child, and raw-pump
 * families are kept separate so a before/after delta can be attributed: e.g. a
 * regression only in diagnosticsChild.* is child-output interference, only in
 * idleRender.* is renderer cost, only in rawWrite.* is pump/sink cost.
 */
const METRICS: MetricSpec[] = [
	{ key: "startup.startCall", unit: "ms", perRun: s => [s.phases.startup.startCallMs] },
	{ key: "startup.firstFrame", unit: "ms", perRun: s => [s.phases.startup.firstFrameMs] },
	{ key: "idleRender.frameLatency", unit: "ms", perRun: s => s.phases.idleRender.latencyMs },
	{ key: "idleRender.frameCost", unit: "ms", perRun: s => s.phases.idleRender.frameCostMs },
	{ key: "quietChild.wall", unit: "ms", perRun: s => s.phases.quietChild.childWallMs },
	{ key: "quietChild.frameAfter", unit: "ms", perRun: s => s.phases.quietChild.frameAfterMs },
	{ key: "diagnosticsChild.wall", unit: "ms", perRun: s => s.phases.diagnosticsChild.childWallMs },
	{ key: "diagnosticsChild.frameAfter", unit: "ms", perRun: s => s.phases.diagnosticsChild.frameAfterMs },
	{ key: "rawWrite.enqueuePerBurst", unit: "ms", perRun: s => s.phases.rawWrite.enqueueMs },
	{ key: "rawWrite.drainPerBurst", unit: "ms", perRun: s => s.phases.rawWrite.drainMs },
	{ key: "rawWrite.postBurstFrame", unit: "ms", perRun: s => [s.phases.rawWrite.postRawFrameMs] },
	{ key: "stop.stopCall", unit: "ms", perRun: s => [s.phases.stop.stopMs] },
];

function summarize(values: number[]): Omit<MetricSummary, "unit" | "perRunMedian"> {
	const sorted = [...values].sort((a, b) => a - b);
	const n = sorted.length;
	const at = (q: number): number => sorted[Math.min(n - 1, Math.ceil(q * (n - 1)))];
	const mean = sorted.reduce((a, b) => a + b, 0) / n;
	return { n, median: at(0.5), p95: at(0.95), min: sorted[0], max: sorted[n - 1], mean };
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)];
}

/** Median absolute deviation (robust run-to-run noise estimate for compare). */
function mad(values: number[]): number {
	const m = median(values);
	return median(values.map(v => Math.abs(v - m)));
}

interface RunOptions {
	label: string;
	outDir: string;
	metricsPath: string | null;
}

async function runOnce(kind: "warmup" | "measured", index: number, options: RunOptions): Promise<RunRecord> {
	const rawDir = path.join(options.outDir, "raw");
	await fs.mkdir(rawDir, { recursive: true });
	const stem = `${options.label}-${kind}-${String(index).padStart(2, "0")}`;
	const samplePath = path.join(rawDir, `${stem}.json`);
	const capturePath = path.join(rawDir, `${stem}.ansi`);

	let metricsOffset = 0;
	if (options.metricsPath) {
		try {
			metricsOffset = (await fs.stat(options.metricsPath)).size;
		} catch {
			metricsOffset = 0;
		}
	}

	// Deliberately minimal env: fixed TERM geometry hints, no multiplexer
	// markers, no inherited PI_TUI_* knobs (matches ~/tmp/omp-terminal-repro/verify.py).
	const env: Record<string, string> = {
		PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
		HOME: process.env.HOME ?? os.homedir(),
		LANG: process.env.LANG ?? "C.UTF-8",
		TERM: "xterm-256color",
		TERM_PROGRAM: "xterm",
		OMP_BENCH_SAMPLE_OUT: samplePath,
	};
	if (options.metricsPath) env.PI_TUI_OUTPUT_METRICS = options.metricsPath;

	const session = new PtySession();
	let capture = "";
	let streamErrors = 0;
	const t0 = performance.now();
	const result = await session.startArgv(
		{
			application: process.execPath,
			args: [DRIVER_PATH],
			cwd: import.meta.dir,
			env,
			cols: PTY_COLS,
			rows: PTY_ROWS,
			timeoutMs: RUN_TIMEOUT_MS,
		},
		(error, chunk) => {
			if (error) streamErrors++;
			else capture += chunk;
		},
	);
	const wallMs = performance.now() - t0;
	await Bun.write(capturePath, capture);
	if (streamErrors > 0) throw new Error(`PTY stream errors during ${kind} run ${index}`);
	if (result.timedOut || result.cancelled) {
		throw new Error(`driver ${kind} run ${index} did not finish: ${JSON.stringify(result)}; capture: ${capturePath}`);
	}
	if (result.exitCode !== 0)
		throw new Error(`driver ${kind} run ${index} exited ${result.exitCode}; capture: ${capturePath}`);

	let sample: TerminalOutputSample;
	try {
		sample = (await Bun.file(samplePath).json()) as TerminalOutputSample;
	} catch {
		throw new Error(`missing driver sample for ${kind} run ${index}: ${samplePath}`);
	}
	if (sample.error) throw new Error(`driver ${kind} run ${index} failed: ${sample.error}`);

	let pumpMetrics: PumpMetric[] | null = null;
	if (options.metricsPath) {
		const text = await Bun.file(options.metricsPath)
			.text()
			.catch(() => null);
		if (text !== null) {
			// ASCII JSONL appended across runs; slice off the portion this run
			// added. A non-ASCII earlier payload would skew the char offset —
			// acceptable for this opt-in debugging aid.
			pumpMetrics = text
				.slice(metricsOffset)
				.split("\n")
				.filter(line => line.trim() !== "")
				.map(parsePumpMetric);
		}
	}

	return { index, kind, wallMs, ptyBytes: Buffer.byteLength(capture), capturePath, sample, pumpMetrics };
}

function formatValue(value: number, unit: "ms" | "bytes"): string {
	return unit === "bytes" ? value.toLocaleString("en-US") : value.toFixed(2);
}

async function benchmark(argv: string[]): Promise<void> {
	const outDir = argString(argv, "--out", path.join(os.homedir(), "tmp", "omp-terminal-repro"));
	const label = argString(argv, "--label", "before");
	const runs = argNumber(argv, "--runs", 7);
	const warmup = argNumber(argv, "--warmup", 2);
	const metricsPath = process.env.PI_TUI_OUTPUT_METRICS ?? null;
	const options: RunOptions = { label, outDir, metricsPath };
	await fs.mkdir(outDir, { recursive: true });

	console.log(`terminal-output benchmark: ${warmup} warmup + ${runs} measured runs`);
	console.log(`  PTY ${PTY_COLS}x${PTY_ROWS}, driver ${DRIVER_PATH}`);
	console.log(`  out ${outDir}, label "${label}"`);
	if (metricsPath) console.log(`  PI_TUI_OUTPUT_METRICS: ${metricsPath} (records attached per run)`);

	const records: RunRecord[] = [];
	for (let i = 1; i <= warmup; i++) {
		const record = await runOnce("warmup", i, options);
		records.push(record);
		console.log(`  warmup ${i}/${warmup}: ${record.wallMs.toFixed(0)}ms wall, ${record.sample.paints} paints`);
	}
	const measured: RunRecord[] = [];
	for (let i = 1; i <= runs; i++) {
		const record = await runOnce("measured", i, options);
		measured.push(record);
		records.push(record);
		const diag = record.sample.phases.diagnosticsChild;
		console.log(
			`  run ${i}/${runs}: ${record.wallMs.toFixed(0)}ms wall, paints ${record.sample.paints}, ` +
				`diag child median ${median(diag.childWallMs).toFixed(1)}ms, ` +
				`idle latency median ${median(record.sample.phases.idleRender.latencyMs).toFixed(1)}ms`,
		);
	}

	const metrics: Record<string, MetricSummary> = {};
	for (const spec of METRICS) {
		const perRunMedian = measured.map(record => median(spec.perRun(record.sample)));
		metrics[spec.key] = { unit: spec.unit, ...summarize(measured.flatMap(r => spec.perRun(r.sample))), perRunMedian };
	}
	const wallValues = measured.map(r => r.wallMs);
	metrics["run.wall"] = { unit: "ms", ...summarize(wallValues), perRunMedian: wallValues };
	const ptyValues = measured.map(r => r.ptyBytes);
	metrics["pty.totalBytes"] = { unit: "bytes", ...summarize(ptyValues), perRunMedian: ptyValues };

	const aggregate: AggregateFile & { runs: RunRecord[] } = {
		meta: {
			createdAt: new Date().toISOString(),
			label,
			runs,
			warmup,
			pty: { cols: PTY_COLS, rows: PTY_ROWS },
			bun: Bun.version,
			platform: `${process.platform}/${process.arch}`,
			workloads: { ...WORKLOAD_CONSTANTS },
			diagnosticsChildBytes: DIAGNOSTICS_CHILD_BYTES,
			metricsDestination: metricsPath,
		},
		metrics,
		runs: records,
	};
	const aggregatePath = path.join(outDir, `performance-${label}.json`);
	await Bun.write(aggregatePath, JSON.stringify(aggregate, null, "\t"));

	console.log(`\n${label}: median (p95) over ${runs} measured runs`);
	for (const [key, m] of Object.entries(metrics)) {
		console.log(
			`  ${key.padEnd(26)} ${formatValue(m.median, m.unit)}${m.unit} (p95 ${formatValue(m.p95, m.unit)}, n=${m.n})`,
		);
	}
	console.log(`\nwrote ${aggregatePath}`);
	console.log(`raw samples + PTY captures: ${path.join(outDir, "raw", `${label}-*`)}`);
	console.log("noise: single host, no pinning; trust medians, expect a few percent run-to-run jitter");
	console.log("\npost-change comparison:");
	console.log("  bun packages/tui/bench/terminal-output.bench.ts --label after");
	console.log("  bun packages/tui/bench/terminal-output.bench.ts compare");
}

async function compare(args: string[]): Promise<void> {
	const outDir = argString(args, "--out", path.join(os.homedir(), "tmp", "omp-terminal-repro"));
	const positional: string[] = [];
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--out") {
			i++;
			continue;
		}
		if (args[i].startsWith("--")) continue;
		positional.push(args[i]);
	}
	const beforePath = positional[0] ?? path.join(outDir, "performance-before.json");
	const afterPath = positional[1] ?? path.join(outDir, "performance-after.json");
	const before = (await Bun.file(beforePath).json()) as AggregateFile;
	const after = (await Bun.file(afterPath).json()) as AggregateFile;

	console.log(`comparing ${beforePath} -> ${afterPath}`);
	console.log(`  before: ${before.meta.createdAt} (${before.meta.runs} runs, bun ${before.meta.bun})`);
	console.log(`  after:  ${after.meta.createdAt} (${after.meta.runs} runs, bun ${after.meta.bun})`);
	if (JSON.stringify(before.meta.workloads) !== JSON.stringify(after.meta.workloads)) {
		console.log("  WARNING: workload constants differ between files; deltas are not comparable.");
	}

	console.log(
		`\n  ${"metric".padEnd(26)} ${"before".padStart(12)} ${"after".padStart(12)} ${"delta".padStart(9)} ${"noise ±".padStart(8)}  verdict`,
	);
	for (const [key, b] of Object.entries(before.metrics)) {
		const a = after.metrics[key];
		if (!a) continue;
		const deltaPct = b.median === 0 ? Number.NaN : ((a.median - b.median) / b.median) * 100;
		// Noise is the within-label run spread (max MAD of both labels). A
		// mixed-group MAD would inflate "noise" for a deterministic step
		// change and misclassify a real regression as within-noise.
		const noisePct =
			b.median === 0 || b.perRunMedian.length === 0 || a.perRunMedian.length === 0
				? Number.NaN
				: ((1.4826 * Math.max(mad(b.perRunMedian), mad(a.perRunMedian))) / Math.abs(b.median)) * 100;
		let verdict: string;
		if (!Number.isFinite(deltaPct)) {
			verdict = "n/a";
		} else if (deltaPct === 0) {
			verdict = "identical";
		} else if (Math.abs(deltaPct) <= Math.max(Number.isFinite(noisePct) ? noisePct * 2 : 5, 5)) {
			verdict = "within noise";
		} else if (a.unit === "bytes") {
			verdict = deltaPct > 0 ? "more bytes" : "fewer bytes";
		} else {
			verdict = deltaPct > 0 ? "SLOWER" : "faster";
		}
		const unit = b.unit === "bytes" ? "B" : "ms";
		console.log(
			`  ${key.padEnd(26)} ${`${formatValue(b.median, b.unit)}${unit}`.padStart(12)} ` +
				`${`${formatValue(a.median, a.unit)}${unit}`.padStart(12)} ` +
				`${Number.isFinite(deltaPct) ? `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(1)}%` : "n/a"}`.padStart(9) +
				` ${Number.isFinite(noisePct) ? `${noisePct.toFixed(1)}%` : "n/a"}`.padStart(8) +
				`  ${verdict}`,
		);
	}

	console.log(`
Noise caveats (read before trusting any delta):
- Single host, no CPU pinning, no cgroup isolation: PTY and scheduler jitter
  between runs is real. The noise column is the larger labels' within-label
  MAD of run medians, not a bound; treat |delta| below ~2x noise (and
  always below ~5%) as unchanged.
- Compare medians only. p95, min, max, and any single run are far noisier.
- Run both labels back-to-back on an idle machine (no builds, compiles,
  browser) and re-run the before label if machine state may have drifted.
- pty.totalBytes is a determinism check, not a timing: a large shift means a
  workload or renderer output changed, not that code got faster or slower.`);
}

function argNumber(argv: string[], flag: string, fallback: number): number {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const value = Number(argv[i + 1]);
	return Number.isFinite(value) && value > 0 ? value : fallback;
}

function argString(argv: string[], flag: string, fallback: string): string {
	const i = argv.indexOf(flag);
	if (i === -1 || i + 1 >= argv.length) return fallback;
	const value = argv[i + 1];
	return value.startsWith("--") ? fallback : value;
}

const argv = process.argv.slice(2);
if (argv[0] === "compare") {
	await compare(argv.slice(1));
} else {
	await benchmark(argv);
}
