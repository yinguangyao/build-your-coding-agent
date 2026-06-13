# 第 6 章 并行工具调用

> 📂 **本章配套代码**：[https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch06](https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch06)

> 上一章的工具已经能干活了，但循环里还藏着一个让我别扭的性能问题：模型说"把这三个文件都读一下"，我们却老老实实读完一个再读下一个。read 还好，几十毫秒的事；可要是模型一口气要跑三个 `bash`，每个五秒，串行就得干等十五秒——我坐在屏幕前看着进度条一格一格爬，心里知道它们根本互不依赖，纯属浪费。
>
> 这章要做的事，说穿了就是把那个 `for` 循环换成 `Promise.all`。但真动手改的时候你会发现，麻烦全在细节里：我连着踩了三个坑，其中两个不处理会直接让对话历史炸掉。老规矩，先写一版最直接的，跑起来看它哪儿出问题，再一个一个补。

## 6.1 先看跑出来的效果

别急着看代码，先看结果。下面这段是我真实跑出来的，DeepSeek 模型，输出一字没动：

```
$ npx tsx ch06/loop.ts "分别读一下 a.rs、b.py、c.ts，告诉我每个文件是什么语言"
[start]

[turn]
[tool] read({"path":"a.rs"})
[tool] read({"path":"b.py"})
[tool] read({"path":"c.ts"})
[result] def main():\n    print("hello")\n
[result] fn main() { println!("hello"); }\n
[result] console.log("hello");\n
[turn] 三个文件的内容和语言如下：…a.rs 是 Rust，b.py 是 Python，c.ts 是 TypeScript…
[end]
```

我盯着日志看了两遍，注意到两件事。

同一个 `[turn]` 里冒出了三个 `[tool]`——模型一次请求就甩了三个调用过来，我们接住了，一起跑。换上一章那个串行循环做同样的事，得来回三轮，而且有些模型还会保守到一轮只要一个。

`[result]` 的顺序和 `[tool]` 对不上。调用是 a、b、c 的次序，结果回来 b.py 却排在了最前面。我第一反应是 bug，查了半天才发现不是：并发嘛，谁先跑完谁先返回，乱序才是真实的信号。先记住这个"乱序"——后面你会看到，它只能出现在一个地方，换个别的地方乱序就是事故。

整章跑完，你会拿到这样一个循环（`code/ch06/loop.ts`）：准备阶段串行、执行阶段并行、结果按原始次序回填、遇到危险工具自动退回串行、还支持工具主动结束。

## 6.2 瓶颈一直在我们这边

有件事得先说清楚：并行这件事，不用去求模型配合，协议里它本来就能一次发多个。

回到第 2 章解析流式响应的时候，`tool_calls` 的增量就带着 `index`——第几个调用——我们当时给每个 index 都留了槽位。第 3 章的响应里它也一直是 `tool_calls: [...]`。模型只要判断这几件事互不依赖，就会在同一条 assistant 消息里塞多个调用，"读三个文件""查三个目录"都是家常便饭。

卡脖子的一直是我们。第 4 章的执行代码长这样：

```ts
for (const tc of assistant.tool_calls) {
  const result = await executeOne(opts.tools, tc, emit);   // ← 一个 await 完才轮到下一个
  messages.push({ role: "tool", tool_call_id: tc.id, content: result.text });
}
```

`for...of` 加 `await`，天然串行。三个 read 串行多等一百毫秒，忍忍也行；三个 `npm test` 级别的命令串行？那就是纯粹的浪费，它们之间压根没有先后关系。

> 顺带一提，有些模型偏保守，不主动并行。我在入口的 system prompt 里写了一句"可以一次发起多个工具调用"。这和第 5 章说的"工具 description 是写给模型的说明书"一个道理——想让它怎么做，得明确写出来，别指望它自己悟。

## 6.3 第一刀：`Promise.all`

最直接的改法，把 `for...of` 换成 `Promise.all`：

```ts
const results = await Promise.all(
  assistant.tool_calls.map(async (tc) => {
    const tool = opts.tools.find((t) => t.name === tc.name);
    await emit({ type: "tool_execution_start", /* ... */ });
    const r = await runOne(tool, tc);
    await emit({ type: "tool_execution_end", /* ... */ });
    return r;
  }),
);
for (const r of results) messages.push({ role: "tool", tool_call_id: r.tc.id, content: r.text });
```

跑起来确实快了。我高兴了两分钟，然后三个问题接连找上门。

### 副作用工具会互相打架

假设模型发来一批 `[edit a.ts, edit a.ts]`——同一个文件改两处，拆成了两个调用。这就是上一章 5.6 埋的伏笔，"一个还没发生、但马上会发生的事故"。好在当时已经给 `edit` 和 `write` 套了按文件排队的 `withFileMutationQueue`，同一个文件的写会自动串起来，这一下正好接住。

但 `bash` 没有这层保护。模型如果同时发两个 `git add && git commit`，两个子进程对着同一个 `.git` 操作，可能撞出 `index.lock` 冲突。文件锁在这里也帮不上忙——bash 的副作用是任意的，锁不知道该锁哪个文件。

我由此画了一条分界线：只读的工具（read）可以随便并行；有副作用的，要么自带细粒度的锁（比如 edit/write 的文件队列），要么就别并行。这条先放着，6.5 再处理。

### 一个出错，整批报废

`Promise.all` 有个脾气：数组里任何一个 promise reject，整个 all 立刻 reject，其他已经完成的结果一起丢掉。某个工具执行时 throw 了，这批里其他几个即使成功了也拿不到。

更麻烦的是后果。assistant 那条带 `tool_calls` 的消息已经进了 messages，配对的 tool 结果却一条都没补上——下次请求直接报 400，也就是第 3 章讲过的配对规则。我亲眼见过这种 400，排查了半天才发现是并发里一个 throw 把整批拖下水。

所以并发执行有一条铁律：执行函数不要 throw，所有错误就地包成结果对象。第 4 章其实已经立过这条规则（工具出错不抛、包成结果），只是当时是串行，throw 顶多难看一点；并发之后，一次 throw 会牵连一整批。

### 连准备工作也一起并发了

仔细看 `map` 里那段，它不只在 `execute`，还夹着"找工具、发 start 事件、解析参数"这些执行前的准备。这些准备一起并发，给我带来两个麻烦。

`[tool]` 事件乱序发出，界面上三行 start 以随机次序蹦出来，还和"Tool not found"这类校验错误穿插在一起，看着眼晕。更关键的是，后面我们要在工具执行前挂钩子（拦截危险命令那种，留到扩展系统讲），钩子带有副作用——改计数器、弹确认框——并发执行就会互相干扰。

这些准备工作有一个共同点：都很快，微秒级，并行也省不下时间；但它们都对顺序敏感。真正慢、真正值得并行的，只有 `execute` 本身。

## 6.4 三段式：prepare 串行，execute 并行，回填按源顺序

把上面两个坑的结论合起来，结构就出来了：一批工具调用分三段处理。下面是完整实现，和 `code/ch06/loop.ts` 里的一致：

```ts
async function executeBatchParallel(
  toolCalls: ToolCall[],
  tools: RuntimeTool[],
  emit: EventSink,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  type Entry = ResultEntry | (() => Promise<ResultEntry>);
  const entries: Entry[] = [];

  // ── 阶段 A：串行 prepare ──
  // 发 start 事件、找工具、（将来的钩子都挂这）。全是快操作，顺序敏感，串行零成本。
  for (const tc of toolCalls) {
    await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: parseArgs(tc.arguments) });
    const tool = tools.find((t) => t.name === tc.name);
    if (!tool) {
      // 校验失败：直接生成结果对象，不进并发
      const r: ResultEntry = { tc, text: `Tool "${tc.name}" not found`, isError: true, terminate: false };
      await emit({ type: "tool_execution_end", toolCallId: tc.id, result: r.text, isError: true });
      entries.push(r);
      continue;
    }
    // 校验通过：包成 thunk（先不执行），留给阶段 B 并发
    entries.push(async () => {
      const r = await runOne(tool, tc);
      await emit({ type: "tool_execution_end", toolCallId: tc.id, result: r.text, isError: r.isError });
      return r;
    });
  }

  // ── 阶段 B：并行 execute ──
  const finalized = await Promise.all(
    entries.map((e) => (typeof e === "function" ? e() : Promise.resolve(e))),
  );

  // ── 阶段 C：按【源顺序】生成 tool result messages ──
  const messages = finalized.map((f) => ({
    role: "tool" as const,
    tool_call_id: f.tc.id,
    content: f.text.slice(0, 4000),
  }));
  const terminate = finalized.length > 0 && finalized.every((f) => f.terminate);
  return { messages, terminate };
}
```

`terminate` 字段是 6.7 的内容，这里先忽略。我想单独唠两句别的。

先说 thunk 这个写法。阶段 A 没有真的去执行工具，而是把"接下来要做的动作"包成一个函数（thunk），扔进数组；校验没通过的就直接放一个结果对象。等到阶段 B 才统一执行。这样一来，"准备"和"执行"在代码上就分开了——钩子始终在串行区，慢操作始终在并行区。我第一次看到这种写法是在别人的代码里，当时觉得绕，自己写了一遍才发现清晰。

再说顺序——这是整章最需要啃透的一点。这里有两条顺序，要求正好相反。

| | 顺序 | 为什么 |
| --- | --- | --- |
| 事件（`tool_execution_end`） | 按完成，谁先跑完谁先发 | 事件是给 UI 看的实时进度。6.1 里 b.py 先回来，界面上就该先显示它 |
| 消息（`role:"tool"`） | 按源，即 `tool_calls` 数组原本的次序 | 消息是给模型和协议看的。`Promise.all` 的返回值天然保持入参顺序，所以阶段 C 直接 map 出来的 messages，和 assistant 那条 `tool_calls` 一一对应 |

如果把这两条混在一起——比如按完成顺序去 push messages——模型下一轮看到的历史就成了"问 A 答 B"的错位。我踩过一次，模型下一轮完全懵了，输出的内容和上下文对不上。所以我的记法是：事件这条乱序没关系，乱序才说明是真并发；消息这条乱序就是事故。

## 6.5 同一轮里混了 bash，就全部改回串行

先把话说清楚。6.1 那次跑法还记得吧——**一轮** `[turn]` 里，模型一口气甩了三个 `[tool]`：

```
[tool] read({"path":"a.rs"})
[tool] read({"path":"b.py"})
[tool] read({"path":"c.ts"})
```

这三个调用来自**同一条** assistant 消息，在代码里就是 `assistant.tool_calls` 这个数组。一轮对话里模型可能只调一个工具，也可能像这样一次调好几个；**我们这章讨论的「并行」，指的就是这一组调用怎么处理**——一起跑，还是一个接一个跑。

pi 源码里函数名叫 `executeBatchParallel`，`batch` 就是这个意思：同一条回复里的那组 `tool_calls`。不是「批处理作业」那种批，也不是跨好几轮攒起来一起跑。就一轮，就这一组。

好，副作用工具那条尾巴还没处理。`read` 只读，并行没事；`bash` 能跑任意命令，我们没法像 `edit` 那样按文件加锁。怎么办？

我的办法：给每个工具贴一个标签，告诉循环「这个能不能跟别人一起跑」。然后定一条简单规则——**这一组里只要混进一个不能并行的，就放弃并行，全部按模型给的顺序一个个来**。

```ts
export type RuntimeTool = Tool & { executionMode?: "sequential" | "parallel" };

function batchIsSequential(toolCalls: ToolCall[], tools: RuntimeTool[]): boolean {
  return toolCalls.some((tc) => tools.find((t) => t.name === tc.name)?.executionMode === "sequential");
}
```

你可能会问：为啥不聪明一点——只把 `bash` 单独拎出来串行，剩下的 `read` 照样并行？

我试过这么想，后来发现模型在一组调用里常常藏着先后关系。比如同一轮里它发来 `[read 配置, bash 跑迁移]`，意图多半是先看配置再跑迁移。可一旦部分并行，`bash` 完全可能赶在 `read` 之前跑完，那个隐含的顺序就破了。所以我的取舍很粗暴：这一组里只要混进一个有副作用的，就全部按模型列出来的顺序一个个执行。代码里叫 `executeBatchSequential`，其实就是第 4 章那个 `for...of` 循环：

```ts
async function executeBatchSequential(
  toolCalls: ToolCall[],
  tools: RuntimeTool[],
  emit: EventSink,
): Promise<{ messages: ToolResultMessage[]; terminate: boolean }> {
  const results: ResultEntry[] = [];
  for (const tc of toolCalls) {
    const tool = tools.find((t) => t.name === tc.name);
    await emit({ type: "tool_execution_start", toolCallId: tc.id, toolName: tc.name, args: parseArgs(tc.arguments) });
    const r = await runOne(tool, tc);
    await emit({ type: "tool_execution_end", toolCallId: tc.id, result: r.text, isError: r.isError });
    results.push(r);
  }
  const messages = results.map((r) => ({ role: "tool" as const, tool_call_id: r.tc.id, content: r.text.slice(0, 4000) }));
  const terminate = results.length > 0 && results.every((r) => r.terminate);
  return { messages, terminate };
}
```

给第 5 章那四个工具打的标签，写在入口里：

```ts
const tools = makeCodingTools(process.cwd()) as RuntimeTool[];
for (const t of tools) {
  t.executionMode = t.name === "read" ? "parallel" : "sequential";
}
```

read 只读，可以并行；bash、edit、write 标 sequential，保证正确，不追求快。

这里得坦白一下：上面这个标法是我 mini 版图省事的选择，pi 自己并不这么做。`executionMode` 这套标签机制，以及「一组里混进危险工具就全部串行」这条规则，pi 和我们写的一致（`agent-loop.ts:381-388`）。但它默认的工具集里，bash、edit、write 一个都没标 sequential，全部走并行。edit/write 的写安全，pi 完全交给上一章那个按文件路径的 mutation queue——同文件排队，不同文件照常并行，比我们这个粒度细。至于 bash，它干脆不加锁，赌模型不会在同一轮里同时发两个互相冲突的命令。

我反过来给 bash 贴 sequential 标签，原因只是 mini 版不想给每个工具单独设计锁。细粒度锁性能好，但要逐个工具去做；「一组里有危险的就全串行」粒度粗，但绝对不会出错。两种都见过了，自己写的时候按场景选——没有标准答案，只有取舍。

## 6.6 模型一次发二十个，要不要限流？

6.4 那个 `Promise.all` 是全开的，模型发几个就同时跑几个，没有上限。我一度纠结过：要是模型一次发二十个呢？相当于瞬间 fork 二十个子进程；工具要是网络请求，相当于对下游一次打出二十个并发。要不要加一道"最多同时跑 N 个"的闸？

我去翻了 pi 的源码，它的答案是不限流。`executeToolCallsParallel` 就是一个裸的 `Promise.all`，没有并发上限。不加这道闸，背后有几个比较实际的理由：

- 一批有多大是模型决定的，而模型其实比较克制。一条 assistant 消息里的 `tool_calls` 是它一次生成的，要为每个调用想清楚参数，我实测下来一批通常是 2 到 5 个，不会无脑发二十个。
- 真正重的工具，本来就该标 sequential（见 6.5）。bash 一旦 sequential，整批降级，限流的问题落不到它头上，只剩下轻量工具。
- read 这种本地 IO，并发二十个也没有压力，Node 底层的 libuv 线程池本身就是一道天然的闸。

所以对一个自带工具集的 coding agent 来说，限流基本是个伪需求，加上只会增加复杂度。

但换一个场景，结论就反过来。如果工具是网络调用——查 API、爬网页、调内部服务——下游往往有 rate limit、有连接数上限，二十个并发就是自己打垮自己。这时候一个十行的信号量就够用：

```ts
function pLimit(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));   // 满了就排队
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();                                                 // 放行下一个
    }
  };
}

// 接进 6.4 的阶段 B，就改一行：
const limit = pLimit(4);
const finalized = await Promise.all(
  entries.map((e) => (typeof e === "function" ? limit(e) : Promise.resolve(e))),
);
```

有个细节别误会：限流不改变任何顺序保证。事件还是按完成顺序发，消息还是按源顺序回填，它只是把"同一时刻在跑的数量"压到 4。我们的 `code/ch06/loop.ts` 和 pi 一样默认不开，保持最简，但这十行随时可以加上。

我自己的结论是：限流是工具的事，不是循环的事。本地工具不需要，网络工具需要。与其在循环里加一道一刀切的全局闸，不如让需要限流的工具自己内部带上 `pLimit(4)`，循环本身保持简单。讲到扩展系统时，还会再遇到这个分工——能力归工具，编排归循环。

## 6.7 让工具能结束循环：terminate

最后补一个小能力，但挺实用。有些工具一旦执行完，就意味着这一轮可以结束了——比如一个 `submit_answer` 或者 `complete_task`。与其让模型再生成一轮"好的我做完了"，不如让工具直接告诉循环：可以停了。

做法很轻。把工具的返回值从单纯的 `string`，放宽成"`string` 或者 `{ text, terminate? }`"，然后在 `runOne` 里统一处理：

```ts
type ResultEntry = { tc: ToolCall; text: string; isError: boolean; terminate: boolean };

async function runOne(tool: RuntimeTool | undefined, tc: ToolCall): Promise<ResultEntry> {
  if (!tool) return { tc, text: `Tool "${tc.name}" not found`, isError: true, terminate: false };
  const args = parseArgs(tc.arguments);
  try {
    const out: any = await tool.execute(args);
    if (typeof out === "string") return { tc, text: out, isError: false, terminate: false };
    return { tc, text: out.text ?? "", isError: false, terminate: !!out.terminate };
  } catch (err: any) {
    // 上面那个坑的要求：不要 throw，错误就地变结果
    return { tc, text: `Error: ${err?.message ?? String(err)}`, isError: true, terminate: false };
  }
}
```

批级别的判定用的是 `every`——所有工具都说停，才真的停。你可能会觉得 `some`（有一个喊停就停）更顺手，但我踩过一个反例：模型发了 `[save_state, complete_task]`，save_state 还没落盘，complete_task 一句"停"就把循环结束了，状态没存全。所以这里必须用 `every`。第 5 章那四个工具都只返回 `string`，所以这个口子默认不会触发，它是专门留给自定义工具的。

## 6.8 组装：完整主循环

三段式、降级开关、terminate，主循环把这几样串起来就完整了，和 `code/ch06/loop.ts` 一致：

```ts
export async function runAgentLoop(opts: {
  baseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  userInput: string;
  tools: RuntimeTool[];
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

    // 同 ch04：先判截断，被 max_tokens 切断的消息可能残缺，不能继续
    if (assistant.finish_reason === "length") {
      throw new Error("模型输出被 max_tokens 截断（finish_reason=length）");
    }

    messages.push(toOpenAIAssistantMsg(assistant));

    if (assistant.tool_calls.length === 0) {
      await emit({ type: "turn_end" });
      break;
    }

    // 本章的全部新东西就这几行：选模式 → 跑批 → 按源顺序回填 → 看要不要结束
    const sequential = batchIsSequential(assistant.tool_calls, opts.tools);
    const batch = sequential
      ? await executeBatchSequential(assistant.tool_calls, opts.tools, emit)
      : await executeBatchParallel(assistant.tool_calls, opts.tools, emit);

    for (const m of batch.messages) messages.push(m);
    await emit({ type: "turn_end" });

    if (batch.terminate) break;
  }

  await emit({ type: "agent_end", messages });
  return messages;
}
```

和第 4 章的循环对比，骨架没有变，只是把"for...of 逐个执行"那段换成了"先选模式、再跑批"。文件末尾还是那个 main-module 守卫的入口（检查环境变量、给工具打标签、复用 `consoleEmit`），所以 6.1 那段记录照着就能复现：

```bash
cd code
npx tsx ch06/loop.ts "分别读一下 a.rs、b.py、c.ts，告诉我每个文件是什么语言"
```

想看"整批降级"的效果，把任务换成既要 read 又要 bash 的，比如"读一下 package.json，再跑 npm ls 看依赖"。这批里混了一个 sequential 的 bash，于是 `[tool]` 和 `[result]` 会规整地交替出现——和 6.1 里那种乱序一对比，区别一眼就看出来了。

## 6.9 对照 pi 的工业级实现

写完这章，我打开 `packages/agent/src/agent-loop.ts` 对照了一遍，结构基本能对上：

| 我们这章 | pi 源码 | pi 多做的 |
| --- | --- | --- |
| 阶段 A 串行 prepare | `executeToolCallsParallel` 的 prepare 段 | `beforeToolCall` 钩子能 `{block:true}` 把工具拦下来（扩展系统的入口，后面讲）；abort 信号也在这里逐个检查 |
| 阶段 B 并行 execute，事件按完成顺序 | 同款 `Promise.all` thunk | 工具内部还能一边跑一边流式上报进度（`onUpdate` 节流） |
| 阶段 C 按源顺序回填 | 同款 | —— |
| `batchIsSequential` 整批降级 | `agent-loop.ts:381-388` 同款规则 | 但默认工具集没人标 sequential（见 6.5 的说明），写安全靠文件级 mutation queue |
| `terminate` + `every` 语义 | `shouldTerminateToolBatch` | —— |

pi 的取向我概括成一句话：机制上它准备好粗粒度的开关（executionMode），实践上它依赖细粒度的锁（文件队列）。我们 mini 版正好相反，用粗粒度换省心。两边没有优劣之分——现在的代码你都读得懂，自己写的时候按场景选就行。

## 6.10 我踩过的坑，帮你省点时间

- `Promise.all` 不容忍 reject。一个 throw 会牵连整批，跑完的结果全部丢掉，还会留下"有 tool_calls、没 tool 结果"的 400 隐患。执行函数必须把错误就地包成结果，别往外抛。
- 两条顺序分开维护：事件按完成，消息按源。事件乱序是真实进度（6.1 里 b.py 先回来），消息乱序是协议事故（问 A 答 B）。
- prepare 这段必须串行。校验、start 事件、钩子都快、都对顺序敏感，并行没有收益，只剩竞态。真正值得并行的只有 execute。
- 整批降级比"只串那一个"稳。一批里常藏着隐含的先后，混进有副作用的工具，就按模型给的次序全部串行。
- 粗粒度降级和细粒度锁是两套思路。pi 用文件队列加默认全并行，我们用 executionMode 一刀切。别一看到"机制存在"就以为"默认开着"。
- `terminate` 用 `every` 不用 `some`。用 some 会把 `[save_state, complete_task]` 里还没收尾的那个提前结束。
- 限流是工具的事，不是循环的事。本地工具加全局闸是伪需求，网络工具不加是事故。pi 的循环不限流，把这个上限留给工具自己管。
- 上一章那个伏笔在这章兑现了。5.6 说的"还没发生的事故"，就是这章两个 edit 并发改同一个文件。没有当时那个写队列，这章的并行根本不敢开。

## 6.11 本章产出

到这里你手上有了：

- 一个完整的循环（`code/ch06/loop.ts`）：prepare 串行、execute 并行、按源顺序回填、危险批自动降级、支持 terminate。骨架和第 4 章完全同构，一条命令就能复现 6.1 那段并行记录。
- 三条我自己总结的并发经验：执行不要 throw、事件按完成消息按源、对顺序敏感的准备工作留在串行区。
- 一双能分辨"整批降级"和"文件级细粒度锁"的眼睛，以及对 pi 在真实代码里选了哪边、为什么的理解。

工具讲到这里有一个绕不开的局限：它是写死在代码里的，想加一个能力就得改源码、重新部署。下一章我们看两条不改代码也能给 agent 加本事的路：技能（Skills），以及业界另一条标准路线 MCP。
