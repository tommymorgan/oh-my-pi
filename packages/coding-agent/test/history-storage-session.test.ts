import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { HistoryStorage } from "@oh-my-pi/pi-coding-agent/session/history-storage";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | null = null;

async function freshStorage(prefix = "omp-history-session-"): Promise<{ storage: HistoryStorage; dbPath: string }> {
	tempDir = TempDir.createSync(`@${prefix}`);
	const dbPath = tempDir.join("history.db");
	HistoryStorage.close();
	return { storage: HistoryStorage.open(dbPath), dbPath };
}

/** Drain the 100ms insert batch window, then await the pending writes. */
async function flush(...writes: Promise<void>[]): Promise<void> {
	vi.advanceTimersByTime(100);
	await Promise.all(writes);
}

beforeEach(() => {
	HistoryStorage.close();
	vi.useFakeTimers();
});

afterEach(async () => {
	HistoryStorage.close();
	vi.useRealTimers();
	if (tempDir) {
		await Bun.sleep(0);
		await tempDir.remove().catch(() => {});
		tempDir = null;
	}
});

describe("HistoryStorage session linkage", () => {
	it("persists the originating session id and surfaces it on recent + search", async () => {
		const { storage } = await freshStorage();
		await flush(storage.add("deploy the service", "/repo", "session-abc"));

		expect(storage.getRecent(10)[0]?.sessionId).toBe("session-abc");
		expect(storage.search("deploy", 10)[0]?.sessionId).toBe("session-abc");
	});

	it("falls back to the session resolver when no explicit id is passed", async () => {
		const { storage } = await freshStorage();
		storage.setSessionResolver(() => "resolved-session");
		await flush(storage.add("run the tests", "/repo"));

		expect(storage.getRecent(10)[0]?.sessionId).toBe("resolved-session");
	});

	it("prefers an explicit session id over the resolver", async () => {
		const { storage } = await freshStorage();
		storage.setSessionResolver(() => "resolved-session");
		await flush(storage.add("explicit wins", "/repo", "explicit-session"));

		expect(storage.getRecent(10)[0]?.sessionId).toBe("explicit-session");
	});

	it("captures the session active at add() time, not at flush time", async () => {
		const { storage } = await freshStorage();
		let current = "first-session";
		storage.setSessionResolver(() => current);
		// Both adds land in the same batch window; the session must be bound when
		// each prompt is submitted, not when the shared batch is written.
		const a = storage.add("prompt in first", "/repo");
		current = "second-session";
		const b = storage.add("prompt in second", "/repo");
		await flush(a, b);

		const byPrompt = new Map(storage.getRecent(10).map(e => [e.prompt, e.sessionId]));
		expect(byPrompt.get("prompt in first")).toBe("first-session");
		expect(byPrompt.get("prompt in second")).toBe("second-session");
	});

	it("normalizes an empty session id to null", async () => {
		const { storage } = await freshStorage();
		storage.setSessionResolver(() => "");
		await flush(storage.add("no session", "/repo"));

		expect(storage.getRecent(10)[0]?.sessionId).toBeUndefined();
	});

	it("adds session_id to a pre-existing schema and leaves legacy rows unstamped", async () => {
		tempDir = TempDir.createSync("@omp-history-session-migrate-");
		const dbPath = tempDir.join("history.db");
		const legacyDb = new Database(dbPath);
		legacyDb.exec(`
			CREATE TABLE history (
				id INTEGER PRIMARY KEY AUTOINCREMENT,
				prompt TEXT NOT NULL,
				created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
				cwd TEXT
			);
		`);
		legacyDb.prepare("INSERT INTO history (prompt, cwd) VALUES (?, ?)").run("legacy prompt", "/legacy");
		legacyDb.close();

		HistoryStorage.close();
		const storage = HistoryStorage.open(dbPath);
		await flush(storage.add("new prompt", "/new", "session-xyz"));

		const byPrompt = new Map(storage.getRecent(10).map(e => [e.prompt, e.sessionId]));
		expect(byPrompt.get("legacy prompt")).toBeUndefined();
		expect(byPrompt.get("new prompt")).toBe("session-xyz");

		const verify = new Database(dbPath, { readonly: true });
		try {
			const columns = verify.prepare("PRAGMA table_info(history)").all() as Array<{ name: string }>;
			expect(columns.some(col => col.name === "session_id")).toBe(true);
		} finally {
			verify.close();
		}
	});

	it("retains each session's repeated prompt and local recency after reopening", async () => {
		const { storage, dbPath } = await freshStorage();
		await storage.add("shared prompt", "/a", "a");
		await storage.add("only alpha", "/a", "a");
		await storage.add("shared prompt", "/b", "b");
		await storage.add("only beta", "/b", "b");
		HistoryStorage.close();
		const previousMembershipSchema = new Database(dbPath);
		const columns = previousMembershipSchema.query<{ name: string }, []>("PRAGMA table_info(history_sessions)").all();
		if (columns.some(column => column.name === "journal_order")) {
			previousMembershipSchema.run("ALTER TABLE history_sessions DROP COLUMN journal_order");
		}
		previousMembershipSchema.close();
		const reopened = HistoryStorage.open(dbPath);

		expect(reopened.getRecent(10, { sessionId: "a" }).map(entry => entry.prompt)).toEqual([
			"only alpha",
			"shared prompt",
		]);
		expect(reopened.getRecent(10, { sessionId: "b" }).map(entry => entry.prompt)).toEqual([
			"only beta",
			"shared prompt",
		]);
		expect(reopened.getRecent(10).find(entry => entry.prompt === "shared prompt")).toMatchObject({
			sessionId: "b",
			useCount: 2,
		});
		expect(reopened.getRecent(10, { sessionId: "" })).toEqual([]);
	});

	it("orders recovered journal prompts across migration seeds without rewriting later submissions", async () => {
		tempDir = TempDir.createSync("@omp-history-session-mixed-seeds-");
		const dbPath = tempDir.join("history.db");
		const legacy = new Database(dbPath);
		legacy.run(`
CREATE TABLE history (
	id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL UNIQUE,
	created_at INTEGER NOT NULL, cwd TEXT, session_id TEXT, use_count INTEGER NOT NULL DEFAULT 1
);
INSERT INTO history (prompt, created_at, cwd, session_id, use_count) VALUES
	('shared', 101, '/b', 'b', 8),
	('alpha', 100, '/a', 'a', 4);
		`);
		legacy.close();
		const storage = HistoryStorage.open(dbPath);
		await storage.add("later genuine", "/a/new", "a");
		await storage.add("later genuine", "/a/new", "a");
		const sameSecond = new Database(dbPath);
		sameSecond.run("UPDATE history_sessions SET created_at = 100 WHERE prompt = 'later genuine'");
		sameSecond.close();
		const before = storage.getRecent(10);
		storage.restoreSession(
			"a",
			() => [
				{ prompt: "shared", created_at: 100 },
				{ prompt: "alpha", created_at: 100 },
				{ prompt: "later genuine", created_at: 100 },
			],
			"/a/journal",
		);
		const expected = storage.getRecent(10, { sessionId: "a" });
		expect(expected.map(entry => entry.prompt)).toEqual(["later genuine", "alpha", "shared"]);
		expect(expected[0]).toMatchObject({ cwd: "/a/new", useCount: 2 });
		expect(expected[1]).toMatchObject({ created_at: 100, cwd: "/a", useCount: 4 });
		expect(expected[2]).toMatchObject({ created_at: 100, cwd: "/a/journal", useCount: 1 });
		expect(storage.getRecent(10)).toEqual(before);
		expect(storage.search("shared", 10)[0]).toMatchObject({ sessionId: "b", useCount: 8 });
		HistoryStorage.close();
		const reopened = HistoryStorage.open(dbPath);
		expect(reopened.getRecent(10, { sessionId: "a" })).toEqual(expected);
		reopened.restoreSession("a", () => [{ prompt: "alpha", created_at: 500 }]);
		expect(reopened.getRecent(10, { sessionId: "a" })).toEqual(expected);
	});

	it("recovers overwritten pre-feature prompts once without changing shared search or raw command recall", async () => {
		const { storage, dbPath } = await freshStorage();
		await storage.add("shared old prompt", "/b", "b");
		storage.restoreSession("a", () => [
			{ prompt: "shared old prompt", created_at: 1 },
			{ prompt: "alpha only", created_at: 1 },
			{ prompt: "shared old prompt", created_at: 1 },
		]);
		expect(storage.getRecent(10, { sessionId: "a" }).map(entry => entry.prompt)).toEqual([
			"shared old prompt",
			"alpha only",
		]);
		expect(storage.search("alpha", 10)).toEqual([]);
		await storage.add("/skill:example original arguments", "/a", "a");
		HistoryStorage.close();
		const reopened = HistoryStorage.open(dbPath);
		reopened.restoreSession("a", () => [{ prompt: "expanded journal body", created_at: 2 }]);
		expect(reopened.getRecent(10, { sessionId: "a" }).map(entry => entry.prompt)).toEqual([
			"/skill:example original arguments",
			"shared old prompt",
			"alpha only",
		]);
	});
});

describe("HistoryStorage.matchingSessionIds", () => {
	it("returns matching session ids ordered by recency, de-duplicated", async () => {
		const { storage } = await freshStorage();
		await flush(
			storage.add("deploy alpha", "/r", "sess-1"),
			storage.add("deploy beta", "/r", "sess-1"),
			storage.add("deploy gamma", "/r", "sess-2"),
		);

		// Most recent matching prompt first; sess-1 appears once despite two prompts.
		expect(storage.matchingSessionIds("deploy", 100)).toEqual(["sess-2", "sess-1"]);
	});

	it("skips prompts that have no recorded session", async () => {
		const { storage } = await freshStorage();
		await flush(storage.add("orphan prompt", "/r"));

		expect(storage.matchingSessionIds("orphan", 100)).toEqual([]);
	});

	it("returns no session ids when nothing matches", async () => {
		const { storage } = await freshStorage();
		await flush(storage.add("deploy alpha", "/r", "sess-1"));

		expect(storage.matchingSessionIds("nonexistent", 100)).toEqual([]);
	});
});
