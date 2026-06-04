# 第 3 章 第一个工具调用

> 📂 **本章配套代码**：[https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch03](https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch03)

> 前两章里模型只能"凭脑子答"——你问它什么，它说什么。但 coding agent 的本质是"让模型能动手"：读文件、跑命令、改代码。
>
> 这一章我们把"工具"这个概念加进来：让模型在需要的时候主动说"请帮我执行 `current_time()`"，我们在本地执行完，把结果塞回去，让它接着说话。
>
> 我们还不写循环（那是第 4 章）。本章只做**一次**完整的"提问 → 工具调用 → 拿结果 → 二次提问 → 终答"往返。

## 3.1 这一章要做什么

跑起来是这样：

```bash
$ npx tsx tool.ts "现在几点？"
[模型] (想了想，决定调工具)
[工具] current_time({}) → "2026-05-28T22:14:30+08:00"
[模型] 现在是 2026 年 5 月 28 日 晚上 10 点 14 分。
```

中间那两步用户看不见底层在干什么——模型先发了一次 `tool_calls`，我们的代码执行了本地的 `current_time` 函数，再把结果作为一条新消息塞回去，模型基于这条消息生成最终回答。

写完这一章你会拥有：

- 一个能定义工具（"function"）schema 的最小框架，用 **TypeBox** 写——这也是 pi 用的方案。
- 对 OpenAI 协议里 `tools`、`tool_choice`、`role: "tool"` 这套约定的清晰理解。
- 关于"流式协议里 `tool_calls` 是怎么被一段段拼出来的"的实操经验。

## 3.2 为什么需要"工具"

最直接的问题：模型是个无状态文本生成器，它**不知道**：

- 现在是几点、今天是星期几（除非你在 prompt 里告诉它）。
- 你这台机器上有什么文件、Git 状态是什么。
- 网页 / 数据库 / API 的实时内容。

如果你只是"问答"，这无所谓。但 coding agent 要做"看代码 / 跑测试 / 改文件"，必须能跟外部世界打交道。

通用做法：

1. **把模型能做的事情列成一组"函数"**，每个函数有名字、描述、参数 schema。
2. **请求时把这组函数定义放进 `tools` 字段**告诉模型"你可以调用这些"。
3. **模型不会真的执行**——它只会在响应里说"我想调用 `bash` 这个工具，参数是 `{ command: "ls" }`"。
4. **我们的代码看见这个请求，去执行真实的本地函数**，拿到结果。
5. **把结果作为一条新消息（`role: "tool"`）追加进 `messages`**，再发一次请求。
6. 模型基于工具结果给出最终回答。

整个过程看起来像"模型在指挥我们的代码跑函数"。但底层只是一次次普通的 HTTP 请求，**每一次请求都把完整历史传过去**——这一点跟第 1 章一致，没有 magic。

## 3.3 怎么定义一个工具

OpenAI 协议规定 `tools[i]` 的格式是：

```json
{
  "type": "function",
  "function": {
    "name": "current_time",
    "description": "返回当前的本地 ISO 8601 时间字符串。",
    "parameters": {
      "type": "object",
      "properties": {},
      "required": []
    }
  }
}
```

字段解释：

- `type: "function"`：目前只有这一种类型。OpenAI 之前还试过 `code_interpreter`、`retrieval` 等，但 chat completions API 留下来给开发者用的就只剩 `function`。
- `function.name`：工具名，**英文 + 下划线**最稳。模型生成 tool call 时会用这个名字。
- `function.description`：人话描述工具用途。**它非常重要**——模型完全靠 description 判断"什么时候应该调这个工具"。写得越精准，调用越合理。
- `function.parameters`：参数 schema，必须是合法的 **JSON Schema**。注意：
  - 即使工具没有参数（像 `current_time`），也要写 `{ "type": "object", "properties": {}, "required": [] }`。少了 `type: "object"` 大部分 provider 会报错。
  - JSON Schema 是一份 IETF 规范（目前还是 Internet-Draft，不是 W3C 标准），定义"一段 JSON 数据应该长什么样"。`type`、`properties`、`required`、`items`、`enum`、`description` 都是它的字段。详见 [json-schema.org](https://json-schema.org/)，但你只需要会用到的几种就够了。

### 用 TypeBox 写 schema

直接手写 JSON Schema 对象 OK，但有两个不舒服的地方：

1. **没有 TypeScript 类型推导**。你想知道 `params.command` 是不是 string，IDE 没法告诉你。
2. **写起来啰嗦**，每个字段都要 `type`、`description`，嵌套几层就乱了。

pi 用 [**TypeBox**](https://github.com/sinclairzx81/typebox) 解决了这两个问题。TypeBox 提供 `Type.Object`、`Type.String`、`Type.Number` 等构造器，**调用结果既是合法的 JSON Schema 对象**（直接传给 OpenAI 没问题），**又是合法的 TypeScript 类型**（用 `Static<typeof schema>` 能推出 `{ command: string; timeout?: number }`）。

例子：

```ts
import { Type, type Static } from "typebox";

const bashSchema = Type.Object({
  command: Type.String({ description: "Bash command to execute" }),
  timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
});

// bashSchema 本身就是一段 JSON Schema：
// {
//   type: "object",
//   properties: {
//     command: { type: "string", description: "Bash command to execute" },
//     timeout: { type: "number", description: "Timeout in seconds" }
//   },
//   required: ["command"]
// }

// 推出 TS 类型：
type BashInput = Static<typeof bashSchema>;
// 等价于 { command: string; timeout?: number }
```

`Static<typeof bashSchema>` 用的是 TypeScript 的"条件类型"，把 schema 反编译回类型签名。这是 TypeBox 最大的卖点。

pi 真实代码里 `packages/coding-agent/src/core/tools/bash.ts:24-29` 就长这样，跟我们的例子一模一样。

> 也可以用 [Zod](https://zod.dev/) + `zod-to-json-schema`，但要多走一道转换。TypeBox 直出 JSON Schema，少一层心智负担，所以 pi 选了它。

## 3.4 工具长什么样：在我们自己的代码里

我们的"工具"在代码里是一个对象，包含 schema + 一个 `execute` 函数。最简版：

```ts
type Tool = {
  name: string;
  description: string;
  parameters: object;           // JSON Schema
  execute: (args: any) => Promise<string>;  // 拿到结果字符串
};
```

定义两个例子：

```ts
import { Type, type Static } from "typebox";

const tools: Tool[] = [
  {
    name: "current_time",
    description: "返回当前本地时间，ISO 8601 字符串。无参数。",
    parameters: Type.Object({}),
    execute: async () => new Date().toISOString(),
  },
  {
    name: "read_file",
    description: "读取本地文件内容，返回 UTF-8 文本。",
    parameters: Type.Object({
      path: Type.String({ description: "文件相对路径或绝对路径" }),
    }),
    execute: async (args: { path: string }) => {
      const fs = await import("node:fs/promises");
      return await fs.readFile(args.path, "utf-8");
    },
  },
];
```

pi 的真实工具接口（`packages/agent/src/types.ts:361-384`）比这个复杂一点：

```ts
export interface AgentTool<TParameters extends TSchema, TDetails = any> extends Tool<TParameters> {
  label: string;                       // UI 上显示用
  prepareArguments?: (args: unknown) => Static<TParameters>;
  execute: (
    toolCallId: string,                // 这次调用的 id，用于关联结果
    params: Static<TParameters>,
    signal?: AbortSignal,               // 让工具支持中途取消
    onUpdate?: (partial: AgentToolResult<TDetails>) => void,  // 工具流式回报进度
  ) => Promise<AgentToolResult<TDetails>>;
  executionMode?: "sequential" | "parallel";
}
```

多出来的 `label` / `signal` / `onUpdate` / `executionMode` 我们到第 4 章再用——这一章用最简版就够。

## 3.5 把工具放进请求里

把 `Tool[]` 转成 OpenAI 协议要的 `tools` 数组：

```ts
function buildToolsParam(tools: Tool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}
```

然后请求体多两个字段：

```ts
body: JSON.stringify({
  model,
  messages,
  tools: buildToolsParam(tools),
  tool_choice: "auto",     // ←  这是新的
  stream: true,
})
```

### `tool_choice`：让不让模型调

| 取值 | 含义 |
| --- | --- |
| `"auto"` | （默认）模型自己决定调还是不调 |
| `"none"` | 这次禁止调工具，老实回答 |
| `"required"` | 这次**必须**至少调一个工具，不许直接回答 |
| `{ "type": "function", "function": { "name": "bash" } }` | 必须调指定的那个 |

90% 场景用 `"auto"`。`"required"` 在"必须先调用搜索工具"的场景偶尔有用。pi 默认走 `"auto"`。

## 3.6 流式响应里 tool_calls 是怎么"长出来"的

第 2 章我们看到 `delta.content` 是增量文本。`delta.tool_calls` 也是增量，但**结构更复杂**。

一次工具调用的 SSE 流大致长这样（删掉了 finish_reason 等无关字段）：

```
data: {"choices":[{"delta":{"role":"assistant","content":null}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_abc","type":"function","function":{"name":"read_file","arguments":""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"pa"}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\":\""}}]}}]}
data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"hello.ts\"}"}}]}}]}
data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}
data: [DONE]
```

观察：

- 第 1 块：`content: null` 标志"这次模型决定不直接说话"。注意是 `null` 不是 `""`——后续 chunk 也不会有 content 增量。
- 第 2 块：第一个 `tool_calls[0]` 出现，**带了 `id` 和 `function.name`**，但 `arguments` 是空字符串。
- 第 3、4、5 块：只更新 `tool_calls[0].function.arguments`，**逐段把 JSON 字符串拼出来**。
- 最后一块：`finish_reason: "tool_calls"`，告诉我们"模型说完了，请去执行工具"。

关键约定：

1. **`index` 标识第几个工具调用**。模型可能一次性请求多个工具（"并行 tool call"），这时 `tool_calls[0]`、`tool_calls[1]` 同时增量更新，各自的 `index` 不同。
2. **`id` 只在第一段出现**。后续 chunk 的同一 `index` 不重复发 id，所以我们要"第一次见到就记下来"。
3. **`function.name` 同上**，第一段就给了。
4. **`function.arguments` 是字符串拼接**。最终的 `arguments` 是一段完整 JSON 文本，需要 **`JSON.parse`** 才能得到对象。无参工具（如 `current_time`）通常是 `"{}"`，但**也有 provider 直接回空串 `""`**——所以解析时要写 `JSON.parse(tc.arguments || "{}")`，否则空串会让 `JSON.parse` 抛 `Unexpected end of JSON input`。单参数就是 `'{"path":"hello.ts"}'`。

这套规则我们在第 2 章 `streamOpenAI` 里其实已经处理过，回顾一下那段代码：

```ts
if (delta.tool_calls) {
  for (const tc of delta.tool_calls) {
    const slot = (acc.tool_calls[tc.index] ??= {
      id: "",
      name: "",
      arguments: "",
    });
    if (tc.id)                  slot.id        = tc.id;
    if (tc.function?.name)      slot.name      = tc.function.name;
    if (tc.function?.arguments) slot.arguments += tc.function.arguments;
  }
}
```

`acc.tool_calls[tc.index] ??=` 这一行是关键：如果对应 index 还没建过槽，就新建一个空对象。后面三个 `if` 分别处理增量数据。

> **流式拼接 JSON 的注意事项**：`slot.arguments` 在中途看起来是一段"残缺的 JSON"，比如 `{"pa`、`{"path":"hello.ts`。**不要在中途调 `JSON.parse`**，等 `finish_reason` 出现后再解析。pi 在 `packages/ai/src/utils/json-parse.ts` 里实现了一个更宽容的 `parseStreamingJson()`，能容忍残缺/转义错误的 JSON——但那是 UI 实时显示"已经接收到的部分参数"用的，最终执行工具时仍然要在完整 JSON 上 `JSON.parse`。

## 3.7 把工具结果塞回去

模型流结束后，我们拿到一个 `AssistantMessage`：

```ts
{
  role: "assistant",
  content: "",                       // 因为这次是工具调用，没文本
  tool_calls: [
    { id: "call_abc", name: "read_file", arguments: '{"path":"hello.ts"}' }
  ],
  finish_reason: "tool_calls"
}
```

我们的代码要做三件事：

1. **把 assistant 消息追加到 `messages`**——它属于历史的一部分，下一次请求要带上。
2. **对每个 `tool_calls[i]` 执行对应的本地函数**，拿到字符串结果。
3. **把每个工具结果作为一条 `role: "tool"` 消息追加到 `messages`**，**`tool_call_id` 字段必须和发起调用的 id 对应**。

第 3 步那个新消息长这样：

```json
{
  "role": "tool",
  "tool_call_id": "call_abc",
  "content": "...文件内容..."
}
```

字段说明：

- `role: "tool"`：第 1 章我们提过四种 role，这是最后一种登场。
- `tool_call_id`：把这条结果跟之前那个 `tool_calls[i].id` 关联起来。**必填**，否则模型不知道这条结果对应哪次调用——并行 tool call 时这一点尤其重要。
- `content`：工具结果。最简形式是字符串，也可以是 content part 数组（让你回传图片，比如 `read` 工具返回 PNG）。

> 注意：**有的 OpenAI 兼容实现要求 `tool` 消息还要带一个 `name` 字段**（重复一遍工具名）。pi 在 `packages/ai/src/providers/openai-completions.ts` 里有个 `requiresToolResultName` 开关处理它。我们这一章不管，但跑某些 provider 出错就回来看这个细节。

然后我们要**再发一次 HTTP 请求**，messages 数组里现在有 4 条：

```
1. system
2. user
3. assistant (tool_calls)
4. tool (result)
```

这次模型大概率会给文本答复（"文件内容是 …"），`finish_reason: "stop"`。

整个流程完了。

## 3.8 完整代码

`code/ch03/tool.ts`，约 200 行。我们把第 2 章的 `streamOpenAI` 直接复用，只在它前后加 tool 相关的逻辑。

完整代码先放出来，再分块讲。

```ts
// ============ 1. Tool 定义 ============
import { Type, type Static } from "typebox";

type Tool = {
  name: string;
  description: string;
  parameters: any;
  execute: (args: any) => Promise<string>;
};

const tools: Tool[] = [
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
];

// ============ 2. 把 Tool[] 转成 OpenAI 协议 ============
function buildToolsParam(tools: Tool[]) {
  return tools.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }));
}

// ============ 3. 复用第 2 章的 streamOpenAI（略） ============
// 直接 import 即可:
import { streamOpenAI, type AssistantMessage } from "../ch02/hello.js";

// ============ 4. 主流程 ============
const baseUrl = process.env.PI_BASE_URL!;
const apiKey  = process.env.PI_API_KEY!;
const model   = process.env.PI_MODEL!;

const userInput = process.argv.slice(2).join(" ").trim();
if (!userInput) {
  console.error("用法: tsx tool.ts <你的问题>");
  process.exit(1);
}

const messages: any[] = [
  {
    role: "system",
    content: "你是一个能调用工具的中文助手。回答简短，必要时调用工具。",
  },
  { role: "user", content: userInput },
];

// ---- 第一轮：让模型决定调不调工具 ----
let assistant1: AssistantMessage | undefined;
for await (const ev of streamOpenAI({
  baseUrl, apiKey, model,
  messages,
  tools: buildToolsParam(tools),
})) {
  if (ev.delta) process.stdout.write(ev.delta);
  if (ev.done)  assistant1 = ev.done;
}
console.log();
if (!assistant1) throw new Error("无响应");

// 把模型这次的回复追加到 messages 里（含 tool_calls）
messages.push(toOpenAIAssistantMsg(assistant1));

// 如果模型没要求调工具，直接结束
if (assistant1.tool_calls.length === 0) {
  process.exit(0);
}

// ---- 执行所有 tool_calls ----
for (const tc of assistant1.tool_calls) {
  const tool = tools.find((t) => t.name === tc.name);
  let result: string;
  if (!tool) {
    result = `Tool "${tc.name}" not found`;
  } else {
    try {
      const args = JSON.parse(tc.arguments || "{}");
      console.log(`[工具] ${tc.name}(${tc.arguments})`);
      result = await tool.execute(args);
    } catch (err: any) {
      result = `Error: ${err.message}`;
    }
  }
  // 把结果作为 role: "tool" 塞回去
  messages.push({
    role: "tool",
    tool_call_id: tc.id,
    content: result.slice(0, 4000),   // 避免一次塞超大文件
  });
}

// ---- 第二轮：让模型基于工具结果给最终答复 ----
console.log("[模型]");
for await (const ev of streamOpenAI({
  baseUrl, apiKey, model,
  messages,
  tools: buildToolsParam(tools),   // 保留，下次也可能再调
})) {
  if (ev.delta) process.stdout.write(ev.delta);
}
console.log();

// ============ 辅助函数 ============
function toOpenAIAssistantMsg(m: AssistantMessage) {
  // 我们内部用 { name, arguments } 的精简结构；
  // OpenAI 协议要求嵌套 function.name / function.arguments
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

### 分块讲解

#### 第 4 段：messages 初始化

```ts
const messages: any[] = [
  { role: "system", content: "你是一个能调用工具的中文助手。回答简短，必要时调用工具。" },
  { role: "user",   content: userInput },
];
```

system prompt 里**点名提示模型有工具可用**。这是个软性引导——光在 `tools` 字段里给定义，有些模型也会忽略；显式在 system prompt 里提一句，调用率会显著提高。pi 真实的 system prompt 里有 "Available tools:" 一节列出所有工具名（详见第 5 章）。

#### 第 4 段：第一轮调用

```ts
for await (const ev of streamOpenAI({
  baseUrl, apiKey, model, messages,
  tools: buildToolsParam(tools),
})) {
  if (ev.delta) process.stdout.write(ev.delta);
  if (ev.done)  assistant1 = ev.done;
}
```

跟第 2 章一模一样，只是多塞了 `tools`。如果模型决定**不**调工具（比如你问"你是谁？"），它会直接吐 `content` 文本，`tool_calls` 为空数组。如果它决定调，`delta` 不会有内容输出，最后 `done` 事件给到的 `AssistantMessage.tool_calls` 是非空数组。

#### 把 assistant 消息塞回 messages

```ts
messages.push(toOpenAIAssistantMsg(assistant1));
```

这一步**很容易被新手漏掉**，但绝不能省：第二次请求时，模型需要看到自己上次发的 `tool_calls`，才能把 `role: "tool"` 消息和那次调用对应起来。

注意我们用了一个转换函数 `toOpenAIAssistantMsg`。这是因为：

- 我们内部把 tool call 精简存储为 `{ id, name, arguments }`，没要 `function` 嵌套层。
- OpenAI 协议要求 assistant 消息里的 `tool_calls[i]` 必须是 `{ id, type, function: { name, arguments } }` 结构。
- 我们临走时套一层壳。

`content: m.content || null` 也要注意：OpenAI 协议要求当有 `tool_calls` 时 `content` 用 `null`（而不是空字符串）。某些严格的 provider 不接受 `""`。

#### 工具执行

```ts
for (const tc of assistant1.tool_calls) {
  const tool = tools.find((t) => t.name === tc.name);
  let result: string;
  if (!tool) {
    result = `Tool "${tc.name}" not found`;
  } else {
    try {
      const args = JSON.parse(tc.arguments || "{}");
      console.log(`[工具] ${tc.name}(${tc.arguments})`);
      result = await tool.execute(args);
    } catch (err: any) {
      result = `Error: ${err.message}`;
    }
  }
  messages.push({
    role: "tool",
    tool_call_id: tc.id,
    content: result.slice(0, 4000),
  });
}
```

要点：

1. **没找到工具不要抛错，要把"Tool not found"作为工具结果塞回去**。模型很可能是手误打错了名字，让它看到错误信息再纠正比让程序崩溃强。pi 在 `packages/agent/src/agent-loop.ts:570-576` 也是这么做的。
2. **执行抛错也不要让程序退出**——把错误作为工具结果塞回。模型经常自我纠正：上次 `read_file` 传错路径，看到报错后下次会换个路径。
3. **截断长输出**。这里简化成 `slice(0, 4000)`。pi 的 `read` 工具有专门的 truncation 模块（`packages/coding-agent/src/core/tools/truncate.ts`），按行数和字节数双重限制截断，并在末尾告诉模型"还有 X 行，用 offset=Y 继续读"——这是第 6 章的内容。
4. `tool_call_id: tc.id`——再强调一次，**必须**配对，否则并行工具调用时模型会迷路。

#### 第二轮调用

```ts
for await (const ev of streamOpenAI({
  baseUrl, apiKey, model, messages,
  tools: buildToolsParam(tools),
})) {
  if (ev.delta) process.stdout.write(ev.delta);
}
```

这次模型基于"system + user + assistant(tool_calls) + tool(results)"四条消息生成最终答复。这次大概率 `finish_reason: "stop"`，但**也可能再要求调一次工具**——比如它看了文件第一段后说"再读一次第二段"。这就是第 4 章 agent 循环要解决的问题。

## 3.9 跑一下

```bash
$ npx tsx tool.ts "现在几点？"
[工具] current_time({})
[模型]
现在是 2026-05-28 22:14:30。

$ npx tsx tool.ts "读一下 package.json，告诉我它依赖哪些包"
[工具] read_file({"path":"package.json"})
[模型]
package.json 依赖 typebox 一个包；devDependencies 有 tsx、typescript、@types/node。
```

如果模型抽风调了不存在的工具：

```bash
$ npx tsx tool.ts "帮我搜索一下天气"
[工具] web_search({"query":"今天天气"})
[工具结果] Tool "web_search" not found
[模型]
抱歉，我没有联网能力。建议你查询本地气象 app 或网站。
```

模型自动从错误里恢复了——这就是为什么我们把 "tool not found" 也作为正常 result 塞回去。

## 3.10 这一章踩到的坑

1. **`tool_choice` 默认不是 `"auto"`**：实际上大多数 provider 默认 `"auto"`，但**有的旧 provider 默认 `"none"`**——所以保险起见显式写 `"auto"`。
2. **arguments 是字符串，不是对象**。流式拼接结束后要 `JSON.parse(tc.arguments || "{}")`——无参工具可能给空串，直接 parse 会抛错。
3. **assistant 消息里的 `content` 当 tool_calls 非空时要用 `null`**，部分 provider 不接受空字符串。
4. **工具结果回传时 `tool_call_id` 不能漏**。少了就是协议错误。
5. **不要 `throw` 工具错误**，把错误作为 result 塞回去让模型自己处理。
6. **不要在第二轮请求里去掉 `tools` 字段**。即使你"知道"模型这次会直接答，去掉 `tools` 会让有些 provider 报"消息里有 tool_calls 但 schema 没声明 tools"的错。pi 内部用 `hasToolHistory()`（`packages/ai/src/providers/openai-completions.ts:48-60`）专门处理这个边界。

## 3.11 本章产出

你现在拥有：

- 一个能定义和执行工具的最小框架（TypeBox + Tool[] + 转换函数）。
- 对 `tools` / `tool_choice` / `role: "tool"` / `tool_call_id` 这套约定的清晰理解。
- 流式 `tool_calls` 累积逻辑的实操经验。
- 一次完整的"模型 → 工具 → 模型"往返实现。

但你的程序只会做**一轮**工具调用就停了——模型说"我读完文件了，但还想 grep 一下"，你的代码就傻眼了。

下一章我们把"一次往返"扩展成"循环"：只要模型还在出 `tool_calls`，就继续执行 + 续聊；并且把循环里产生的所有过程做成事件流，让 UI 能实时显示。这才是真正的 **agent loop**。

→ [第 4 章 ReAct 循环](04-react-loop.md)
