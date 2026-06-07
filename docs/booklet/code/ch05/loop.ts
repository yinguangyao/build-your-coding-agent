// ch05/loop.ts —— 第 4 章的循环原封不动，只把玩具工具换成本章的真实 read/bash/edit/write。
// 跑法（先 export PI_BASE_URL/PI_API_KEY/PI_MODEL）：
//   npx tsx ch05/loop.ts "把 README 里的安装命令从 npm 换成 pnpm"
//
// ⚠️ 工具会真实读写当前目录、执行任意 shell 命令——请在可信目录/容器里跑。

import { runAgentLoop, consoleEmit } from "../ch04/loop.js";
import { makeCodingTools } from "./tools.js";

const baseUrl = process.env.PI_BASE_URL;
const apiKey = process.env.PI_API_KEY;
const model = process.env.PI_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请设置 PI_BASE_URL / PI_API_KEY / PI_MODEL");
	process.exit(1);
}
const userInput = process.argv.slice(2).join(" ").trim();
if (!userInput) {
	console.error('用法: npx tsx ch05/loop.ts "<任务>"');
	process.exit(1);
}

const SYSTEM = `你是一个能调用 read/bash/edit/write 工具的中文编码助手。改文件前先 read 确认内容，改完可以自查。回答简短。`;

await runAgentLoop({
	baseUrl,
	apiKey,
	model,
	systemPrompt: SYSTEM,
	userInput,
	tools: makeCodingTools(process.cwd()),
	emit: consoleEmit,
});
