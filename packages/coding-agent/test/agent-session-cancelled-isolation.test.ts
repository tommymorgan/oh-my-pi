import { expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AgentTool } from "@oh-my-pi/pi-agent-core/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as executor from "@oh-my-pi/pi-coding-agent/task/executor";
import { runIsolatedSubprocess } from "@oh-my-pi/pi-coding-agent/task/isolation-runner";
import * as worktree from "@oh-my-pi/pi-coding-agent/task/worktree";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

it("returns an aborted isolated task while retaining its workspace until a cancelled session's live write settles", async () => {
	const root = TempDir.createSync("@omp-cancelled-isolation-");
	const workspace = path.join(root.path(), "workspace");
	const parentFile = path.join(root.path(), "parent.txt");
	const lateFile = path.join(workspace, "late.txt");
	await fs.mkdir(workspace);
	await Bun.write(parentFile, "base");
	const auth = createInMemoryAuthStorage();
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const cleaned = Promise.withResolvers<void>();
	const visibleCancellation = Promise.withResolvers<void>();
	const parameters = type({});
	let lateWrite: string | undefined;
	const tool: AgentTool<typeof parameters> = {
		name: "live_write",
		label: "Live write",
		description: "Isolated cancellation diagnostic",
		parameters,
		async execute() {
			entered.resolve();
			await release.promise;
			await Bun.write(lateFile, "late mutation");
			lateWrite = await Bun.file(lateFile).text();
			return { content: [{ type: "text", text: "committed" }], details: {} };
		},
	};
	const mock = createMockModel({
		responses: [{ content: [{ type: "toolCall", id: "write-1", name: tool.name, arguments: {} }] }],
	});
	const agent = new Agent({ initialState: { model: mock.model, tools: [tool] }, streamFn: mock.stream });
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(root.path()),
		settings: Settings.isolated(),
		modelRegistry: new ModelRegistry(auth, path.join(root.path(), "models.yml")),
		agentId: "CancellationLiveWrite",
	});
	let deferredCleanup: Promise<void> | undefined;
	const id = "CancellationLiveWrite";
	vi.spyOn(worktree, "ensureIsolation").mockResolvedValue({
		mergedDir: workspace,
		backend: natives.IsoBackendKind.Rcopy,
		fellBack: false,
		fallbackReason: null,
	});
	vi.spyOn(worktree, "captureIsolationBaseline").mockResolvedValue({
		root: { repoRoot: root.path(), headCommit: "base", staged: "", unstaged: "", untracked: [], untrackedPatch: "" },
		nested: [],
	});
	vi.spyOn(worktree, "cleanupIsolation").mockImplementation(async () => {
		await fs.rm(workspace, { recursive: true, force: true });
		cleaned.resolve();
	});
	vi.spyOn(worktree, "commitToBranch").mockImplementation(async () => {
		await Bun.write(parentFile, "applied");
		return null;
	});
	vi.spyOn(executor, "runSubprocess").mockImplementation(async options => {
		AgentRegistry.global().register({
			id,
			displayName: id,
			kind: "sub",
			session,
			sessionFile: path.join(root.path(), "session.jsonl"),
			status: "running",
		});
		const running = agent.prompt("write");
		await entered.promise;
		agent.abort();
		await running;
		visibleCancellation.resolve();
		await executor.finalizeSubagentLifecycle({
			id,
			session,
			aborted: true,
			keepAlive: false,
			isolated: true,
			agentIdleTtlMs: 0,
			reviveSession: null,
			cleanupDeadlineAt: Date.now(),
			onCleanupDeferred: options.onCleanupDeferred,
			onRelease: options.onRelease,
		});
		return {
			index: 0,
			id,
			agent: "task",
			agentSource: "bundled",
			task: "write",
			assignment: "write",
			exitCode: 1,
			aborted: true,
			output: "",
			stderr: "",
			truncated: false,
			durationMs: 1,
			tokens: 0,
			requests: 1,
		};
	});
	const running = runIsolatedSubprocess({
		baseOptions: {
			cwd: root.path(),
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "write",
			index: 0,
			id,
			keepAlive: false,
			onCleanupDeferred: completion => {
				deferredCleanup = completion;
			},
		},
		context: { repoRoot: root.path() },
		preferredBackend: undefined,
		agentId: id,
		mergeMode: "branch",
		artifactsDir: path.join(root.path(), "artifacts"),
		buildFailureResult: error => {
			throw error;
		},
	});
	try {
		await visibleCancellation.promise;
		// Real lifecycle deadline integrates session teardown and platform timer promises.
		const result = await untilAborted(AbortSignal.timeout(1_000), () => running);
		expect(result.aborted).toBe(true);
		expect(await Bun.file(parentFile).text()).toBe("base");
		expect(await fs.stat(workspace).then(stat => stat.isDirectory())).toBe(true);
		expect(deferredCleanup).toBeDefined();
		release.resolve();
		await deferredCleanup;
		await cleaned.promise;
		expect(lateWrite).toBe("late mutation");
		expect(await Bun.file(lateFile).exists()).toBe(false);
		expect(await Bun.file(parentFile).text()).toBe("base");
	} finally {
		release.resolve();
		await running;
		await session.dispose();
		AgentRegistry.global().unregister(id);
		auth.close();
		vi.restoreAllMocks();
		root.removeSync();
	}
});
