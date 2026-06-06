// ch04/loop.ts —— ReAct 循环，逐段讲解见 docs/booklet/04-react-loop.md
//
// 跑法（先 export PI_BASE_URL/PI_API_KEY/PI_MODEL）：
//   tsx loop.ts "现在几点，然后告诉我 README.md 第一行是什么"

import { streamOpenAI, type AssistantMessage } from "../ch02/hello.js";
import { type Tool, buildToolsParam, tools } from "./tools.js";

// ──────────────────── 事件 ────────────────────
type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end"; messages: any[] }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_delta"; delta: string }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
	| { type: "tool_execution_end"; toolCallId: string; result: string; isError: boolean };

type EventSink = (event: AgentEvent) => Promise<void> | void;

// ──────────────────── 单次调一遍模型，收集 delta ────────────────────
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
		if (ev.delta) {
			await emit({ type: "message_delta", delta: ev.delta });
		}
		if (ev.done) {
			finalMessage = ev.done;
		}
	}
	if (!finalMessage) throw new Error("流结束但没拿到完整消息");
	return finalMessage;
}

// ──────────────────── 串行执行一个 tool_call ────────────────────
async function executeOne(
	tools: Tool[],
	tc: { id: string; name: string; arguments: string },
	emit: EventSink,
): Promise<{ text: string; isError: boolean }> {
	const tool = tools.find((t) => t.name === tc.name);
	let args: any = {};
	try {
		args = JSON.parse(tc.arguments || "{}");
	} catch {}

	await emit({
		type: "tool_execution_start",
		toolCallId: tc.id,
		toolName: tc.name,
		args,
	});

	let text: string;
	let isError = false;
	if (!tool) {
		text = `Tool "${tc.name}" not found`;
		isError = true;
	} else {
		try {
			text = await tool.execute(args);
		} catch (err: any) {
			text = `Error: ${err?.message ?? String(err)}`;
			isError = true;
		}
	}

	await emit({
		type: "tool_execution_end",
		toolCallId: tc.id,
		result: text,
		isError,
	});
	return { text, isError };
}

// ──────────────────── 主循环 ────────────────────
export async function runAgentLoop(opts: {
	baseUrl: string;
	apiKey: string;
	model: string;
	systemPrompt: string;
	userInput: string;
	tools: Tool[];
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

		// 先判截断：被 max_tokens 截断的消息可能残缺（甚至 tool_call 拼了一半），
		// 不能 push 进去当正常结果继续，否则会静默退出或发出坏的 tool_call。
		if (assistant.finish_reason === "length") {
			throw new Error("模型输出被 max_tokens 截断（finish_reason=length）");
		}

		messages.push(toOpenAIAssistantMsg(assistant));

		if (assistant.tool_calls.length === 0) {
			await emit({ type: "turn_end" });
			break;
		}

		for (const tc of assistant.tool_calls) {
			const result = await executeOne(opts.tools, tc, emit);
			messages.push({
				role: "tool",
				tool_call_id: tc.id,
				content: result.text.slice(0, 4000),
			});
		}

		await emit({ type: "turn_end" });
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
const baseUrl = process.env.PI_BASE_URL;
const apiKey = process.env.PI_API_KEY;
const model = process.env.PI_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请设置 PI_BASE_URL / PI_API_KEY / PI_MODEL");
	process.exit(1);
}
const userInput = process.argv.slice(2).join(" ").trim();
if (!userInput) {
	console.error("用法: tsx loop.ts <问题>");
	process.exit(1);
}

const SYSTEM = `你是一个能调用工具的中文助手。当用户要查文件或跑命令时，请调用合适的工具。回答简短。`;

await runAgentLoop({
	baseUrl,
	apiKey,
	model,
	systemPrompt: SYSTEM,
	userInput,
	tools,
	emit: async (ev) => {
		switch (ev.type) {
			case "agent_start":
				console.log("[start]");
				break;
			case "agent_end":
				console.log("\n[end]");
				break;
			case "turn_start":
				process.stdout.write(`\n[turn] `);
				break;
			case "turn_end":
				break;
			case "message_delta":
				process.stdout.write(ev.delta);
				break;
			case "tool_execution_start":
				process.stdout.write(`\n[tool] ${ev.toolName}(${JSON.stringify(ev.args)})`);
				break;
			case "tool_execution_end":
				process.stdout.write(`\n[result] ${ev.result.slice(0, 200).replace(/\n/g, "\\n")}`);
				break;
		}
	},
});
