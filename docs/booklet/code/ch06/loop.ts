// ch06/loop.ts —— 在 ch04 循环基础上加并行工具执行。
// 按 pi 的 agent-loop.ts:executeToolCallsParallel 改的精简版：
//   - prepare 阶段串行（钩子有副作用 + 校验快）
//   - execute 阶段并行 (Promise.all)
//   - 任一工具 executionMode === "sequential" 就整批降级串行
//   - 事件按完成顺序，messages 按源顺序

import { streamOpenAI, type AssistantMessage } from "../ch02/hello.js";
import { type Tool, buildToolsParam } from "../ch04/tools.js";

type ToolCall = { id: string; name: string; arguments: string };
type ToolResultMessage = { role: "tool"; tool_call_id: string; content: string };
type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: any[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_delta"; delta: string }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_end"; toolCallId: string; result: string; isError: boolean };
type EventSink = (event: AgentEvent) => Promise<void> | void;

// ──────────────────── 让 Tool 类型支持 executionMode ────────────────────
export type RuntimeTool = Tool & { executionMode?: "sequential" | "parallel" };

function parseArgs(s: string): any {
	try {
		return JSON.parse(s || "{}");
	} catch {
		return {};
	}
}

// ──────────────────── streamOnce（同 ch04） ────────────────────
async function streamOnce(
	opts: { baseUrl: string; apiKey: string; model: string; tools: Tool[] },
	messages: any[],
	emit: EventSink,
): Promise<AssistantMessage> {
	let finalMessage: AssistantMessage | undefined;
	for await (const ev of streamOpenAI({
		baseUrl: opts.baseUrl,
		apiKey: opts.apiKey,
		model: opts.model,
		messages,
		tools: buildToolsParam(opts.tools),
	})) {
		if (ev.delta) await emit({ type: "message_delta", delta: ev.delta });
		if (ev.done) finalMessage = ev.done;
	}
	if (!finalMessage) throw new Error("流结束但没拿到完整消息");
	return finalMessage;
}

// ──────────────────── 批是否要降级串行 ────────────────────
function batchIsSequential(toolCalls: ToolCall[], tools: RuntimeTool[]): boolean {
	return toolCalls.some((tc) => tools.find((t) => t.name === tc.name)?.executionMode === "sequential");
}

// ──────────────────── 串行批 ────────────────────
type ResultEntry = {
	tc: ToolCall;
	text: string;
	isError: boolean;
	terminate: boolean;
};

async function runOne(tool: RuntimeTool | undefined, tc: ToolCall): Promise<ResultEntry> {
	if (!tool) {
		return { tc, text: `Tool "${tc.name}" not found`, isError: true, terminate: false };
	}
	const args = parseArgs(tc.arguments);
	try {
		const out: any = await tool.execute(args);
		// 简化协议：工具可返回 string 或 { text, terminate? }
		if (typeof out === "string") return { tc, text: out, isError: false, terminate: false };
		return { tc, text: out.text ?? "", isError: false, terminate: !!out.terminate };
	} catch (err: any) {
		return { tc, text: `Error: ${err?.message ?? String(err)}`, isError: true, terminate: false };
	}
}

async function executeBatchSequential(
	toolCalls: ToolCall[],
	tools: RuntimeTool[],
	emit: EventSink,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
	const results: ResultEntry[] = [];
	for (const tc of toolCalls) {
		const tool = tools.find((t) => t.name === tc.name);
		await emit({
			type: "tool_execution_start",
			toolCallId: tc.id,
			toolName: tc.name,
			args: parseArgs(tc.arguments),
		});
		const r = await runOne(tool, tc);
		await emit({
			type: "tool_execution_end",
			toolCallId: tc.id,
			result: r.text,
			isError: r.isError,
		});
		results.push(r);
	}
	const messages = results.map((r) => ({
		role: "tool" as const,
		tool_call_id: r.tc.id,
		content: r.text.slice(0, 4000),
	}));
	const terminate = results.length > 0 && results.every((r) => r.terminate);
	return { messages, terminate };
}

// ──────────────────── 并行批 ────────────────────
async function executeBatchParallel(
	toolCalls: ToolCall[],
	tools: RuntimeTool[],
	emit: EventSink,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
	type Entry = ResultEntry | (() => Promise<ResultEntry>);
	const entries: Entry[] = [];

	// 阶段 A: 串行 prepare（这里包括发 start 事件 + 校验找工具）
	for (const tc of toolCalls) {
		await emit({
			type: "tool_execution_start",
			toolCallId: tc.id,
			toolName: tc.name,
			args: parseArgs(tc.arguments),
		});
		const tool = tools.find((t) => t.name === tc.name);
		if (!tool) {
			const r: ResultEntry = {
				tc,
				text: `Tool "${tc.name}" not found`,
				isError: true,
				terminate: false,
			};
			await emit({ type: "tool_execution_end", toolCallId: tc.id, result: r.text, isError: true });
			entries.push(r);
			continue;
		}
		entries.push(async () => {
			const r = await runOne(tool, tc);
			await emit({
				type: "tool_execution_end",
				toolCallId: tc.id,
				result: r.text,
				isError: r.isError,
			});
			return r;
		});
	}

	// 阶段 B: 并行 execute
	const finalized = await Promise.all(
		entries.map((e) => (typeof e === "function" ? e() : Promise.resolve(e))),
	);

	// 阶段 C: 按源顺序生成 tool result messages
	const messages = finalized.map((f) => ({
		role: "tool" as const,
		tool_call_id: f.tc.id,
		content: f.text.slice(0, 4000),
	}));
	const terminate = finalized.length > 0 && finalized.every((f) => f.terminate);
	return { messages, terminate };
}

// ──────────────────── 主循环 ────────────────────
export async function runAgentLoop(opts: {
	baseUrl: string;
	apiKey: string;
	model: string;
	systemPrompt: string;
	userInput: string;
	tools: RuntimeTool[];
	maxTurns?: number;
	emit?: EventSink;
}) {
	const messages: any[] = [
		{ role: "system", content: opts.systemPrompt },
		{ role: "user", content: opts.userInput },
	];
	const emit = opts.emit ?? (() => {});
	const maxTurns = opts.maxTurns ?? 25;

	await emit({ type: "agent_start" });

	let turn = 0;
	while (turn < maxTurns) {
		turn++;
		await emit({ type: "turn_start" });

		const assistant = await streamOnce(opts, messages, emit);

		// 同 ch04：先判截断，被 max_tokens 切断的消息可能残缺，不能继续
		if (assistant.finish_reason === "length") {
			throw new Error("模型输出被 max_tokens 截断（finish_reason=length）");
		}

		messages.push(toOpenAIAssistantMsg(assistant));

		if (assistant.tool_calls.length === 0) {
			await emit({ type: "turn_end" });
			break;
		}

		const sequential = batchIsSequential(assistant.tool_calls, opts.tools);
		const batch = sequential
			? await executeBatchSequential(assistant.tool_calls, opts.tools, emit)
			: await executeBatchParallel(assistant.tool_calls, opts.tools, emit);

		for (const m of batch.messages) messages.push(m);
		await emit({ type: "turn_end" });

		if (batch.terminate) break;
	}

	await emit({ type: "agent_end", messages });
	return messages;
}

function toOpenAIAssistantMsg(m: AssistantMessage) {
	return {
		role: "assistant",
		content: m.content || null,
		tool_calls:
			m.tool_calls.length > 0
				? m.tool_calls.map((tc) => ({
						id: tc.id,
						type: "function" as const,
						function: { name: tc.name, arguments: tc.arguments },
					}))
				: undefined,
	};
}

// ──────────────────── 入口 ────────────────────
// main-module 守卫：直接 `npx tsx ch06/loop.ts "<任务>"` 才执行；被 import 时不触发。
// 用 ch05 的真实工具，并按 6.9 节给有副作用的工具打上 sequential 标签。
if (import.meta.url === `file://${process.argv[1]}`) {
	const { makeCodingTools } = await import("../ch05/tools.js");
	const { consoleEmit } = await import("../ch04/loop.js");

	const baseUrl = process.env.PI_BASE_URL;
	const apiKey = process.env.PI_API_KEY;
	const model = process.env.PI_MODEL;
	if (!baseUrl || !apiKey || !model) {
		console.error("请设置 PI_BASE_URL / PI_API_KEY / PI_MODEL");
		process.exit(1);
	}
	const userInput = process.argv.slice(2).join(" ").trim();
	if (!userInput) {
		console.error('用法: npx tsx ch06/loop.ts "<任务>"');
		process.exit(1);
	}

	const tools = makeCodingTools(process.cwd()) as RuntimeTool[];
	for (const t of tools) {
		t.executionMode = t.name === "read" ? "parallel" : "sequential";
	}

	await runAgentLoop({
		baseUrl,
		apiKey,
		model,
		systemPrompt: `你是一个能调用 read/bash/edit/write 工具的中文编码助手。可以一次发起多个工具调用。回答简短。`,
		userInput,
		tools,
		emit: consoleEmit,
	});
}
