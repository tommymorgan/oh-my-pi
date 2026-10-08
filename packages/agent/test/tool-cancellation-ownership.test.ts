import { afterEach, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, AgentBusyError } from "@oh-my-pi/pi-agent-core";
import type { AgentEvent, AgentTool, AgentToolExecFn, AgentToolResult } from "@oh-my-pi/pi-agent-core/types";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

const parameters = type({});
const success: AgentToolResult = { content: [{ type: "text", text: "operation committed" }], details: {} };

function makeTool(execute: AgentToolExecFn<typeof parameters>): AgentTool<typeof parameters> {
	return { name: "operation", label: "Operation", description: "Ownership diagnostic", parameters, execute };
}

async function nextTurn(): Promise<void> {
	const tick = Promise.withResolvers<void>();
	setImmediate(tick.resolve);
	await tick.promise;
}

it("does not dispatch a provider continuation after cancelling an ordinary in-flight tool", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<AgentToolResult>();
	const tool = makeTool(() => {
		entered.resolve();
		return release.promise;
	});
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "operation-1", name: tool.name, arguments: {} }] },
			{ content: ["must not dispatch"] },
		],
	});
	const agent = new Agent({ initialState: { model: mock.model, tools: [tool] }, streamFn: mock.stream });
	const running = agent.prompt("start");
	await entered.promise;
	// Live Agent integrates wall-clock abort grace with monotonic scheduler waits;
	// global fake timers cannot drive both clocks consistently.
	try {
		agent.abort();
		await running;
		expect(mock.calls).toHaveLength(1);
		expect(agent.state.messages.filter(message => message.role === "toolResult")).toMatchObject([
			{ toolCallId: "operation-1", isError: true, details: { outcome: "unknown" } },
		]);
	} finally {
		vi.useRealTimers();
		release.resolve(success);
		await running;
		await agent.waitForToolExecutions();
	}
});

it("holds resource drains and refuses successor runs until a cancelled physical execution rejects", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<AgentToolResult>();
	const tool = makeTool(() => {
		entered.resolve();
		return release.promise;
	});
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "operation-1", name: tool.name, arguments: {} }] },
			{ content: ["next run"] },
		],
	});
	const agent = new Agent({ initialState: { model: mock.model, tools: [tool] }, streamFn: mock.stream });
	const events: AgentEvent[] = [];
	agent.subscribe(event => events.push(event));
	const running = agent.prompt("start");
	await entered.promise;
	try {
		agent.abort();
		let resourcesReleased = false;
		const drain = agent.waitForToolExecutions().then(() => {
			resourcesReleased = true;
		});
		await nextTurn();
		expect(resourcesReleased).toBe(false);
		await running;
		await expect(agent.prompt("must not overlap")).rejects.toBeInstanceOf(AgentBusyError);
		await expect(agent.continue()).rejects.toBeInstanceOf(AgentBusyError);
		const eventCount = events.length;
		release.reject(new Error("physical execution failed after cancellation"));
		await drain;
		expect(resourcesReleased).toBe(true);
		expect(events).toHaveLength(eventCount);
		expect(events.filter(event => event.type === "tool_execution_end")).toHaveLength(1);
		await agent.prompt("safe successor");
		expect(mock.calls).toHaveLength(2);
	} finally {
		vi.useRealTimers();
		release.resolve(success);
		await running;
		await agent.waitForToolExecutions();
	}
});

it("waits for cooperative abort cleanup and preserves its committed result within the cancellation grace", async () => {
	const entered = Promise.withResolvers<void>();
	const abortObserved = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	const tool = makeTool(async (_id, _args, signal) => {
		if (!signal) throw new Error("Expected execution signal");
		signal.addEventListener("abort", () => abortObserved.resolve(), { once: true });
		entered.resolve();
		await abortObserved.promise;
		await cleanup.promise;
		return success;
	});
	const mock = createMockModel({
		responses: [{ content: [{ type: "toolCall", id: "operation-1", name: tool.name, arguments: {} }] }],
	});
	const agent = new Agent({ initialState: { model: mock.model, tools: [tool] }, streamFn: mock.stream });
	const running = agent.prompt("start");
	await entered.promise;
	try {
		agent.abort();
		await abortObserved.promise;
		let settled = false;
		void running.then(() => {
			settled = true;
		});
		await nextTurn();
		expect(settled).toBe(false);
		cleanup.resolve();
		await running;
		expect(agent.state.messages.filter(message => message.role === "toolResult")).toMatchObject([
			{ content: success.content, isError: false },
		]);
		await agent.waitForToolExecutions();
	} finally {
		vi.useRealTimers();
		cleanup.resolve();
		await running;
	}
});

it("allows a long-running tool to commit normally without a runtime deadline", async () => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<AgentToolResult>();
	const tool = makeTool(() => {
		entered.resolve();
		return release.promise;
	});
	const mock = createMockModel({
		responses: [
			{ content: [{ type: "toolCall", id: "operation-1", name: tool.name, arguments: {} }] },
			{ content: ["finished"] },
		],
	});
	const agent = new Agent({ initialState: { model: mock.model, tools: [tool] }, streamFn: mock.stream });
	const events: AgentEvent[] = [];
	agent.subscribe(event => events.push(event));
	const running = agent.prompt("start");
	await entered.promise;
	vi.useFakeTimers();
	try {
		vi.advanceTimersByTime(60_000);
		await nextTurn();
		expect(events.filter(event => event.type === "tool_execution_end")).toHaveLength(0);
		vi.useRealTimers();
		release.resolve(success);
		await running;
		expect(agent.state.messages.filter(message => message.role === "toolResult")).toMatchObject([
			{ content: success.content, isError: false },
		]);
		expect(mock.calls).toHaveLength(2);
	} finally {
		vi.useRealTimers();
		release.resolve(success);
		await running;
	}
});
