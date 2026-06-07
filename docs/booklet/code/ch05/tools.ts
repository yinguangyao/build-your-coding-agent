// ch05/tools.ts —— pi 真实 read/bash/edit/write 的简化版，能跟 ch04 runAgentLoop 配套跑。
// 故意省略：TUI 渲染、图片处理、fuzzy match、temp file 落盘、节流 onUpdate。
// 保留：路径解析、行+字节双截断、BOM/CRLF、edit 唯一性 + 多 edits、文件级 mutation queue。

import { resolve as resolvePath, isAbsolute, dirname } from "node:path";
import { access, mkdir, readFile, writeFile, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { Type } from "typebox";
import type { Tool } from "../ch04/tools.js";

const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

// ──────────────────── path-utils ────────────────────
function resolveToCwd(p: string, cwd: string): string {
	if (p.startsWith("@")) p = p.slice(1);
	return isAbsolute(p) ? resolvePath(p) : resolvePath(cwd, p);
}

// ──────────────────── 双限制截断 ────────────────────
type TruncationInfo = {
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	outputLines: number;
	// 首行单独一行就超过字节上限：此时按行切没有意义（outputLines 会变成 0），
	// 必须特殊处理，否则会给模型一个 "Use offset=1" 的死循环提示。
	firstLineExceedsLimit: boolean;
};

function truncateHead(content: string): { content: string; info: TruncationInfo } {
	const lines = content.split("\n");
	const totalLines = lines.length;
	let outputLines = totalLines;
	let truncatedBy: TruncationInfo["truncatedBy"] = null;

	if (totalLines > DEFAULT_MAX_LINES) {
		outputLines = DEFAULT_MAX_LINES;
		truncatedBy = "lines";
	}
	let result = lines.slice(0, outputLines).join("\n");
	if (Buffer.byteLength(result, "utf-8") > DEFAULT_MAX_BYTES) {
		// 按字节截到合适行数
		let lo = 0;
		let hi = outputLines;
		while (lo + 1 < hi) {
			const mid = Math.floor((lo + hi) / 2);
			if (Buffer.byteLength(lines.slice(0, mid).join("\n"), "utf-8") <= DEFAULT_MAX_BYTES) lo = mid;
			else hi = mid;
		}
		outputLines = lo;
		result = lines.slice(0, outputLines).join("\n");
		truncatedBy = "bytes";
	}
	// 首行本身就超过字节上限：lo 会收敛到 0，outputLines=0、result="" ——
	// 这会让 read 返回 "Use offset=1" 让模型反复重读同一行，永远前进不了。
	// 兜底：至少把首行按字节截出来一段非空内容，并打上标记让 read 走另一条提示。
	let firstLineExceedsLimit = false;
	if (outputLines === 0) {
		firstLineExceedsLimit = true;
		outputLines = 1;
		result = Buffer.from(lines[0], "utf-8").subarray(0, DEFAULT_MAX_BYTES).toString("utf-8");
	}
	return {
		content: result,
		info: {
			truncated: outputLines < totalLines || firstLineExceedsLimit,
			truncatedBy,
			totalLines,
			outputLines,
			firstLineExceedsLimit,
		},
	};
}

function truncateTail(content: string): { content: string; info: TruncationInfo } {
	const lines = content.split("\n");
	const totalLines = lines.length;
	let outputLines = totalLines;
	let truncatedBy: TruncationInfo["truncatedBy"] = null;
	if (totalLines > DEFAULT_MAX_LINES) {
		outputLines = DEFAULT_MAX_LINES;
		truncatedBy = "lines";
	}
	let result = lines.slice(totalLines - outputLines).join("\n");
	if (Buffer.byteLength(result, "utf-8") > DEFAULT_MAX_BYTES) {
		let lo = 0;
		let hi = outputLines;
		while (lo + 1 < hi) {
			const mid = Math.floor((lo + hi) / 2);
			if (Buffer.byteLength(lines.slice(totalLines - mid).join("\n"), "utf-8") <= DEFAULT_MAX_BYTES) lo = mid;
			else hi = mid;
		}
		outputLines = lo;
		result = lines.slice(totalLines - outputLines).join("\n");
		truncatedBy = "bytes";
	}
	// 尾部截断（bash 输出用）走的是"留最后 N 行"，单行超限不会造成 read 那种死循环，
	// 但字段要补齐以满足类型。
	let firstLineExceedsLimit = false;
	if (outputLines === 0) {
		firstLineExceedsLimit = true;
		outputLines = 1;
		const last = lines[totalLines - 1];
		result = Buffer.from(last, "utf-8").subarray(-DEFAULT_MAX_BYTES).toString("utf-8");
	}
	return {
		content: result,
		info: {
			truncated: outputLines < totalLines || firstLineExceedsLimit,
			truncatedBy,
			totalLines,
			outputLines,
			firstLineExceedsLimit,
		},
	};
}

// ──────────────────── 文件级 mutation queue ────────────────────
const queues = new Map<string, Promise<void>>();
let registration = Promise.resolve();

async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const reg = registration.then(async () => {
		let key: string;
		try {
			key = await realpath(filePath);
		} catch {
			key = filePath;
		}
		const current = queues.get(key) ?? Promise.resolve();
		let release!: () => void;
		const next = new Promise<void>((r) => (release = r));
		const chained = current.then(() => next);
		queues.set(key, chained);
		return { key, current, chained, release };
	});
	registration = reg.then(
		() => undefined,
		() => undefined,
	);
	const { key, current, chained, release } = await reg;
	await current;
	try {
		return await fn();
	} finally {
		release();
		if (queues.get(key) === chained) queues.delete(key);
	}
}

// ──────────────────── BOM / 行尾 ────────────────────
function stripBom(s: string) {
	return s.startsWith("﻿") ? { bom: "﻿", text: s.slice(1) } : { bom: "", text: s };
}
function detectLineEnding(s: string): "\r\n" | "\n" {
	const c = s.indexOf("\r\n"),
		l = s.indexOf("\n");
	if (l === -1 || c === -1) return "\n";
	return c < l ? "\r\n" : "\n";
}
function normalizeToLF(s: string) {
	return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function restoreLineEndings(s: string, e: "\r\n" | "\n") {
	return e === "\r\n" ? s.replace(/\n/g, "\r\n") : s;
}

// ──────────────────── read ────────────────────
function makeReadTool(cwd: string): Tool {
	return {
		name: "read",
		description: `Read the contents of a file. Truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB. Use offset/limit for large files; when truncated, the result tells you the next offset to continue from.`,
		parameters: Type.Object({
			path: Type.String(),
			offset: Type.Optional(Type.Number()),
			limit: Type.Optional(Type.Number()),
		}),
		execute: async (args: { path: string; offset?: number; limit?: number }) => {
			const abs = resolveToCwd(args.path, cwd);
			await access(abs);
			const buf = await readFile(abs);
			const text = buf.toString("utf-8");
			const allLines = text.split("\n");
			const total = allLines.length;
			const start = args.offset ? Math.max(0, args.offset - 1) : 0;
			if (start >= total) throw new Error(`Offset ${args.offset} > file lines ${total}`);
			const slice =
				args.limit !== undefined
					? allLines.slice(start, Math.min(start + args.limit, total))
					: allLines.slice(start);
			const { content, info } = truncateHead(slice.join("\n"));
			if (info.firstLineExceedsLimit) {
				// 首行单独就超过字节上限：offset/limit 是按行切的，再怎么调都跳不过这一行。
				// 不返回内容，只给模型一条按字节读的出路——而不是一个会死循环的 offset 提示。
				const lineBytes = Buffer.byteLength(allLines[start], "utf-8");
				return `[Line ${start + 1} is ${(lineBytes / 1024).toFixed(1)}KB, exceeds ${DEFAULT_MAX_BYTES / 1024}KB limit. offset/limit can't skip it (they split by line). Use bash: sed -n '${start + 1}p' ${args.path} | head -c ${DEFAULT_MAX_BYTES}]`;
			}
			if (info.truncated) {
				const endLine = start + info.outputLines;
				return `${content}\n\n[Showing lines ${start + 1}-${endLine} of ${total} (${info.truncatedBy} limit). Use offset=${endLine + 1} to continue.]`;
			}
			if (args.limit !== undefined && start + slice.length < total) {
				const next = start + slice.length + 1;
				return `${content}\n\n[${total - (start + slice.length)} more lines. Use offset=${next}.]`;
			}
			return content;
		},
	};
}

// ──────────────────── bash ────────────────────
function makeBashTool(cwd: string): Tool {
	return {
		name: "bash",
		description: `Execute a bash command. Returns stdout+stderr (tail-truncated to ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES / 1024}KB). Optional timeout in seconds.`,
		parameters: Type.Object({
			command: Type.String(),
			timeout: Type.Optional(Type.Number()),
		}),
		execute: async (args: { command: string; timeout?: number }) => {
			return await new Promise<string>((resolve) => {
				const child = spawn("bash", ["-c", args.command], {
					cwd,
					stdio: ["ignore", "pipe", "pipe"],
					detached: process.platform !== "win32",
				});
				let buf = "";
				const onData = (d: Buffer) => {
					buf += d.toString("utf-8");
				};
				child.stdout?.on("data", onData);
				child.stderr?.on("data", onData);
				let timedOut = false;
				const handle = args.timeout
					? setTimeout(() => {
							timedOut = true;
							if (child.pid) try { process.kill(-child.pid); } catch {}
						}, args.timeout * 1000)
					: undefined;
				child.on("close", (code) => {
					if (handle) clearTimeout(handle);
					const { content, info } = truncateTail(buf);
					let text = content || "(no output)";
					if (info.truncated) {
						const start = info.totalLines - info.outputLines + 1;
						text += `\n\n[Showing lines ${start}-${info.totalLines} of ${info.totalLines}.]`;
					}
					if (timedOut) text += `\nCommand timed out after ${args.timeout}s`;
					else if (code !== 0 && code !== null) text += `\nCommand exited with code ${code}`;
					resolve(text);
				});
			});
		},
	};
}

// ──────────────────── write ────────────────────
function makeWriteTool(cwd: string): Tool {
	return {
		name: "write",
		description: "Create or overwrite a file. Auto-creates parent directories.",
		parameters: Type.Object({
			path: Type.String(),
			content: Type.String(),
		}),
		execute: async (args: { path: string; content: string }) => {
			const abs = resolveToCwd(args.path, cwd);
			return withFileMutationQueue(abs, async () => {
				await mkdir(dirname(abs), { recursive: true });
				await writeFile(abs, args.content, "utf-8");
				return `Successfully wrote ${args.content.length} bytes to ${args.path}`;
			});
		},
	};
}

// ──────────────────── edit ────────────────────
function applyEdits(content: string, edits: { oldText: string; newText: string }[], path: string) {
	const norm = edits.map((e) => ({
		oldText: normalizeToLF(e.oldText),
		newText: normalizeToLF(e.newText),
	}));
	for (let i = 0; i < norm.length; i++) {
		if (norm[i].oldText.length === 0) throw new Error(`edits[${i}].oldText is empty`);
	}
	type Match = { i: number; index: number; length: number; newText: string };
	const matches: Match[] = [];
	for (let i = 0; i < norm.length; i++) {
		const idx = content.indexOf(norm[i].oldText);
		if (idx === -1) {
			throw new Error(
				`Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
			);
		}
		const occurrences = content.split(norm[i].oldText).length - 1;
		if (occurrences > 1) {
			throw new Error(
				`Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context.`,
			);
		}
		matches.push({ i, index: idx, length: norm[i].oldText.length, newText: norm[i].newText });
	}
	matches.sort((a, b) => a.index - b.index);
	for (let i = 1; i < matches.length; i++) {
		if (matches[i - 1].index + matches[i - 1].length > matches[i].index) {
			throw new Error(`edits[${matches[i - 1].i}] and edits[${matches[i].i}] overlap`);
		}
	}
	let out = content;
	for (let i = matches.length - 1; i >= 0; i--) {
		out = out.slice(0, matches[i].index) + matches[i].newText + out.slice(matches[i].index + matches[i].length);
	}
	if (out === content) throw new Error("No changes made; replacements produced identical content.");
	return out;
}

function makeEditTool(cwd: string): Tool {
	return {
		name: "edit",
		description:
			"Edit a single file using exact text replacement. Each edits[].oldText must match a unique non-overlapping region. Multiple edits in one call.",
		parameters: Type.Object({
			path: Type.String(),
			edits: Type.Array(
				Type.Object({
					oldText: Type.String(),
					newText: Type.String(),
				}),
			),
		}),
		execute: async (args: { path: string; edits: { oldText: string; newText: string }[] }) => {
			const abs = resolveToCwd(args.path, cwd);
			return withFileMutationQueue(abs, async () => {
				const raw = (await readFile(abs)).toString("utf-8");
				const { bom, text } = stripBom(raw);
				const ending = detectLineEnding(text);
				const normalized = normalizeToLF(text);
				const newContent = applyEdits(normalized, args.edits, args.path);
				await writeFile(abs, bom + restoreLineEndings(newContent, ending), "utf-8");
				return `Successfully replaced ${args.edits.length} block(s) in ${args.path}`;
			});
		},
	};
}

// ──────────────────── 总装 ────────────────────
export function makeCodingTools(cwd: string): Tool[] {
	return [makeReadTool(cwd), makeBashTool(cwd), makeEditTool(cwd), makeWriteTool(cwd)];
}
