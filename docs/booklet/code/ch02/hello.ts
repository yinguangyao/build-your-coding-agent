// ch02/hello.ts —— 流式 LLM 客户端，逐行讲解见 docs/booklet/02-streaming.md
// 跑法:
//   export PI_BASE_URL=https://api.deepseek.com
//   export PI_API_KEY=sk-...
//   export PI_MODEL=deepseek-chat
//   tsx hello.ts "解释 React Hooks 是什么"

// ────────────────────── 类型定义 ──────────────────────
type OpenAIDelta = {
	role?: "assistant";
	content?: string | null;
	tool_calls?: Array<{
		index: number;
		id?: string;
		function?: { name?: string; arguments?: string };
	}>;
};

type OpenAIChunk = {
	choices: Array<{
		index: number;
		delta: OpenAIDelta;
		finish_reason: null | "stop" | "length" | "tool_calls" | "content_filter";
	}>;
};

export type AssistantMessage = {
	role: "assistant";
	content: string;
	tool_calls: Array<{ id: string; name: string; arguments: string }>;
	finish_reason: "stop" | "length" | "tool_calls" | null;
};

// ──────────────────── SSE 字节流 → 事件块 ────────────────────
async function* readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
	const reader = body.getReader();
	const decoder = new TextDecoder("utf-8");
	let buffer = "";
	while (true) {
		const { value, done } = await reader.read();
		if (done) {
			buffer += decoder.decode();
			if (buffer.length > 0) yield buffer;
			return;
		}
		buffer += decoder.decode(value, { stream: true });
		let boundary;
		while ((boundary = buffer.indexOf("\n\n")) !== -1) {
			const raw = buffer.slice(0, boundary);
			buffer = buffer.slice(boundary + 2);
			yield raw;
		}
	}
}

// ──────────────────── 事件块 → 结构化 chunk ────────────────────
function parseSSEEvent(raw: string): OpenAIChunk | "done" | null {
	let dataPart = "";
	for (const line of raw.split("\n")) {
		if (line.startsWith("data:")) {
			dataPart += line.slice(line[5] === " " ? 6 : 5);
		}
	}
	if (!dataPart) return null;
	if (dataPart === "[DONE]") return "done";
	try {
		return JSON.parse(dataPart) as OpenAIChunk;
	} catch {
		return null;
	}
}

// ──────────────────── streamOpenAI: 返回 AsyncIterable ────────────────────
export async function* streamOpenAI(req: {
	baseUrl: string;
	apiKey: string;
	model: string;
	messages: any[];
	tools?: any[];
}): AsyncIterable<{ delta?: string; done?: AssistantMessage }> {
	const resp = await fetch(`${req.baseUrl}/chat/completions`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			Authorization: `Bearer ${req.apiKey}`,
		},
		body: JSON.stringify({
			model: req.model,
			messages: req.messages,
			tools: req.tools,
			stream: true,
		}),
	});
	if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
	if (!resp.body) throw new Error("无响应体");

	const acc: AssistantMessage = {
		role: "assistant",
		content: "",
		tool_calls: [],
		finish_reason: null,
	};

	for await (const raw of readSSE(resp.body)) {
		const parsed = parseSSEEvent(raw);
		if (parsed === null) continue;
		if (parsed === "done") break;

		const choice = parsed.choices?.[0];
		if (!choice) continue;
		const delta = choice.delta;

		if (typeof delta.content === "string" && delta.content.length > 0) {
			acc.content += delta.content;
			yield { delta: delta.content };
		}

		if (delta.tool_calls) {
			for (const tc of delta.tool_calls) {
				const slot = (acc.tool_calls[tc.index] ??= {
					id: "",
					name: "",
					arguments: "",
				});
				if (tc.id) slot.id = tc.id;
				if (tc.function?.name) slot.name = tc.function.name;
				if (tc.function?.arguments) slot.arguments += tc.function.arguments;
			}
		}

		if (choice.finish_reason) {
			acc.finish_reason = choice.finish_reason as any;
		}
	}

	yield { done: acc };
}

// ──────────────────── 主流程：把流式输出打出来 ────────────────────
// 用 main-module 守卫包起来：直接 `tsx hello.ts` 跑才执行；
// 被别的章节 import streamOpenAI 时不会自动触发这段 demo。
if (import.meta.url === `file://${process.argv[1]}`) {
	const baseUrl = process.env.PI_BASE_URL;
	const apiKey = process.env.PI_API_KEY;
	const model = process.env.PI_MODEL;
	if (!baseUrl || !apiKey || !model) {
		console.error("请设置 PI_BASE_URL / PI_API_KEY / PI_MODEL 环境变量");
		process.exit(1);
	}
	const userInput = process.argv.slice(2).join(" ").trim();
	if (!userInput) {
		console.error("用法: tsx hello.ts <你的问题>");
		process.exit(1);
	}

	const messages = [
		{ role: "system", content: "你是一个简明的中文助手。" },
		{ role: "user", content: userInput },
	];

	let finalMessage: AssistantMessage | undefined;
	for await (const ev of streamOpenAI({ baseUrl, apiKey, model, messages })) {
		if (ev.delta) process.stdout.write(ev.delta);
		if (ev.done) finalMessage = ev.done;
	}
	if (finalMessage) {
		console.log(`\n--- (finish_reason: ${finalMessage.finish_reason}) ---`);
	}
}
