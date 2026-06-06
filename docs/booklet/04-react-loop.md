# 第 4 章 ReAct 循环

> 📂 **本章配套代码**：[https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch04](https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch04)

> 第 3 章我们做了**一次**模型 → 工具 → 模型往返。但真实任务往往要多轮：
>
> > 用户："找出当前目录里所有包含 TODO 的 .ts 文件并告诉我每个 TODO 在做什么。"
> >
> > 模型：[调 `ls`] → 看到目录 → [调 `grep TODO`] → 看到匹配 → [调 `read_file` x3 读每个文件相关行] → 综合后回答。
>
> 模型需要**自己决定下一步该做什么**，而不是把 5 步路线写死在我们代码里。这一章我们把"一次往返"扩展成"循环"，让模型自己驱动多步。

## 4.1 这一章要做什么

跑起来：

```bash
$ npx tsx loop.ts "找出当前目录所有包含 TODO 的 .ts 文件，列出每条 TODO"
[turn 1]
[模型] (调工具)
[工具] bash({"command":"ls *.ts"}) → "loop.ts\ntools.ts\n"
[turn 2]
[模型] (调工具)
[工具] bash({"command":"grep -nH TODO loop.ts tools.ts"}) → "loop.ts:42: // TODO: handle abort\n..."
[turn 3]
[模型]
当前目录里 2 个 .ts 文件都有 TODO：
- loop.ts:42 —— 处理 abort 信号
- tools.ts:15 —— 校验 path 参数
```

写完你会拥有：

- 一个能跑无限轮工具调用的 `runAgentLoop()` 函数。
- "ReAct loop" 这个术语的清晰理解：模型自己**Reason**、**Act**、**Observe**、再 **Reason**……直到它认为任务结束。
- 一个轻量的事件流（`agent_start` / `turn_start` / `tool_execution_*` / `turn_end` / `agent_end`），UI 可以订阅它做实时显示。这也是 pi 真实 agent 循环的事件契约。

明确**不**做：

- 不做并行工具调用（一次发起多个 tool call 同时执行）。后面会讲。
- 不做 abort/cancel。后面会讲。
- 不做用户中途插队（steering）。后面会讲。

我们这一章只做"最朴素的串行循环"，保持心智简洁。

## 4.2 "ReAct"是什么

ReAct 这个名字出自 2022 年 Yao 等人的论文《[ReAct: Synergizing Reasoning and Acting in Language Models](https://arxiv.org/abs/2210.03629)》。它的核心想法只有一句话：

> 让模型在每一步里**先用自然语言推理一下下一步要干嘛**（Reasoning），**然后实际调一个工具**（Acting），**拿到结果**（Observation），**再推理下一步**。

伪代码长这样：

```
loop {
  thought = LLM("当前历史 + 问题，思考下一步：")
  if thought 说"我已经知道答案了":
    return answer
  action = LLM("基于上面 thought 决定调哪个工具")
  observation = execute(action)
  history.append(thought, action, observation)
}
```

最初的 ReAct 论文里"thought / action / observation"是**用纯文本 prompt 模拟的**——因为那个年代还没有函数调用 API。模型被要求按格式输出：

```
Thought: 我需要先看下目录里有什么文件
Action: bash(ls *.ts)
Observation: loop.ts\ntools.ts
Thought: 现在 grep 一下
Action: ...
```

然后开发者写正则去 parse 模型输出，提取 `Action:` 和 `Observation:`。这非常脆——模型偶尔少写一个 `Thought:` 整个 parser 就崩了。

OpenAI 在 2023 年推出 function calling（也就是我们前两章用的 `tools` + `tool_calls`）之后，**这套用纯文本模拟的 ReAct 协议被替换成了"模型直接发结构化 `tool_calls` JSON"**。但思路没变：

- **Reasoning** ⇒ 模型在 `content` 字段里写的文字推理
- **Acting** ⇒ 模型生成的 `tool_calls`
- **Observation** ⇒ 我们执行工具后塞回去的 `role: "tool"` 消息

所以**用 function calling 实现的 agent 循环就是 ReAct 循环的现代版本**。今天大家口头说"agent loop"基本指的就是这个。

> pi 自己的循环（`packages/agent/src/agent-loop.ts:runLoop`）就是这套结构，只是工业级实现还加了并行、abort、steering 等增量功能。

## 4.3 循环的退出条件

第 3 章我们只做了一次"二次提问"就停了。现在要变成 `while (true)`，**那什么时候跳出？**

看一下每次模型回复后我们能拿到的信息：

```ts
{
  role: "assistant",
  content: "...",                   // 可能空（这次只调工具）
  tool_calls: [...],                // 可能空（这次只说话）
  finish_reason: "stop" | "tool_calls" | "length" | ...
}
```

跳出条件用一句话讲就是：**"模型这次没要求调工具"**。具体到字段判定，等价于：

- `finish_reason === "length"`：触发 `max_tokens` 上限被截断。**这一条必须最先判断**——被截断的消息可能是残缺的（甚至 tool_call 拼了一半），不能当成正常结果继续。
- `finish_reason === "stop"`：模型说"我说完了"。
- `tool_calls.length === 0`：理论上跟 `finish_reason === "stop"` 一致，但**做一个稳健的兜底**，因为 provider 偶尔会回怪值。
- `finish_reason === "tool_calls"` 且 `tool_calls.length > 0` ⇒ **继续循环**。

伪代码（注意 `length` 检查放在最前面）：

```ts
while (true) {
  const assistant = await streamOnce(messages);

  // 先判截断：截断的消息可能残缺，不能 push 进去继续聊
  if (assistant.finish_reason === "length") {
    throw new Error("被 max_tokens 截断");
  }
  messages.push(assistant);

  if (assistant.tool_calls.length === 0) {
    return;  // 自然结束
  }

  // 执行所有 tool_calls，把结果都塞回去
  for (const tc of assistant.tool_calls) {
    const result = await executeOne(tc);
    messages.push({ role: "tool", tool_call_id: tc.id, content: result });
  }
}
```

> 如果把 `tool_calls.length === 0` 的判断放在 `length` 检查**之前**，就会踩坑：一次被 `max_tokens` 截断、还没来得及发出任何 tool_call 的回合（`finish_reason === "length"` 且 `tool_calls.length === 0`）会被误判成"自然结束"，循环静默退出，用户拿到一段没头没尾的残缺答复却不知道发生了什么。

记住一个**反直觉**的点：我们**永远不显式调用"最后一次模型"**。最后一次模型调用是循环里 `streamOnce()` 自然发生的，只是这次模型决定不再调工具、`tool_calls.length === 0`，于是我们 return 退出。这点很重要——意味着用户看到的最终答复**总是**循环里某一次 `streamOnce` 的输出。

## 4.4 为什么要事件流

光会跑循环还不够。终端 UI 需要知道：

- 现在是第几轮？
- 这一轮是模型在说话还是在调工具？
- 工具执行到第几个了？
- 工具的部分输出（比如 bash 打了一行 stderr）有没有进展？

一种粗暴办法是循环里到处 `console.log`，但那样调用方就被死死绑在终端上，没法把同一个 agent 嵌进 web UI 或者 Slack bot。

**正确的解耦方式**：循环只关心业务（调模型、跑工具），UI 关心展示。中间用"事件"做桥梁——循环每发生一件大事就发射一个事件对象，调用方决定怎么展示。这就是 pi 的 `AgentEvent`（`packages/agent/src/types.ts:403-418`）。

我们的最小事件清单：

```ts
type AgentEvent =
  | { type: "agent_start" }                          // 整个循环开始
  | { type: "agent_end"; messages: any[] }           // 整个循环结束
  | { type: "turn_start" }                           // 新一轮模型调用开始
  | { type: "turn_end" }                             // 一轮结束（assistant + 所有 tool result）
  | { type: "message_delta"; delta: string }         // 模型流式吐字符
  | { type: "tool_execution_start"; toolCallId: string; toolName: string; args: any }
  | { type: "tool_execution_end"; toolCallId: string; result: string; isError: boolean };
```

跟 pi 真实的事件类型比一下：

- pi 多了 `message_start` / `message_update` / `message_end`（区分用户消息、assistant、tool 各自的完整生命周期）。我们简化成只发 `message_delta`。
- pi 多了 `tool_execution_update`（工具自己流式回报进度，比如 bash 一行一行打 stdout）。我们这一章先不要这个。

**注意 `agent_start` / `agent_end` 之间会有多个 `turn_start` / `turn_end`**——一个"turn"是"一次 model 调用 + 它请求的所有 tool 执行"。一次 agent 运行通常 2-10 个 turn。

## 4.5 事件 sink（接收器）

事件"怎么发"也有讲究。两种典型形态：

| 形态 | 形如 | 优点 | 缺点 |
| --- | --- | --- | --- |
| 回调（callback） | `(event) => void` | 简单 | 调用方不能优雅地 await |
| 异步迭代器（pull） | `for await (const ev of loop())` | 跟我们的流式 API 风格统一 | 实现复杂一点 |

pi 用的是**回调 + 内部 await**：循环每发一个事件就调用 `emit(event)`，并 `await` 它，让 hook 可以做异步处理（写文件、发请求）。我们这一章就用最简单的 callback。

```ts
type EventSink = (event: AgentEvent) => Promise<void> | void;
```

把它作为 `runAgentLoop()` 的最后一个参数。

## 4.6 写代码

`code/ch04/loop.ts`，约 230 行。先看全貌再分块。

### 整体结构

```ts
// 复用第 2、3 章
import { streamOpenAI, type AssistantMessage } from "../ch02/hello.js";
import { type Tool, buildToolsParam } from "./tools.js";

type AgentEvent = /* ... 上面定义 ... */;
type EventSink = (event: AgentEvent) => Promise<void> | void;

export async function runAgentLoop(opts: {
  baseUrl: string;
  apiKey:  string;
  model:   string;
  systemPrompt: string;
  userInput: string;
  tools: Tool[];
  maxTurns?: number;
  emit?: EventSink;
}) {
  const messages: any[] = [
    { role: "system", content: opts.systemPrompt },
    { role: "user",   content: opts.userInput },
  ];
  const emit = opts.emit ?? (() => {});
  const maxTurns = opts.maxTurns ?? 25;

  await emit({ type: "agent_start" });

  let turn = 0;
  while (turn < maxTurns) {
    turn++;
    await emit({ type: "turn_start" });

    // 1) 流式调一次模型
    const assistant = await streamOnce(opts, messages, emit);

    // 2) 先判截断：被 max_tokens 截断的消息可能残缺，不能继续
    if (assistant.finish_reason === "length") {
      throw new Error("模型输出被 max_tokens 截断（finish_reason=length）");
    }

    messages.push(toOpenAIAssistantMsg(assistant));

    // 3) 看是否要调工具
    if (assistant.tool_calls.length === 0) {
      await emit({ type: "turn_end" });
      break;
    }

    // 4) 串行执行每个 tool_call
    for (const tc of assistant.tool_calls) {
      const result = await executeOne(opts.tools, tc, emit);
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: result.text.slice(0, 4000),
      });
    }

    await emit({ type: "turn_end" });
  }

  await emit({ type: "agent_end", messages });
  return messages;
}
```

下面逐段拆。

### 第 1 段：初始化和 emit 兜底

```ts
const emit = opts.emit ?? (() => {});
const maxTurns = opts.maxTurns ?? 25;
```

- `emit` 没传就用空函数，循环里不用每次都 `if (opts.emit)` 检查。
- `maxTurns` 是**硬性安全网**。如果模型陷入死循环（一直调 `current_time` 不停下来），跑 25 轮就停。pi 的真实循环里没有写死的 `maxTurns`——它靠 `shouldStopAfterTurn` 钩子（`packages/agent/src/types.ts:208`）让上层应用决定，而上层是结合 token 用量、用户中断、auto-compaction 来判断的。我们这一章不引入这套，简单粗暴。

### 第 2 段：主循环骨架

```ts
let turn = 0;
while (turn < maxTurns) {
  turn++;
  await emit({ type: "turn_start" });
  const assistant = await streamOnce(opts, messages, emit);
  if (assistant.finish_reason === "length") {
    throw new Error("被 max_tokens 截断");   // 先判截断
  }
  messages.push(toOpenAIAssistantMsg(assistant));
  if (assistant.tool_calls.length === 0) {
    await emit({ type: "turn_end" });
    break;
  }
  // ... 执行工具 ...
  await emit({ type: "turn_end" });
}
```

这就是 ReAct 循环的核心。一行行看：

- `await emit({ type: "turn_start" })`——告诉 UI 新一轮开始。**用 `await` 而不是 fire-and-forget**：如果 UI 的回调里要做异步存档，循环要等它做完再继续。这样事件顺序在调用方看到的视角下永远是线性的，不会"turn_start 还没渲染出来 tool 就开始打字了"。
- `streamOnce(...)`：包装了第 2 章的 `streamOpenAI`，每收到一个 `delta` 就发一个 `message_delta` 事件，最后返回完整 `AssistantMessage`。
- `if (assistant.finish_reason === "length") throw`：**在 push 之前**先拦截截断。被 `max_tokens` 切断的消息可能是残缺的（tool_call 拼了一半、JSON 不完整），塞回历史只会让下一轮更乱，直接抛错让上层决定怎么办。
- `messages.push(toOpenAIAssistantMsg(assistant))`：把这一轮 assistant 的内容**塞回历史**——下一轮请求要带上。
- `if (assistant.tool_calls.length === 0) break`：没要求调工具，循环退出。**注意不是 `return`**，是 `break`——后面还有 `agent_end` 要发。
- 否则进入 tool 执行块。

### 第 3 段：streamOnce 包装

```ts
async function streamOnce(
  opts: { baseUrl: string; apiKey: string; model: string; tools: Tool[] },
  messages: any[],
  emit: EventSink,
): Promise<AssistantMessage> {
  let finalMessage: AssistantMessage | undefined;
  for await (const ev of streamOpenAI({
    baseUrl: opts.baseUrl,
    apiKey: opts.apiKey,
    model: opts.model,
    messages,
    tools: buildToolsParam(opts.tools),
  })) {
    if (ev.delta) {
      await emit({ type: "message_delta", delta: ev.delta });
    }
    if (ev.done) {
      finalMessage = ev.done;
    }
  }
  if (!finalMessage) throw new Error("流结束但没拿到完整消息");
  return finalMessage;
}
```

这是把第 2 章的"消费 `streamOpenAI` 迭代器"包成一个 `Promise<AssistantMessage>` 的工具。它做了一件事：

- 路过 `delta` 时通过 `emit` 转发出去，让 UI 实时显示。
- 路过 `done` 时记下来。
- 流结束后返回 `done` 里的完整消息。

如果你担心 `for await` 中途抛错没人接，可以用 `try { ... } catch { emit error event }` 包一下。pi 在这一层有专门的错误归一化（`packages/ai/src/types.ts:212-216` 规定 stream 函数"不能抛，错误必须以 stopReason='error' 的 AssistantMessage 形式 yield 出来"）——我们这一章简化处理。

### 第 4 段：执行单个 tool_call

```ts
async function executeOne(
  tools: Tool[],
  tc: { id: string; name: string; arguments: string },
  emit: EventSink,
): Promise<{ text: string; isError: boolean }> {
  const tool = tools.find((t) => t.name === tc.name);
  let args: any = {};
  try { args = JSON.parse(tc.arguments || "{}"); } catch {}

  await emit({
    type: "tool_execution_start",
    toolCallId: tc.id,
    toolName: tc.name,
    args,
  });

  let text: string;
  let isError = false;

  if (!tool) {
    text = `Tool "${tc.name}" not found`;
    isError = true;
  } else {
    try {
      text = await tool.execute(args);
    } catch (err: any) {
      text = `Error: ${err?.message ?? String(err)}`;
      isError = true;
    }
  }

  await emit({
    type: "tool_execution_end",
    toolCallId: tc.id,
    result: text,
    isError,
  });

  return { text, isError };
}
```

要点跟第 3 章一致：

- **不抛错**。工具找不到也好、执行炸了也好，都包装成"错误结果文本"返回，让模型自己看到并纠正。
- 发 `tool_execution_start` / `tool_execution_end` 两个事件，UI 用它们画进度条/打勾。
- `JSON.parse(tc.arguments || "{}")` 容错——arguments 偶尔是空字符串（无参工具的某些模型实现）。

### 第 5 段：循环里"串行"调用工具

```ts
for (const tc of assistant.tool_calls) {
  const result = await executeOne(opts.tools, tc, emit);
  messages.push({
    role: "tool",
    tool_call_id: tc.id,
    content: result.text.slice(0, 4000),
  });
}
```

**串行**就是这个简单的 for 循环。每个工具等上一个 await 完成再开始。

为什么先串行？因为：

1. **顺序明确**，方便理解和调试。
2. **结果回填顺序跟 `tool_calls` 数组顺序一致**，避免 `messages` 里 tool 结果错乱。
3. 大多数 coding agent 工具有副作用（写文件、改 git），并发跑反而出问题。

后面我们会引入"安全的工具可以并行执行"。pi 的 `agent-loop.ts` 同一段循环里也分两种模式：`executeToolCallsSequential`（串行）和 `executeToolCallsParallel`（并行），由 `executionMode` 字段决定。

### 第 6 段：messages 转换

```ts
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
```

跟第 3 章一样，把我们内部的扁平 `tool_calls` 还原成 OpenAI 协议要求的嵌套结构。`content: m.content || null` 在有 tool_calls 时必须是 `null`。

## 4.7 主程序：把循环跑起来

```ts
const SYSTEM = `你是一个能调用工具的助手。当用户要查文件或跑命令时，请调用合适的工具。回答简短。`;

await runAgentLoop({
  baseUrl, apiKey, model,
  systemPrompt: SYSTEM,
  userInput: process.argv.slice(2).join(" "),
  tools,
  emit: async (ev) => {
    switch (ev.type) {
      case "agent_start": console.log("[start]"); break;
      case "agent_end":   console.log("\n[end]"); break;
      case "turn_start":  process.stdout.write(`\n[turn] `); break;
      case "turn_end":    break;
      case "message_delta":
        process.stdout.write(ev.delta);
        break;
      case "tool_execution_start":
        process.stdout.write(`\n[tool] ${ev.toolName}(${JSON.stringify(ev.args)})`);
        break;
      case "tool_execution_end":
        process.stdout.write(`\n[result] ${ev.result.slice(0, 200).replace(/\n/g, "\\n")}`);
        break;
    }
  },
});
```

这就是"UI 层"——一个 switch 把所有事件映射到 stdout。换一个调用方（比如把这段写到 React 里，每个事件触发 `setState`），同一份循环就能在浏览器里跑。

## 4.8 对照 pi 的真实实现

pi 的 `packages/agent/src/agent-loop.ts` 里 `runLoop()` 是 100 多行的函数，我们简化后的版本不到 30 行。差异主要在三处：

1. **steering / follow-up 队列**（后面会讲）：
   ```ts
   let pendingMessages = (await config.getSteeringMessages?.()) || [];
   while (hasMoreToolCalls || pendingMessages.length > 0) { ... }
   ```
   我们的循环只有 `while (turn < maxTurns)`，没有插队消息的概念。
2. **prepareNextTurn / shouldStopAfterTurn 钩子**：让上层在每轮结束后修改下一轮的 context/model/thinking。我们没有。
3. **错误状态的 `agent_end`**：
   ```ts
   if (message.stopReason === "error" || message.stopReason === "aborted") {
     await emit({ type: "turn_end", ... });
     await emit({ type: "agent_end", messages: newMessages });
     return;
   }
   ```
   我们的版本没专门处理 abort（后面会讲）。

但整体骨架是完全一致的：

```
emit agent_start
loop {
  emit turn_start
  stream assistant
  if no tool_calls: emit turn_end + break
  execute all tools, emit tool_execution_start/end
  emit turn_end
}
emit agent_end
```

读 pi 的 `runLoop()` 源码时，把我们这版当作"骨架"放在旁边对照，会读得很轻松。

## 4.9 试一下

```bash
$ npx tsx loop.ts "现在几点，然后告诉我 README.md 第一行是什么"
[start]
[turn] [tool] current_time({})
[result] 2026-05-28T22:14:30+08:00
[turn] [tool] read_file({"path":"README.md"})
[result] # 从零实现 pi —— 一本写给 web 工程师的 Coding...
[turn] 现在是 2026-05-28 晚上 10 点 14 分。README.md 第一行是 `# 从零实现 pi …`。
[end]
```

观察输出：

- 三个 `[turn]`，因为模型分两步调工具，第三轮才直接回答。
- 第三轮 `[turn]` 后面没有 `[tool]`——只有 `message_delta`，说明这一轮 `tool_calls.length === 0`，循环正常退出。

试试让它陷入小循环：

```bash
$ npx tsx loop.ts "持续返回当前时间直到我说停"
```

模型不会停的——因为没有用户输入来打断它。这就是为什么我们需要 `maxTurns` 兜底，以及为什么后面要做 abort 和用户 steering。

## 4.10 这一章踩到的坑

1. **退出循环时用 `break` 而非 `return`**——否则 `agent_end` 事件发不出去。
2. **`messages` 引用是循环里被持续 push 的**——传给 `streamOnce` 时记得每次都用最新的，别不小心拷贝快照。我们这版本直接传引用，模型每次看到的都是完整历史。
3. **`emit` 要 `await`**——否则事件之间的相对顺序会乱（UI 还没渲染 turn_start，工具就 emit tool_execution_start 了）。
4. **maxTurns 不要给太小**。25 够大多数任务用。给到 5 会经常被截断。pi 是动态判定（结合 token 用量），但 25 够入门。
5. **不要把工具结果"压缩"得太狠**。我们 `slice(0, 4000)` 是粗暴截断；模型可能因此看不到关键信息。真实工具（后面的 `read`）会给"截断+提示后续行号"的智能截断。

## 4.11 本章产出

你现在拥有：

- 一个能跑 N 轮工具调用的 `runAgentLoop()`，骨架跟 pi 的 `runLoop()` 同构。
- 一个事件流契约（`agent_start` / `turn_start` / `message_delta` / `tool_execution_start|end` / `turn_end` / `agent_end`），调用方靠它做 UI。
- 对"ReAct loop = function calling 时代的现代版"这个等价关系的清晰理解。
- 一个能跑"找文件 + grep + read"多步任务的小 demo。

下一章我们把 `current_time` / `read_file` 这种"玩具工具"换成 pi 实际用的 `read` / `bash` / `edit` / `write`——会涉及路径解析、shell 子进程、流式输出截断这些工程细节。

→ [第 5 章 真实的编码工具](05-real-tools.md)
