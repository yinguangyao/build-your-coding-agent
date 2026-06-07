# 第 5 章 真实的编码工具

> 📂 **本章配套代码**：[https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch05](https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch05)

> 第 4 章我们用 `current_time` / `read_file` / `bash` 这种 20 行的玩具工具把循环跑通了。但你拿它去干真活，五分钟就会翻车：让它读一下 `package-lock.json`，一次工具调用就把整个上下文窗口吃光；让它跑 `npm test`，命令卡住整个 agent 跟着卡死；让它改个文件，它把不该改的地方也改了。
>
> 这一章我们把 4 个核心工具——`read` / `bash` / `edit` / `write`——从"最笨的版本"开始，**每写一版就喂一个真实场景，看它在哪翻车，再修哪**。修完你会发现：真实 coding agent 的工具代码量是玩具版的几十倍，多出来的每一行都对应一次真实的翻车。
>
> 章末我们再对照 pi 的工业级实现（`packages/coding-agent/src/core/tools/`，加起来 1500+ 行），你会看到我们修过的每个坑它都修过，还多修了一些我们没遇到的。

> ⚠️ **先说安全**：从这一章起，工具会**真的执行任意 shell 命令、读写你磁盘上任意路径的文件**——`bash` 直接 `spawn("bash", ["-c", cmd])`，`write` 会覆盖你给的任何绝对路径，`read` 能读到 `../../` 之外去。本章和后面并行执行的简化版**没有**工作目录沙箱、没有命令白名单、没有路径逃逸校验（这些防护要到后面的 `beforeToolCall` 钩子才登场）。**请只在可信目录、最好是容器/虚拟机里，用你能承受被误删的数据来跑这些 demo。** 把它直接接到生产环境或你的主目录是危险的。

## 5.1 这一章会做什么

体感目标：把第 4 章的 `runAgentLoop` 原封不动留着，只换工具，就能跑真实任务。下面是一段**真实运行记录**（DeepSeek 模型，一字未改）：

```
$ npx tsx ch05/loop.ts "把 README.txt 里的 npm 都换成 pnpm，改完读一遍确认"
[tool] read({"path":"README.txt"})
[result] install with: npm install\nrun with: npm start\n
[tool] edit({"path":"README.txt","edits":[{"oldText":"npm","newText":"pnpm"}]})
[result] Error: Found 2 occurrences of edits[0] in README.txt. Each oldText must be unique. Please provide more context.
[tool] edit({"path":"README.txt","edits":[{"oldText":"install with: npm install","newText":"install with: pnpm install"},{"oldText":"run with: npm start","newText":"run with: pnpm start"}]})
[result] Successfully replaced 2 block(s) in README.txt
[tool] read({"path":"README.txt"})
[result] install with: pnpm install\nrun with: pnpm start\n
完成，所有 `npm` 都已替换为 `pnpm`。
```

盯着第二步看：模型想用 `"npm"` 一把替换，**被工具拒绝了**（文件里出现了 2 次）；它读懂报错，自己带上完整上下文、一次提交两处修改，成功，最后还 read 了一遍自查。这次拒绝不是 bug——它就是这一章要写的东西。

写法上，这一章每个工具都走同一个循环：

1. **写一个最笨但能跑的版本**（5-10 行）；
2. **喂一个真实场景，看它怎么翻车**；
3. **修掉，再喂下一个场景**。

四个工具修完，组装成 `code/ch05/tools.ts`（约 350 行），直接喂给第 4 章的循环。pi 的真实实现留到 5.9 做对照——**先自己踩一遍坑，再看工业级代码，你会发现每段"复杂"都有名有姓**。

## 5.2 read：从 10 行到能读大文件

### 第一版：能跑就行

读文件还能写出花来？先来个最直觉的：

```ts
{
  name: "read",
  description: "Read the contents of a file.",
  parameters: Type.Object({ path: Type.String() }),
  execute: async (args) => {
    return (await readFile(args.path)).toString("utf-8");
  },
}
```

10 行。在 demo 项目里跑得好好的。然后你让 agent 看一眼真实项目：

```
> 帮我看看这个项目的依赖结构
[tool] read({"path":"package-lock.json"})
```

**翻车了。** `package-lock.json` 随便就是几万行、几 MB。这一坨全进了 messages 数组——还记得第 1 章说的吗，**messages 就是上下文**。一次 read 直接把 128k 的上下文窗口塞爆，下一次请求 API 直接报错；就算窗口够大，你也为一堆没人看的 JSON 付了真金白银的 token 钱。

**教训：工具的输出会全文进上下文，所以工具必须自己控制输出量。** 这是真实工具和玩具工具的第一个分水岭。

### 第二版：按行数截断

最直接的修法——最多返回 2000 行：

```ts
const DEFAULT_MAX_LINES = 2000;

const allLines = text.split("\n");
const result = allLines.slice(0, DEFAULT_MAX_LINES).join("\n");
```

为什么是 2000？经验值：模型回看 2000 行已经很费劲，再多它基本会忽略前半段，纯属浪费。

再跑。这次让它读一个**打包后的 js**：

```
[tool] read({"path":"dist/bundle.min.js"})
```

**又翻车了。** minified 文件只有 1 行，但这一行 5MB。"最多 2000 行"的限制形同虚设。

### 第三版：行数 + 字节双限制

所以截断必须是**两道闸**：行数限制管"行数爆炸"，字节限制管"单行爆炸"，**谁先触发听谁的**：

```ts
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;   // 50KB，约 800-1200 行普通代码

function truncateHead(content: string) {
  const lines = content.split("\n");
  const totalLines = lines.length;
  let outputLines = totalLines;
  let truncatedBy: "lines" | "bytes" | null = null;

  // 第一道闸：行数
  if (totalLines > DEFAULT_MAX_LINES) {
    outputLines = DEFAULT_MAX_LINES;
    truncatedBy = "lines";
  }
  let result = lines.slice(0, outputLines).join("\n");

  // 第二道闸：字节。超了就用二分找"能装下的最大行数"
  if (Buffer.byteLength(result, "utf-8") > DEFAULT_MAX_BYTES) {
    let lo = 0, hi = outputLines;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (Buffer.byteLength(lines.slice(0, mid).join("\n"), "utf-8") <= DEFAULT_MAX_BYTES) lo = mid;
      else hi = mid;
    }
    outputLines = lo;
    result = lines.slice(0, outputLines).join("\n");
    truncatedBy = "bytes";
  }
  // ...返回 result 和截断信息
}
```

两个细节：

- 用 `Buffer.byteLength` 而不是 `result.length`——中文一个字符 3 字节，按字符数算会超。
- 字节超限时用**二分**找能装下的行数，而不是一个字节一个字节砍——既快，又保证不会把一行从中间切成半句话。

### 第四版：截掉了，模型怎么办？

现在大文件不炸了，但出现一个新问题。模型读 `app.log`（5 万行）想找一个报错，我们默默给它前 2000 行——报错在第 38000 行。模型看完说"没有报错"。**它根本不知道自己只看到了 4%。**

修法分两半。一半是给工具加 `offset` / `limit` 参数，让模型能分段读：

```ts
parameters: Type.Object({
  path: Type.String(),
  offset: Type.Optional(Type.Number()),   // 从第几行开始读（1-indexed，跟 head -n 一致）
  limit: Type.Optional(Type.Number()),    // 最多读几行
}),
```

另一半更关键：**截断的时候，明确告诉模型"截了、截到哪、怎么继续"**：

```ts
if (info.truncated) {
  const endLine = start + info.outputLines;
  return `${content}\n\n[Showing lines ${start + 1}-${endLine} of ${total} ` +
         `(${info.truncatedBy} limit). Use offset=${endLine + 1} to continue.]`;
}
```

跑一下，效果立竿见影：

```
[tool] read({"path":"app.log"})
  → ...(前2000行)...
    [Showing lines 1-2000 of 50000 (lines limit). Use offset=2001 to continue.]
[tool] read({"path":"app.log","offset":2001})
  → ...
```

模型看到提示**自己**发起了第二次调用。不需要我们写任何"分页逻辑"，把"还有更多、这样继续"用人话写在工具结果里，模型就会接力读下去。

> **这是写工具最重要的一个心法：工具的返回值是给模型看的"UI"。** 你给人类用户设计界面会写"加载更多"按钮，给模型设计工具输出同理——它看不到的状态（截没截、还剩多少）要主动说，它该做的下一步（offset=2001）要直接给。后面每个工具都会用到这个心法。

### 第五版：一个会死循环的边界

最后一个坑很隐蔽。如果**第一行自己就超过 50KB**（还是那个 minified js），按行截断的逻辑会算出"能装下 0 行"，于是返回空内容加一句 `Use offset=1 to continue.`——而模型照做后又得到同样的提示，**无限循环，永远前进不了**。

所以这种情况要单独识别（我们在截断信息里加一个 `firstLineExceedsLimit` 标志），并且给一条**完全不同的出路**——别再提 offset 了，offset 是按行跳的，永远跳不过这一行：

```ts
if (info.firstLineExceedsLimit) {
  const lineBytes = Buffer.byteLength(allLines[start], "utf-8");
  return `[Line ${start + 1} is ${(lineBytes / 1024).toFixed(1)}KB, exceeds 50KB limit. ` +
         `offset/limit can't skip it (they split by line). ` +
         `Use bash: sed -n '${start + 1}p' ${args.path} | head -c 51200]`;
}
```

告诉模型"这条路不通，换 bash 按字节读"。

### 五版叠起来：read 的完整实现

碎片讲完，把五版叠成最终代码（与 `code/ch05/tools.ts` 一致）。先是截断函数：

```ts
const DEFAULT_MAX_LINES = 2000;
const DEFAULT_MAX_BYTES = 50 * 1024;

type TruncationInfo = {
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  outputLines: number;
  firstLineExceedsLimit: boolean;   // 首行单独就超字节上限（第五版那个死循环坑）
};

function truncateHead(content: string): { content: string; info: TruncationInfo } {
  const lines = content.split("\n");
  const totalLines = lines.length;
  let outputLines = totalLines;
  let truncatedBy: TruncationInfo["truncatedBy"] = null;

  // 第一道闸：行数
  if (totalLines > DEFAULT_MAX_LINES) {
    outputLines = DEFAULT_MAX_LINES;
    truncatedBy = "lines";
  }
  let result = lines.slice(0, outputLines).join("\n");

  // 第二道闸：字节，二分找能装下的最大行数
  if (Buffer.byteLength(result, "utf-8") > DEFAULT_MAX_BYTES) {
    let lo = 0, hi = outputLines;
    while (lo + 1 < hi) {
      const mid = Math.floor((lo + hi) / 2);
      if (Buffer.byteLength(lines.slice(0, mid).join("\n"), "utf-8") <= DEFAULT_MAX_BYTES) lo = mid;
      else hi = mid;
    }
    outputLines = lo;
    result = lines.slice(0, outputLines).join("\n");
    truncatedBy = "bytes";
  }

  // 首行就超限：lo 收敛到 0、result 为空——兜底截一段非空内容并打标记
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
      truncatedBy, totalLines, outputLines, firstLineExceedsLimit,
    },
  };
}
```

然后是工具本体：

```ts
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
      const abs = resolveToCwd(args.path, cwd);     // 路径清洗，5.7 讲
      await access(abs);
      const text = (await readFile(abs)).toString("utf-8");
      const allLines = text.split("\n");
      const total = allLines.length;
      const start = args.offset ? Math.max(0, args.offset - 1) : 0;   // 1-indexed → 0-indexed
      if (start >= total) throw new Error(`Offset ${args.offset} > file lines ${total}`);
      const slice = args.limit !== undefined
        ? allLines.slice(start, Math.min(start + args.limit, total))
        : allLines.slice(start);

      const { content, info } = truncateHead(slice.join("\n"));

      // 第五版：首行超限，给一条不会死循环的出路
      if (info.firstLineExceedsLimit) {
        const lineBytes = Buffer.byteLength(allLines[start], "utf-8");
        return `[Line ${start + 1} is ${(lineBytes / 1024).toFixed(1)}KB, exceeds ${DEFAULT_MAX_BYTES / 1024}KB limit. offset/limit can't skip it (they split by line). Use bash: sed -n '${start + 1}p' ${args.path} | head -c ${DEFAULT_MAX_BYTES}]`;
      }
      // 第四版：截断了就指路
      if (info.truncated) {
        const endLine = start + info.outputLines;
        return `${content}\n\n[Showing lines ${start + 1}-${endLine} of ${total} (${info.truncatedBy} limit). Use offset=${endLine + 1} to continue.]`;
      }
      // 用户给了 limit、没截断但文件还有剩：也指路
      if (args.limit !== undefined && start + slice.length < total) {
        const next = start + slice.length + 1;
        return `${content}\n\n[${total - (start + slice.length)} more lines. Use offset=${next}.]`;
      }
      return content;
    },
  };
}
```

注意 description 把截断规则和 offset 用法**写给模型看**了——这也是第四版心法的一部分：工具的说明书本身就是 prompt。

## 5.3 bash：从 exec 到能管住子进程

### 第一版：能跑就行

```ts
import { exec } from "node:child_process";
import { promisify } from "node:util";
const execAsync = promisify(exec);

execute: async (args) => {
  const { stdout, stderr } = await execAsync(args.command);
  return stdout + stderr;
}
```

`ls`、`cat`、`git status` 都没问题。然后：

```
[tool] bash({"command":"npm install"})
```

**翻车一：输出爆炸。** npm 的进度条会刷出海量输出，跟 read 的大文件是同一个问题。修法也一样——双限制截断。但注意一个方向差异：

- `read` 截断**保头**（`truncateHead`）——文件从头看才有意义；
- `bash` 截断**保尾**（`truncateTail`）——命令输出最有价值的信息几乎都在**末尾**：报错堆栈、`Tests: 2 failed`、exit 前最后一句话。保头会把这些全截掉。

`truncateTail` 跟 `truncateHead` 是镜像：保最后 N 行、字节超限时二分找"从尾部数能装下多少行"（`code/ch05/tools.ts:76-117`）。

### 翻车二：命令卡死

```
[tool] bash({"command":"npm test"})
（这个项目的 npm test 起了 watch 模式，永远不退出……）
```

agent 整个卡在 `await` 上，用户只能干瞪眼。修法：加 `timeout` 参数。

但这里有个设计决定值得想一想：**要不要给一个默认超时？** 比如默认 30 秒。听起来稳妥，实际很糟——`npm install`、`tsc`、跑全量测试，超过 30 秒太正常了，一刀切的默认超时只会逼模型不停地调大 timeout 重跑。所以我们（和 pi 一样）选择**不设默认超时，让模型按需指定**，工具的 description 里写明 "Optional timeout in seconds"。

### 翻车三：杀不死的子进程

加了 timeout，到时间 `child.kill()`——又翻车了：

```
[tool] bash({"command":"npm run dev","timeout":10})
（10 秒后工具返回了，但 dev server 还在后台跑，端口一直被占着）
```

原因：`npm run dev` 的进程结构是 `bash -c → npm → node server.js`。`child.kill()` 只杀了最外层的 bash，**孙子进程变成孤儿继续跑**。

修法是 Unix 的"进程组"机制，两步：

```ts
const child = spawn("bash", ["-c", args.command], {
  cwd,
  detached: process.platform !== "win32",   // ① 让子进程自立门户，成为新进程组的组长
});

// ② 杀的时候用【负的 pid】——信号发给整个进程组，连孙子一起
if (child.pid) try { process.kill(-child.pid); } catch {}
```

`detached: true` 让 bash 成为新进程组组长（组 id = 它的 pid）；`process.kill(-pid)` 里的负号表示"发给这个组的所有进程"。两个必须配套——没有 `detached`，子进程还在我们自己的组里，负 pid 会把 agent 自己也杀了。

### 组装起来

完整的 bash 工具（`code/ch05/tools.ts:213-256`）就是这三个修复的叠加，再加两个小决定：

- **stdout 和 stderr 合并**收集——模型不关心一行字是从哪个流出来的，分开反而让它困惑；
- 退出时把状态写进结果：超时了写 `Command timed out after Ns`，非零退出写 `Command exited with code N`——又是"工具输出是给模型看的 UI"，exit code 不说，模型就当命令成功了。

```ts
child.on("close", (code) => {
  if (handle) clearTimeout(handle);
  const { content, info } = truncateTail(buf);
  let text = content || "(no output)";
  if (info.truncated) text += `\n\n[Showing lines ${start}-${info.totalLines} of ${info.totalLines}.]`;
  if (timedOut) text += `\nCommand timed out after ${args.timeout}s`;
  else if (code !== 0 && code !== null) text += `\nCommand exited with code ${code}`;
  resolve(text);
});
```

注意我们**从不 reject**——命令失败也是合法的工具结果（模型要靠它判断下一步），跟第 4 章"工具出错不 throw，包装成结果"是同一条原则。

### bash 的完整实现

```ts
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
          detached: process.platform !== "win32",   // 翻车三：自立进程组
        });
        let buf = "";
        const onData = (d: Buffer) => { buf += d.toString("utf-8"); };
        child.stdout?.on("data", onData);            // 翻车一：stdout/stderr 合并收集
        child.stderr?.on("data", onData);

        let timedOut = false;                        // 翻车二：可选超时
        const handle = args.timeout
          ? setTimeout(() => {
              timedOut = true;
              if (child.pid) try { process.kill(-child.pid); } catch {}   // 负 pid 杀整组
            }, args.timeout * 1000)
          : undefined;

        child.on("close", (code) => {
          if (handle) clearTimeout(handle);
          const { content, info } = truncateTail(buf);   // 保尾截断
          let text = content || "(no output)";
          if (info.truncated) {
            const start = info.totalLines - info.outputLines + 1;
            text += `\n\n[Showing lines ${start}-${info.totalLines} of ${info.totalLines}.]`;
          }
          if (timedOut) text += `\nCommand timed out after ${args.timeout}s`;
          else if (code !== 0 && code !== null) text += `\nCommand exited with code ${code}`;
          resolve(text);                               // 永不 reject
        });
      });
    },
  };
}
```

`truncateTail` 是 `truncateHead` 的镜像——`slice(0, outputLines)` 全部换成 `slice(totalLines - outputLines)`（保最后 N 行），二分时也从尾部数，完整代码见 `code/ch05/tools.ts:76-117`。

## 5.4 write：最简单的工具，也有两个讲究

```ts
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
      return withFileMutationQueue(abs, async () => {        // 写队列，5.6 讲，先当透明包装
        await mkdir(dirname(abs), { recursive: true });      // 讲究一
        await writeFile(abs, args.content, "utf-8");
        return `Successfully wrote ${args.content.length} bytes to ${args.path}`;
      });
    },
  };
}
```

（这就是完整实现——`withFileMutationQueue` 那层是 5.6 要讲的"写队列"，这里先把它当成透明的包装。）

- **讲究一：自动创建父目录。** 模型经常要写 `src/utils/helpers/foo.ts` 这种深路径。不自动 `mkdir -p`，它就得先单独跑一次 bash 建目录——多一轮调用、多一次出错机会。能在工具里顺手做掉的事，别让模型多跑一轮。
- **讲究二：存在即覆盖，不报错。** 另一种设计是"文件已存在就拒绝，逼模型先 read"。听着安全，实际很烦——模型十有八九就是想覆盖（比如重新生成一个配置文件）。pi 的选择是覆盖语义 + 在 description 里写明 "overwrites if it exists"，把决定权交给模型。

## 5.5 edit：最难的工具

`write` 是整文件覆盖，改大文件时既浪费（要让模型把全文吐一遍）又危险（吐错一行就毁了整个文件）。真正高频的是**局部修改**：`edit`。

### 第一版：字符串替换

最直觉的设计：让模型给出"要改的原文"（`oldText`）和"改后的文本"（`newText`），我们做一次字符串替换：

```ts
execute: async (args) => {
  const content = (await readFile(abs)).toString("utf-8");
  await writeFile(abs, content.replace(args.oldText, args.newText));
  return "Done";
}
```

拿一个真实的配置文件试试。`config.ts` 长这样：

```ts
export const config = {
  retry: { count: 3, delay: 1000 },
  poll:  { count: 3, delay: 5000 },
  batch: { count: 3, size: 10 },
};
```

用户说："**把轮询（poll）的次数从 3 改成 5**"。模型于是发起：

```
[tool] edit({"path":"config.ts","oldText":"count: 3","newText":"count: 5"})
  → Done
```

工具说 Done，模型向用户汇报"改好了"。但打开文件一看：

```ts
export const config = {
  retry: { count: 5, delay: 1000 },   // ← 被改的是这行！retry 被改坏了
  poll:  { count: 3, delay: 5000 },   // ← 真正要改的，纹丝没动
  batch: { count: 3, size: 10 },
};
```

**翻车了，而且是最吓人的那种。** 复盘一下：`"count: 3"` 在文件里出现了 **3 次**，而 `String.replace` 的语义是只替换**第一个**匹配——它不知道、也无从知道模型想改的是 poll 那行。于是三重事故叠在一起：**改错了地方**（retry 被改成 5）、**该改的没改**（poll 还是 3）、**全程没有任何报错**（模型和用户都以为成功了）。这种 bug 要等到线上"为什么重试了 5 次"的告警响起来才会被发现。

### 第二版：宁可拒绝，不要猜

根源在于：`oldText` 有歧义时，工具**替模型做了猜测**。修法不是"想办法猜得更准"，而是**根本不猜**——`oldText` 在文件里必须**恰好出现一次**，否则拒绝执行：

```ts
const idx = content.indexOf(oldText);
if (idx === -1) {
  throw new Error(`Could not find oldText in ${path}. ` +
    `The oldText must match exactly including all whitespace and newlines.`);
}
const occurrences = content.split(oldText).length - 1;   // 出现次数
if (occurrences > 1) {
  throw new Error(`Found ${occurrences} occurrences of oldText in ${path}. ` +
    `Each oldText must be unique. Please provide more context.`);
}
```

同一个场景再跑一遍。这次配合第 4 章"工具报错也回灌给模型"的循环，会看到很漂亮的自我修正：

```
[tool] edit({"oldText":"count: 3","newText":"count: 5"})
  → Error: Found 3 occurrences of oldText in config.ts.
    Each oldText must be unique. Please provide more context.
[tool] edit({"oldText":"poll:  { count: 3","newText":"poll:  { count: 5"})
  → Successfully replaced 1 block(s)
```

第一次被拒，但错误信息把"为什么"和"怎么办"都说了（出现了 3 次、请带更多上下文）。模型第二次**自己**带上了 `poll:` 这个独一无二的前缀，精确命中真正要改的那行。错误信息里那句 `Please provide more context` 不是客套——它就是写给模型的修复指令。**对"改文件"这种破坏性操作，宁可拒绝 + 指路，绝不静默猜测。**

### 第三版：一次改多处

模型经常要在一个文件里改五六个地方。一处一次调用，又慢又费 token。给参数升级成数组：

```ts
parameters: Type.Object({
  path: Type.String(),
  edits: Type.Array(Type.Object({
    oldText: Type.String(),
    newText: Type.String(),
  })),
}),
```

但多处替换有个隐蔽的坑：**第一个 edit 应用之后，文件内容变了，后面 edit 的位置全漂了**。如果 `edits[0]` 把第 10 行那段换成更长的文本，原本在第 50 行的 `edits[1]` 的位置就不再是原来的 index 了。

解法三步（`applyEdits`，`code/ch05/tools.ts:279-316`）：

```ts
// ① 所有 edit 都对【原始内容】做匹配和唯一性检查，记下各自的 index
const matches = edits.map(e => ({ index: content.indexOf(e.oldText), ... }));

// ② 按位置排序，检查互不重叠（重叠说明模型给的 edits 自相矛盾，拒绝）
matches.sort((a, b) => a.index - b.index);
for (let i = 1; i < matches.length; i++) {
  if (matches[i-1].index + matches[i-1].length > matches[i].index) {
    throw new Error(`edits overlap`);
  }
}

// ③ 【从后往前】应用——改后面的不影响前面的 index
let out = content;
for (let i = matches.length - 1; i >= 0; i--) {
  out = out.slice(0, matches[i].index) + matches[i].newText
      + out.slice(matches[i].index + matches[i].length);
}
```

关键就是③的**逆序**：先改文件末尾的，再改前面的——后面的内容怎么变，都影响不到前面已经记好的 index。这比"每应用一个就重新匹配一遍"既快又不会出"改完的文本恰好又匹配上了"的怪事。整个多处替换的流程：

![多处 edit：逆序应用](images/ch05-edit-multi-flow.png)

### 第四版：CRLF 和 BOM——"明明一样却匹配不上"

在 Windows 同事的仓库里跑，edit 频繁报 `Could not find oldText`，可肉眼看 `oldText` 和文件内容**一模一样**。

肉眼看不出来的差别有两种：

- **行尾**：文件是 CRLF（`\r\n`），模型吐的 `oldText` 是 LF（`\n`）。每行末尾差一个看不见的 `\r`，`indexOf` 当然找不到。
- **BOM**：有些 Windows 编辑器在文件开头写一个不可见的 `﻿`。模型要改第一行时，`oldText` 不带 BOM，匹配不上。

修法：**读进来先归一化，写回去再还原**——匹配永远在干净的 LF 世界里做，文件原有的格式一个字节不动：

```ts
const raw = (await readFile(abs)).toString("utf-8");
const { bom, text } = stripBom(raw);              // 摘掉 BOM，记住它
const ending = detectLineEnding(text);             // 记住原文件是 CRLF 还是 LF
const normalized = normalizeToLF(text);            // 全部转成 LF
const newContent = applyEdits(normalized, args.edits, args.path);   // 在 LF 世界匹配替换
await writeFile(abs, bom + restoreLineEndings(newContent, ending)); // 原样还原 BOM 和行尾
```

`oldText` / `newText` 也要同样归一化（模型偶尔会吐出带 `\r\n` 的文本）。这四个小函数加起来 15 行，但没有它们，edit 在 CRLF 仓库里就是个废物：

```ts
function stripBom(s: string) {
  return s.startsWith("﻿") ? { bom: "﻿", text: s.slice(1) } : { bom: "", text: s };
}
function detectLineEnding(s: string): "\r\n" | "\n" {
  const c = s.indexOf("\r\n"), l = s.indexOf("\n");
  if (l === -1 || c === -1) return "\n";
  return c < l ? "\r\n" : "\n";
}
function normalizeToLF(s: string) {
  return s.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function restoreLineEndings(s: string, e: "\r\n" | "\n") {
  return e === "\r\n" ? s.replace(/\n/g, "\r\n") : s;
}
```

### 四版叠起来：edit 的完整实现

先是核心算法 `applyEdits`（第二、三版的全部检查都在里面）：

```ts
function applyEdits(content: string, edits: { oldText: string; newText: string }[], path: string) {
  // 第四版：oldText/newText 也归一化成 LF
  const norm = edits.map((e) => ({
    oldText: normalizeToLF(e.oldText),
    newText: normalizeToLF(e.newText),
  }));
  for (let i = 0; i < norm.length; i++) {
    if (norm[i].oldText.length === 0) throw new Error(`edits[${i}].oldText is empty`);
  }

  // 第三版①：所有 edit 都对【原始内容】定位 + 第二版的两道闸
  type Match = { i: number; index: number; length: number; newText: string };
  const matches: Match[] = [];
  for (let i = 0; i < norm.length; i++) {
    const idx = content.indexOf(norm[i].oldText);
    if (idx === -1) {
      throw new Error(`Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`);
    }
    const occurrences = content.split(norm[i].oldText).length - 1;
    if (occurrences > 1) {
      throw new Error(`Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context.`);
    }
    matches.push({ i, index: idx, length: norm[i].oldText.length, newText: norm[i].newText });
  }

  // 第三版②：按位置排序 + 重叠检查
  matches.sort((a, b) => a.index - b.index);
  for (let i = 1; i < matches.length; i++) {
    if (matches[i - 1].index + matches[i - 1].length > matches[i].index) {
      throw new Error(`edits[${matches[i - 1].i}] and edits[${matches[i].i}] overlap`);
    }
  }

  // 第三版③：从后往前逆序应用
  let out = content;
  for (let i = matches.length - 1; i >= 0; i--) {
    out = out.slice(0, matches[i].index) + matches[i].newText + out.slice(matches[i].index + matches[i].length);
  }
  if (out === content) throw new Error("No changes made; replacements produced identical content.");
  return out;
}
```

然后是工具本体——读、消毒、应用、还原、写，一条线：

```ts
function makeEditTool(cwd: string): Tool {
  return {
    name: "edit",
    description: "Edit a single file using exact text replacement. Each edits[].oldText must match a unique non-overlapping region. Multiple edits in one call.",
    parameters: Type.Object({
      path: Type.String(),
      edits: Type.Array(
        Type.Object({ oldText: Type.String(), newText: Type.String() }),
      ),
    }),
    execute: async (args: { path: string; edits: { oldText: string; newText: string }[] }) => {
      const abs = resolveToCwd(args.path, cwd);
      return withFileMutationQueue(abs, async () => {          // 写队列，5.6
        const raw = (await readFile(abs)).toString("utf-8");
        const { bom, text } = stripBom(raw);                   // 第四版：消毒并记住
        const ending = detectLineEnding(text);
        const normalized = normalizeToLF(text);
        const newContent = applyEdits(normalized, args.edits, args.path);
        await writeFile(abs, bom + restoreLineEndings(newContent, ending), "utf-8");   // 原样还原
        return `Successfully replaced ${args.edits.length} block(s) in ${args.path}`;
      });
    },
  };
}
```

四版叠完，整个 edit 的执行流程是这样的：

![edit 工具的执行流程](images/ch05-edit-flow.png)

读进来先"消毒"（BOM、行尾），匹配阶段两道闸（找不到拒绝、不唯一拒绝），改的时候逆序，写回去原样还原——每一步都对应前面踩过的一个坑。

## 5.6 一个还没发生、但马上会发生的事故：并发写

到这里四个工具单独都能干活了。但后面我们会让工具**并行执行**——如果模型一次发起两个 `edit` 改**同一个文件**呢？

两个 edit 同时 `readFile` → 各自在自己读到的旧内容上替换 → 先后 `writeFile`。**后写的会把先写的改动整个覆盖掉**——经典的 read-modify-write 竞态。这种 bug 出现概率不高，可一旦出现就是"改动莫名消失"，极难排查。

修法：**按文件路径排队**。同一个文件的写操作串行，不同文件照常并行：

```ts
const queues = new Map<string, Promise<void>>();

async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = await realpath(filePath);            // 解析符号链接：a.ts 和指向它的 link 是同一个文件
  const current = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const next = new Promise<void>((r) => (release = r));
  queues.set(key, current.then(() => next));       // 把自己接到队尾
  await current;                                    // 等前面的写完
  try {
    return await fn();
  } finally {
    release();                                      // 放行下一个
    if (queues.get(key) === next) queues.delete(key);
  }
}
```

`edit` 和 `write` 的核心逻辑都用它包住。一个值得注意的细节：key 用 `realpath` 而不是原始路径——同一个文件通过相对路径、绝对路径、符号链接来写，必须归一到同一个队列。

> **再抠一层**：`realpath` 是个 `await`。两个并发调用同时停在这个 `await` 上，谁先恢复执行、谁先接到队尾就成了赌运气——入队顺序会乱。所以完整版还有一条 `registration` promise 链，把"算 key + 接队尾"这一小段**本身**也串行化。

带上这层防护的最终版：

```ts
const queues = new Map<string, Promise<void>>();
let registration = Promise.resolve();

async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  // "算 key + 接到队尾"整段挂在 registration 链上 → 入队本身严格按调用顺序
  const reg = registration.then(async () => {
    let key: string;
    try { key = await realpath(filePath); } catch { key = filePath; }   // 文件可能还不存在
    const current = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const chained = current.then(() => next);
    queues.set(key, chained);
    return { key, current, chained, release };
  });
  registration = reg.then(() => undefined, () => undefined);   // 链不能因报错而断

  const { key, current, chained, release } = await reg;
  await current;                                  // 等同文件前面的写完
  try {
    return await fn();
  } finally {
    release();                                    // 放行下一个
    if (queues.get(key) === chained) queues.delete(key);   // 只有"我是队尾"才清理
  }
}
```

## 5.7 路径解析：模型给的路径不能直接用

还有个贯穿四个工具的小问题：模型给的 `path` 五花八门——相对路径、绝对路径、甚至带着 IDE"复制路径"功能加的 `@` 前缀（`@src/foo.ts`）。统一收口成一个函数：

```ts
function resolveToCwd(p: string, cwd: string): string {
  if (p.startsWith("@")) p = p.slice(1);                       // IDE 复制出来的 @ 前缀
  return isAbsolute(p) ? resolvePath(p) : resolvePath(cwd, p); // 相对路径基于 cwd 解析
}
```

四个工具的 `execute` 第一行都是 `const abs = resolveToCwd(args.path, cwd)`。pi 的真实版本（`path-utils.ts`）还处理了一堆 macOS 的奇葩场景——截图文件名里的窄空格、Unicode NFD 归一化、弯引号——思路一样：**模型给的路径是"用户输入"，永远先清洗再用**。

## 5.8 组装：喂给第 4 章的循环

四个工具一人一个工厂函数，组装导出（`code/ch05/tools.ts:348-350`）：

```ts
export function makeCodingTools(cwd: string): Tool[] {
  return [makeReadTool(cwd), makeBashTool(cwd), makeEditTool(cwd), makeWriteTool(cwd)];
}
```

类型还是第 4 章那个 `Tool`，所以入口只需要把玩具工具换掉。这就是 `code/ch05/loop.ts` 的**全部内容**：

```ts
// ch05/loop.ts —— 第 4 章的循环原封不动，只把玩具工具换成本章的真实 read/bash/edit/write。
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
  baseUrl, apiKey, model,
  systemPrompt: SYSTEM,
  userInput,
  tools: makeCodingTools(process.cwd()),   // ← 全部改动就这一行
  emit: consoleEmit,                       // 复用第 4 章的控制台打印
});
```

在 `code/` 目录下跑 `npx tsx ch05/loop.ts "把 README.txt 里的 npm 都换成 pnpm，改完读一遍确认"`——5.1 开头那段真实记录就是这条命令跑出来的：read → 歧义被拒 → 带上下文的多处 edit → read 自查，本章所有机制一次全亮相。

> **一处刻意的简化**：我们的 `Tool.execute(args)` 签名只收 `args`，**收不到 `AbortSignal`**——所以这一版工具没法被中途取消，bash 里**只有 `timeout` 真正生效**，Ctrl+C 取消整个回合要到后面才接到工具内部。本章先把"超时能停"这条主路跑通就够了；abort 透传留到后面讲取消时一起做。

## 5.9 对照 pi 的工业级实现

现在打开 pi 的源码（`packages/coding-agent/src/core/tools/`），你应该能"认亲"了——我们修过的每个坑它都修过，对应关系：

| 我们这章 | pi 源码 | pi 额外多做的 |
| --- | --- | --- |
| `truncateHead` / `truncateTail` 双限制 | `truncate.ts` | 记录 `lastLinePartial` 等更细的截断元信息 |
| read 的 offset/limit + 续读提示 | `read.ts` | BOM 处理、图片文件直接返回 image 内容、按行号显示 |
| bash 的进程组击杀 + 保尾截断 | `bash.ts` + `shell.ts` | `OutputAccumulator`：输出超限后**切到临时文件落盘**（全量留档、内存不爆，且永不切回内存避免 fd 竞态）；`onUpdate` 100ms 节流把部分输出流给 UI |
| edit 的唯一匹配 + 逆序多 edits + CRLF/BOM | `edit.ts` + `edit-diff.ts` | **fuzzy match**：精确匹配失败时做空白归一化的宽松匹配（可控放宽，绝不猜语义）；生成 diff 给 UI 渲染 |
| write 的 mkdir + 覆盖语义 | `write.ts` | abort 检查点（每个 await 之后查 `signal.aborted`，而非 listener 里 reject——防止锁提前释放） |
| `withFileMutationQueue` | `file-mutation-queue.ts` | 思路相同（61 行） |
| `resolveToCwd` | `path-utils.ts` | macOS 截图文件名窄空格、NFD、弯引号等真实世界路径修复 |

另外两个 pi 的设计值得记住，后面会反复见到：

- **工具结果是"双通道"的**：除了给模型看的 `content`（文本），还有给 UI 看的 `details`（结构化数据，比如 edit 的 diff、bash 的退出码）。模型和人类各看各的，互不污染。
- **工具的 `description` 是精心调过的 prompt**。比如 read 的 description 明确写 "Use offset/limit for large files... continue with offset until complete"——5.2 里模型会接力续读，一半功劳在这句话。**description 写得越像"使用说明书"，模型用得越对。**

## 5.10 为什么不止 4 个工具：搜索类工具的价值

pi 的默认工具集还有三个**只读检索**工具：`grep`、`find`、`ls`。你可能会问："模型不是能用 `bash` 跑 `grep` 吗，为什么要单独做工具？"答案恰好串起这一章的所有主题：

- **确定性 + 可控**：专用工具能统一截断（这章的双限制）、统一尊重 `.gitignore`、统一输出格式——bash 管道拼出来的结果格式不稳定，还依赖用户机器上装了什么版本。
- **自带工具链**：pi 的 `grep`/`find` 底层用 ripgrep/fd，而且**缺了会自动按需下载**（`ensureTool`）——工具不假设环境，缺了就自己补。
- **省上下文**：结构化截断 + 行号，避免把整棵目录树灌进上下文。
- **天然只读**：grep/find/ls 组成"只读工具集"（`createReadOnlyTools`），给"只许看不许改"的安全场景用。

实现上它们跟 bash 高度同构（spawn 子进程 + 流式读 + 截断），不再逐个展开。

## 5.11 这一章踩到的坑

1. **工具输出全文进上下文**——所以截断不是优化，是生存必需。行数和字节**双限制缺一不可**：行数管多行爆炸，字节管单行爆炸。
2. **read 保头、bash 保尾**——文件从头读，命令输出看末尾（报错堆栈在最后）。方向搞反，截出来的全是没用的。
3. **截断必须告诉模型"怎么继续"**——`Use offset=N to continue` 这一句话顶得上一套分页系统。工具输出是给模型看的 UI。
4. **首行超限要走单独的出路**——否则 `Use offset=1` 会让模型死循环。边界不处理，提示就会变成陷阱。
5. **`offset` 是 1-indexed**——对外跟 `head -n` 一致，内部数组才是 0-indexed，别混。
6. **kill 子进程要 `detached` + 负 pid 配套**——只杀直接子进程，孙子会变孤儿；没 `detached` 就负 pid，会把自己也杀了。
7. **bash 不设默认超时**——一刀切超时只会逼模型反复调大 timeout。让模型按需指定。
8. **edit 的 `oldText` 多次出现必须拒绝**——静默改第一个是最危险的行为。报错里写 `Please provide more context`，模型会自我修正。
9. **多 edits 全部按原文匹配、检查重叠、逆序应用**——正序应用 index 会漂移。
10. **CRLF/BOM 是"明明一样却匹配不上"的元凶**——读时归一化、写时还原，匹配永远在 LF 世界里做。
11. **并发写同一文件要按 `realpath` 排队**——而且"入队"这个动作本身也要串行（registration 链），否则 `await realpath` 期间顺序就乱了。
12. **工具出错返回结果、不 reject**——非零退出码、匹配失败都是模型需要的信息，不是异常。

## 5.12 本章产出

你现在拥有：

- 一份从零打磨出来、能跑真实项目的工具集 `code/ch05/tools.ts`：read（双限制截断 + 续读提示）、bash（进程组击杀 + 保尾截断）、edit（唯一匹配 + 多 edits 逆序 + CRLF/BOM）、write（mkdir + 覆盖），外加文件级写队列和路径清洗。
- 比代码更值钱的几条直觉：**工具输出是给模型看的 UI**、**破坏性操作宁可拒绝不要猜**、**截断要指路**、**边界不处理提示会变陷阱**。
- 一张对照表——再去读 pi 的 `tools/` 源码，每段"复杂"你都知道它在修哪个坑。

但现在工具还是**一个一个串行跑**的：模型说"读这三个文件"，我们读完一个再读下一个。下一章让它们并行起来——这会牵出执行顺序、结果回填、还有 5.6 那个写队列真正派上用场的时刻。

→ [第 6 章 并行工具调用](06-parallel-tools.md)
