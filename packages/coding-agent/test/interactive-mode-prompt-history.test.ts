import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { InteractiveMode } from "@oh-my-pi/pi-coding-agent/modes/interactive-mode";
import { cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as tern from "@oh-my-pi/pi-coding-agent/tools/browser/tern/kind";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("InteractiveMode conversation recall", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode | undefined;
	let storage: HistoryStorage;

	beforeAll(() => initTheme());

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-mode-history-");
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		cfgStartupQuiet.set(Settings.instance, true);
		HistoryStorage.close();
		storage = HistoryStorage.open(tempDir.join("history.db"));
		vi.spyOn(HistoryStorage, "open").mockReturnValue(storage);
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const model = createMockModel();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions")),
			settings: Settings.isolated({ "composer.historyScope": "session", "compaction.enabled": false }),
			modelRegistry: registry,
		});
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		HistoryStorage.close();
		vi.restoreAllMocks();
		tempDir?.removeSync();
		mode = undefined;
		resetSettingsForTest();
	});

	it("does not recall a canceled fork draft, paste, or attachments after returning to the original conversation", async () => {
		vi.spyOn(tern, "resolveTernPane").mockReturnValue(null);
		const manager = session.sessionManager;
		manager.appendMessage({
			role: "user",
			content: "original saved prompt",
			attribution: "user",
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(manager.buildSessionContext().messages);
		// A user-only session is lazy: flush() does not create its allocated path.
		// Materialize A so switching back reads its real saved journal.
		await manager.ensureOnDisk();
		const originalFile = manager.getSessionFile();
		if (!originalFile) throw new Error("Expected persisted original conversation");
		const originalId = manager.getSessionId();
		mode = new InteractiveMode(session, "test");
		await mode.init({ suppressWelcomeIntro: true });

		await mode.handleForkCommand();
		expect(manager.getSessionId()).not.toBe(originalId);
		mode.editor.insertPaste("fork-only payload\n".repeat(20));
		mode.editor.pendingImages = [{ type: "image", data: "Zm9yaw==", mimeType: "image/png" }];
		mode.editor.pendingImageLinks = ["fork-only.png"];
		mode.editor.clearDraftForRecall();

		expect(await session.switchSession(originalFile)).toBe(true);
		expect(manager.getSessionId()).toBe(originalId);
		mode.editor.handleInput("\x1b[A");
		expect(mode.editor.getExpandedText()).toBe("original saved prompt");
		expect(mode.editor.pendingImages).toEqual([]);
		expect(mode.editor.pendingImageLinks).toEqual([]);
		mode.editor.handleInput("\x1b[A");
		expect(mode.editor.getExpandedText()).not.toContain("fork-only payload");
		expect(storage.getRecent(100).some(entry => entry.prompt.includes("fork-only"))).toBe(false);
	});

	it("recovers user skill commands from the journal when another conversation owns the latest global row", async () => {
		const manager = session.sessionManager;
		manager.appendCustomMessageEntry(
			"skill-prompt",
			"EXPANDED PRIVATE SKILL BODY",
			true,
			{ name: "review", args: "src" },
			"user",
		);
		manager.appendCustomMessageEntry(
			"skill-prompt",
			"EXPANDED PROMPT BODY",
			true,
			{ name: "ignored", prompt: "/skill:chip exact args" },
			"user",
		);
		manager.appendCustomMessageEntry("skill-prompt", "AGENT BODY", true, { name: "agent-only" }, "agent");
		manager.appendCustomMessageEntry("skill-prompt", "INJECTED BODY", true, { name: "injected-only" });
		manager.appendMessage({
			role: "user",
			content: "agent-only user message",
			attribution: "agent",
			timestamp: Date.now(),
		});
		await storage.add("/skill:review src", tempDir.path(), "other-conversation");
		mode = new InteractiveMode(session, "test");
		await mode.init({ suppressWelcomeIntro: true });

		const prompts = storage.getRecent(100, { sessionId: manager.getSessionId() }).map(entry => entry.prompt);
		expect(prompts).toContain("/skill:review src");
		expect(prompts).toContain("/skill:chip exact args");
		expect(prompts).toHaveLength(2);
		mode.editor.handleInput("\x1b[A");
		expect(mode.editor.getExpandedText()).toMatch(/^\/skill:/);
		expect(mode.editor.getExpandedText()).not.toContain("BODY");
	});
});
