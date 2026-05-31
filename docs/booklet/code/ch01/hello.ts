// ch01/hello.ts —— 最简 LLM 客户端，不流式、不带工具。
// 跑法:
//   export PI_BASE_URL=https://api.deepseek.com/v1   # base_url 含版本前缀；代码只拼 /chat/completions
//   export PI_API_KEY=sk-...
//   export PI_MODEL=deepseek-chat
//   tsx hello.ts "用一句话介绍二分搜索"
// 切其他厂商只改 base_url 的前缀，例如火山方舟用 https://ark.cn-beijing.volces.com/api/v3

const baseUrl = process.env.PI_BASE_URL;
const apiKey  = process.env.PI_API_KEY;
const model   = process.env.PI_MODEL;

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
	{ role: "system", content: "你是一个简明扼要的中文助手，回答控制在两句话以内。" },
	{ role: "user", content: userInput },
];

const resp = await fetch(`${baseUrl}/chat/completions`, {
	method: "POST",
	headers: {
		"Content-Type": "application/json",
		Authorization: `Bearer ${apiKey}`,
	},
	body: JSON.stringify({
		model,
		messages,
		temperature: 0.2,
	}),
});

if (!resp.ok) {
	const errBody = await resp.text();
	console.error(`HTTP ${resp.status}: ${errBody}`);
	process.exit(1);
}

const data = await resp.json();
const choice = data.choices[0];
const reply = choice.message.content;

console.log(reply);
console.log(
	`\n--- (finish_reason: ${choice.finish_reason}, ` +
		`tokens: ${data.usage?.prompt_tokens} in / ${data.usage?.completion_tokens} out) ---`,
);
