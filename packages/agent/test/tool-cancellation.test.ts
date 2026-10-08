import { expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { agentLoopContinue } from "@oh-my-pi/pi-agent-core/agent-loop";
import { SpeculativeOperationCoordinator } from "../src/speculative-execution";
import type {
	AgentContext,
	AgentEvent,
	AgentLoopConfig,
	AgentTool,
	AgentToolResult,
} from "@oh-my-pi/pi-agent-core/types";
import type { Message } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { untilAborted } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers";

it.each([
	{ callbackFails: false, steering: false },
	{ callbackFails: true, steering: false },
	{ callbackFails: false, steering: true },
])("settles abort-ignoring execution and fences late output (%j)", async ({ callbackFails, steering }) => {
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<AgentToolResult>();
	const controller = new AbortController();
	const steeringReady = Promise.withResolvers<void>();
	let steeringQueued = false;
	const parameters = type({});
	let toolSignal: AbortSignal | undefined;
	let lateUpdate: (() => void) | undefined;
	const tool: AgentTool<typeof parameters> = {
		name: "pending",
		label: "Pending",
		description: "Cancellation diagnostic",
		parameters,
		execute(_id, _args, signal, onUpdate) {
			toolSignal = signal;
			lateUpdate = () => onUpdate?.({ content: [{ type: "text", text: "late partial" }], details: {} });
			entered.resolve();
			return release.promise;
		},
	};
	const context: AgentContext = {
		systemPrompt: [],
		messages: [
			createAssistantMessage([{ type: "toolCall", id: "pending-1", name: tool.name, arguments: {} }], "toolUse"),
		],
		tools: [tool],
	};
	const mock = createMockModel({ responses: [{ content: ["must not be requested"] }] });
	const config: AgentLoopConfig = {
		model: mock.model,
		hasSteeringMessages: () => steeringQueued,
		waitForSteeringMessages: () => steeringReady.promise,
		onToolExecutionStarted: callbackFails
			? () => {
					throw new Error("ownership callback failed");
				}
			: undefined,
		convertToLlm: messages =>
			messages.filter(
				(message): message is Message =>
					message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
	};
	const events: AgentEvent[] = [];
	const stream = agentLoopContinue(context, config, controller.signal, mock.stream);
	const consumed = (async () => {
		for await (const event of stream) events.push(event);
	})();
	await entered.promise;
	if (steering) {
		steeringQueued = true;
		steeringReady.resolve();
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
	}
	controller.abort();
	try {
		// The loop couples monotonic time and timers; exercise the real cancellation boundary.
		await untilAborted(AbortSignal.timeout(750), consumed);
		expect(toolSignal?.aborted).toBe(true);
		const results = (await stream.result()).filter(message => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({
			toolCallId: "pending-1",
			isError: true,
			details: { execution: "started", outcome: "unknown" },
		});
		if (callbackFails) {
			expect(results[0]?.content).toContainEqual({ type: "text", text: "ownership callback failed" });
		}
		const eventCount = events.length;
		lateUpdate?.();
		release.resolve({ content: [{ type: "text", text: "late success" }], details: {} });
		await release.promise;
		expect(events).toHaveLength(eventCount);
		expect(events.filter(event => event.type === "tool_execution_end")).toHaveLength(1);
		expect(mock.calls).toHaveLength(0);
	} finally {
		release.resolve({ content: [], details: {} });
		await consumed;
	}
});

it.each([true, false])("owns pre-execution stream cleanup through cancellation (context: %p)", async hasContext => {
	const controller = new AbortController();
	const cleanupEntered = Promise.withResolvers<void>();
	const cleanup = Promise.withResolvers<void>();
	let streamClosed = false;
	let toolExecuted = false;
	let completion: Promise<void> | undefined;
	const parameters = type({});
	const tool: AgentTool<typeof parameters> = {
		name: "cleanup",
		label: "Cleanup",
		description: "Stream cleanup cancellation diagnostic",
		parameters,
		async execute() {
			toolExecuted = true;
			return { content: [{ type: "text", text: "committed" }], details: {} };
		},
	};
	const assistant = createAssistantMessage(
		[{ type: "toolCall", id: "cleanup-1", name: tool.name, arguments: {} }],
		"toolUse",
	);
	const coordinator = new SpeculativeOperationCoordinator({ enabled: true });
	coordinator.registerStreamSession("cleanup-1", {
		update() {},
		finalize() {},
		commit() {},
		async discard() {
			cleanupEntered.resolve();
			await cleanup.promise;
			streamClosed = true;
		},
	});
	coordinator.attach(assistant);
	const context: AgentContext = { systemPrompt: [], messages: [assistant], tools: [tool] };
	const mock = createMockModel({ responses: [{ content: ["must not be requested"] }] });
	const config: AgentLoopConfig = {
		model: mock.model,
		getToolContext: hasContext
			? () => {
					controller.abort();
					return {};
				}
			: undefined,
		onToolExecutionStarted: physical => {
			completion = physical;
		},
		convertToLlm: messages =>
			messages.filter(
				(message): message is Message =>
					message.role === "user" || message.role === "assistant" || message.role === "toolResult",
			),
	};
	const stream = agentLoopContinue(context, config, controller.signal, mock.stream);
	const consumed = (async () => {
		for await (const _event of stream) {
		}
	})();
	try {
		if (!hasContext) {
			await untilAborted(AbortSignal.timeout(750), cleanupEntered.promise);
			controller.abort();
		}
		await untilAborted(AbortSignal.timeout(750), consumed);
		let resourcesReleased = false;
		const drain = (completion ?? Promise.resolve()).then(() => {
			resourcesReleased = true;
		});
		const tick = Promise.withResolvers<void>();
		setImmediate(tick.resolve);
		await tick.promise;
		expect(resourcesReleased).toBe(false);
		expect(streamClosed).toBe(false);
		expect(toolExecuted).toBe(false);
		const results = (await stream.result()).filter(message => message.role === "toolResult");
		expect(results).toHaveLength(1);
		expect(results[0]).toMatchObject({ toolCallId: "cleanup-1", isError: true });
		expect(results[0]?.details).not.toHaveProperty("outcome", "unknown");
		cleanup.resolve();
		await drain;
		expect(resourcesReleased).toBe(true);
		expect(streamClosed).toBe(true);
		expect(toolExecuted).toBe(false);
		expect(mock.calls).toHaveLength(0);
	} finally {
		cleanup.resolve();
		await completion;
		await consumed;
	}
});
