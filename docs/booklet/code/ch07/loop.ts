// ch07/loop.ts —— 把技能接进循环：ch04 的循环 + ch05 的工具 + 本章的技能清单。
// 跑法（先 export PI_BASE_URL/PI_API_KEY/PI_MODEL）：
//   npx tsx ch07/loop.ts "帮我发个版"
// 模型会在 system prompt 里看到 demo-skills 的清单，自己 read 技能全文、
// 再用 bash 执行技能自带的脚本——技能脚本没有独立运行时，执行复用 bash 工具。

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runAgentLoop, consoleEmit } from "../ch04/loop.js";
import { makeCodingTools } from "../ch05/tools.js";
import { loadSkills, formatSkillsForPrompt } from "./skills.js";

const baseUrl = process.env.PI_BASE_URL;
const apiKey = process.env.PI_API_KEY;
const model = process.env.PI_MODEL;
if (!baseUrl || !apiKey || !model) {
	console.error("请设置 PI_BASE_URL / PI_API_KEY / PI_MODEL");
	process.exit(1);
}
const userInput = process.argv.slice(2).join(" ").trim();
if (!userInput) {
	console.error('用法: npx tsx ch07/loop.ts "<任务>"');
	process.exit(1);
}

// 技能清单拼进 system prompt（demo-skills 跟着本文件走，工作目录随便在哪）
const here = dirname(fileURLToPath(import.meta.url));
const skills = loadSkills(join(here, "demo-skills"));

const SYSTEM =
	`你是一个能调用 read/bash/edit/write 工具的中文编码助手。回答简短。` +
	formatSkillsForPrompt(skills);

await runAgentLoop({
	baseUrl,
	apiKey,
	model,
	systemPrompt: SYSTEM,
	userInput,
	tools: makeCodingTools(process.cwd()),
	emit: consoleEmit,
});
