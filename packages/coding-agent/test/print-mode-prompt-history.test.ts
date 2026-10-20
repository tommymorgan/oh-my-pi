import { afterEach, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

afterEach(() => {
	HistoryStorage.close();
	vi.restoreAllMocks();
});

it("recalls later headless submissions after a prior journal import without replacing command spelling with expansion", async () => {
	const dir = TempDir.createSync("@pi-print-history-");
	const auth = await AuthStorage.create(dir.join("auth.db"));
	HistoryStorage.close();
	const historyPath = dir.join("history.db");
	const storage = HistoryStorage.open(historyPath);
	const manager = SessionManager.inMemory(dir.path());
	const sessionId = manager.getSessionId();
	storage.restoreSession(sessionId, () => []);
	await storage.add("unrelated conversation", dir.path(), "other-session");
	vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
		const callback = args.at(-1);
		if (typeof callback === "function") callback();
		return true;
	});
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	const model = createMockModel({ responses: [{ content: ["first answer"] }, { content: ["second answer"] }] });
	auth.keys.setRuntime(model.provider, "test-key");
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: model.stream,
		}),
		sessionManager: manager,
		settings: Settings.isolated({ "compaction.enabled": false }),
		modelRegistry: new ModelRegistry(auth, path.join(dir.path(), "models.yml")),
		slashCommands: [
			{ name: "review-history", description: "fixture", content: "Expanded command body", source: "test" },
		],
	});
	try {
		expect(
			await runPrintMode(session, {
				mode: "text",
				initialMessage: "later ordinary prompt",
				messages: ["/review-history original args"],
			}),
		).toBe(0);
		const requestedUserText = model.calls.flatMap(({ context }) =>
			context.messages.flatMap(message =>
				message.role !== "user"
					? []
					: typeof message.content === "string"
						? [message.content]
						: message.content.flatMap(block => (block.type === "text" ? [block.text] : [])),
			),
		);
		expect(requestedUserText).toEqual(expect.arrayContaining([expect.stringContaining("Expanded command body")]));
		HistoryStorage.close();
		const reopened = HistoryStorage.open(historyPath);
		reopened.restoreSession(sessionId, () => {
			throw new Error("Previously imported journal must not replace raw commands");
		});
		expect(reopened.getRecent(10, { sessionId }).map(entry => entry.prompt)).toEqual([
			"/review-history original args",
			"later ordinary prompt",
		]);
	} finally {
		await session.dispose();
		HistoryStorage.close();
		auth.close();
		await dir.remove();
	}
});
