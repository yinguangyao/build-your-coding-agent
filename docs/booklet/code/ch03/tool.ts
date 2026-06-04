// ch03/tool.ts —— 一次完整的「模型 → 工具 → 模型」往返。逐段讲解见 docs/booklet/03-first-tool.md
// 跑法（先 export PI_BASE_URL/PI_API_KEY/PI_MODEL，并在 docs/booklet/code 下装好 typebox）:
//   tsx tool.ts "现在几点？"

import { Type } from "typebox";
import { streamOpenAI, type AssistantMessage } from "../ch02/hello.js";

type Tool = {
	name: string;
	description: string;
	parameters: any;
	execute: (args: any) => Promise<string>;
};

const tools: Tool[] = [
	{
		name: "current_time",
		description: "返回当前本地时间（ISO 8601）。无参数。",
		parameters: Type.Object({}),
		execute: async () => new Date().toISOString(),
	},
	{
		name: "read_file",
		description: "读取本地文件内容（UTF-8）。",
		parameters: Type.Object({
			path: Type.String({ description: "文件路径" }),
		}),
		execute: async (args: { path: string }) => {
			const fs = await import("node:fs/promises");
			return await fs.readFile(args.path, "utf-8");
		},
	},
];

function buildToolsParam(tools: Tool[]) {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
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

const baseUrl = process.env.PI_BASE_URL;
const apiKey = process.env.PI_API_KEY;
const model = process.env.PI_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请设置 PI_BASE_URL / PI_API_KEY / PI_MODEL");
	process.exit(1);
}
const userInput = process.argv.slice(2).join(" ").trim();
if (!userInput) {
	console.error("用法: tsx tool.ts <你的问题>");
	process.exit(1);
}

const messages: any[] = [
	{ role: "system", content: "你是一个能调用工具的中文助手。回答简短，必要时调用工具。" },
	{ role: "user", content: userInput },
];

// ── 第一轮：让模型决定调不调工具 ──
let assistant1: AssistantMessage | undefined;
for await (const ev of streamOpenAI({
	baseUrl,
	apiKey,
	model,
	messages,
	tools: buildToolsParam(tools),
})) {
	if (ev.delta) process.stdout.write(ev.delta);
	if (ev.done) assistant1 = ev.done;
}
console.log();
if (!assistant1) throw new Error("无响应");

messages.push(toOpenAIAssistantMsg(assistant1));

if (assistant1.tool_calls.length === 0) {
	process.exit(0);
}

// ── 执行所有 tool_calls ──
for (const tc of assistant1.tool_calls) {
	const tool = tools.find((t) => t.name === tc.name);
	let result: string;
	if (!tool) {
		result = `Tool "${tc.name}" not found`;
	} else {
		try {
			const args = JSON.parse(tc.arguments || "{}");
			console.log(`[工具] ${tc.name}(${tc.arguments})`);
			result = await tool.execute(args);
		} catch (err: any) {
			result = `Error: ${err.message}`;
		}
	}
	messages.push({ role: "tool", tool_call_id: tc.id, content: result.slice(0, 4000) });
}

// ── 第二轮：基于工具结果给最终答复 ──
console.log("[模型]");
for await (const ev of streamOpenAI({
	baseUrl,
	apiKey,
	model,
	messages,
	tools: buildToolsParam(tools),
})) {
	if (ev.delta) process.stdout.write(ev.delta);
}
console.log();
