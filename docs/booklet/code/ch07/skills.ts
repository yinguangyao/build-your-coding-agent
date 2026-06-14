// ch07/skills.ts —— 第 7 章 mini skill 系统：扫目录 + 拼清单（路径 A）+ /skill: 注入（路径 B）。
// 离线可跑（不需要 API key）：
//   npx tsx ch07/skills.ts
// 会扫描 ./demo-skills/ 里的两个示例技能，打印进 system prompt 的 <available_skills> 清单，
// 再演示 /skill:release 的全文注入。

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface MiniSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
}

// ───────── 极简 frontmatter 解析（只认 --- 包起来的 key: value） ─────────
export function parseFrontmatter(raw: string): { fm: Record<string, string>; body: string } {
	const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
	if (!m) return { fm: {}, body: raw };
	const fm: Record<string, string> = {};
	for (const line of m[1].split("\n")) {
		const i = line.indexOf(":");
		if (i > 0) fm[line.slice(0, i).trim()] = line.slice(i + 1).trim();
	}
	return { fm, body: raw.slice(m[0].length) };
}

// ───────── 加载：目录里有 SKILL.md 当一个 skill，否则收根层 .md（简化版，不递归） ─────────
export function loadSkills(dir: string): MiniSkill[] {
	if (!existsSync(dir)) return [];
	const out: MiniSkill[] = [];
	for (const name of readdirSync(dir)) {
		const sub = join(dir, name);
		const file = existsSync(join(sub, "SKILL.md"))
			? join(sub, "SKILL.md")
			: name.endsWith(".md")
				? sub
				: null;
		if (!file) continue;
		const { fm } = parseFrontmatter(readFileSync(file, "utf-8"));
		if (!fm.description) continue; // description 必填，缺了直接丢（7.2）
		out.push({
			// name 兜底是"父目录名"——对单文件 skill 这会退化成 skills 目录名，所以单文件必须显式写 name（7.3）
			name: fm.name ?? name.replace(/\.md$/, ""),
			description: fm.description,
			filePath: file,
			baseDir: dirname(file),
		});
	}
	return out;
}

// ───────── 路径 A：拼进 system prompt 的清单（progressive disclosure，7.4） ─────────
export function formatSkillsForPrompt(skills: MiniSkill[]): string {
	if (!skills.length) return "";
	const items = skills
		.map(
			(s) =>
				`  <skill>\n    <name>${s.name}</name>\n` +
				`    <description>${s.description}</description>\n` +
				`    <location>${s.filePath}</location>\n  </skill>`,
		)
		.join("\n");
	return (
		`\n\nThe following skills provide specialized instructions for specific tasks.\n` +
		`Use the read tool to load a skill's file when the task matches its description.\n` +
		`<available_skills>\n${items}\n</available_skills>`
	);
}

// ───────── 路径 B：/skill:name 直接注入全文（7.5） ─────────
export function expandSkillCommand(text: string, skills: MiniSkill[]): string {
	if (!text.startsWith("/skill:")) return text;
	const space = text.indexOf(" ");
	const name = space === -1 ? text.slice(7) : text.slice(7, space);
	const args = space === -1 ? "" : text.slice(space + 1).trim();
	const skill = skills.find((s) => s.name === name);
	if (!skill) return text;
	const { body } = parseFrontmatter(readFileSync(skill.filePath, "utf-8"));
	const block =
		`<skill name="${skill.name}" location="${skill.filePath}">\n` +
		`References are relative to ${skill.baseDir}.\n\n${body.trim()}\n</skill>`;
	return args ? `${block}\n\n${args}` : block;
}

// ───────── demo ─────────
if (import.meta.url === `file://${process.argv[1]}`) {
	const here = dirname(fileURLToPath(import.meta.url));
	const skills = loadSkills(join(here, "demo-skills"));

	console.log("== 加载到的技能 ==");
	for (const s of skills) console.log(`- ${s.name}: ${s.description}`);

	console.log("\n== 路径 A：进 system prompt 的清单（模型看 description，自己 read location）==");
	console.log(formatSkillsForPrompt(skills));

	console.log("\n== 路径 B：用户敲 /skill:release，全文直接注入 ==");
	console.log(expandSkillCommand("/skill:release 这次发个 patch 版本", skills));
}
