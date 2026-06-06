// ch04/tools.ts —— 第 3 章定义的工具，搬过来给第 4 章用。
import { Type } from "typebox";

export type Tool = {
	name: string;
	description: string;
	parameters: any;
	execute: (args: any) => Promise<string>;
};

export const tools: Tool[] = [
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
	{
		name: "bash",
		description: "执行一条 bash 命令并返回 stdout+stderr。",
		parameters: Type.Object({
			command: Type.String({ description: "命令" }),
		}),
		execute: async (args: { command: string }) => {
			const { exec } = await import("node:child_process");
			return await new Promise<string>((resolve) => {
				exec(args.command, { timeout: 10_000 }, (err, stdout, stderr) => {
					const out = (stdout || "") + (stderr || "");
					if (err) resolve(`exit ${err.code ?? "?"}\n${out}`);
					else resolve(out || "(no output)");
				});
			});
		},
	},
];

export function buildToolsParam(tools: Tool[]) {
	return tools.map((t) => ({
		type: "function" as const,
		function: {
			name: t.name,
			description: t.description,
			parameters: t.parameters,
		},
	}));
}
