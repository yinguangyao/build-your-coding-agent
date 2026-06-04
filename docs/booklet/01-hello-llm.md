> **《从零实现一个 Coding Agent》系列 · 第 1 篇**
>
> 这是本系列的第一篇。我们会从最朴素的一次 HTTP 请求开始，一章一章地把一个真正能读写文件、执行命令、自己决定下一步干什么的编码助手（本系列叫它 **pi**）搭出来——不用任何 agent 框架，每一行代码都自己写、都讲清楚为什么。

## 写在前面：这个系列要干什么

市面上的 coding agent（Claude Code、Cursor、Cline……）看起来很神秘：它能听懂你的需求，自己读代码、改文件、跑测试、看报错、再修。但当你把它拆开，会发现底层其实只有几个朴素的零件：**一次 LLM 调用、一个流式解析器、一组工具、一个 while 循环**。把这几样东西拼起来，就是一个 agent。

这个系列的目标，就是**带你从零、用纯 TypeScript、不依赖任何 agent 框架，一行一行把这些零件造出来并拼成一个完整的 coding agent**。我们会一边写，一边对照真实开源实现 pi 的做法，告诉你"玩具版"和"生产版"的差距在哪。

大致的路线是这样的（从一次请求，逐步长成一个 agent）：

| 阶段 | 你会得到什么 |
| --- | --- |
| 一次 LLM 调用（**本篇**） | 看懂大模型 API 的请求/响应长什么样 |
| 流式输出 | 让回答一个字一个字地冒出来（SSE） |
| 工具调用 | 让模型能调用 `read` / `bash` / `edit` 等工具 |
| Agent 循环 | 把"调用工具→喂回结果→再调用"接成自动循环 |
| 系统提示词与身份 | 给 agent 一个稳定的人设和行为约束 |
| 多 provider 适配 | 一套代码同时支持 OpenAI / Anthropic / Gemini |

**适合谁读**：会一点 TypeScript/JavaScript，对大模型 API 好奇，想知道"agent 到底是怎么转起来的"的人。不需要你提前懂 agent，我们从零讲起。

**怎么读**：每篇都能独立跑通，代码全部在本仓库里（见每章 §写代码 一节）。建议边读边敲、边敲边跑。

好，热身结束，从最简单的一次请求开始。

---

# 第 1 章 一次 LLM 调用

> 本章我们**不写 agent**，也**不流式**。只用一次普通的 HTTP `fetch`，发一段文字给一个大模型，把它的回复打印出来。
>
> 目标是把"模型对话"这件事从神秘感里拆出来——它其实就是一个 POST 请求，请求体是 JSON，响应体是 JSON，仅此而已。剩下所有花活（流式、工具调用、agent 循环）都是绕着这个 JSON 在打转。

## 1.1 我们要做什么

终端里跑：

```bash
$ npx tsx hello.ts "用一句话介绍一下二分搜索"
二分搜索是一种在有序数组中通过反复将搜索范围对半折叠，从而以 O(log n) 时间找到目标值的算法。
```

不到 60 行 TypeScript，没有任何 SDK，只用 `fetch`。但写完这一章你会知道：

- 大模型 API 长什么样（请求体、响应体）
- `messages[]`、`role`、`content` 这些字段分别表示什么
- 为什么响应里要有个 `choices[]`，且通常只用 `choices[0]`
- `system` / `user` / `assistant` / `tool` 这四种 `role` 各自的含义
- `finish_reason` 是干嘛的，为什么后面 agent 循环需要看它
- `tool_calls` 字段长什么样，虽然这一章我们还不用它，但要混个脸熟

## 1.2 前置：找一个 OpenAI 兼容的 API

业界几乎所有"自托管 / 商用 / 开源"的大模型推理服务都提供 **OpenAI 兼容的 HTTP 接口**（叫 "OpenAI Chat Completions API"），具体说就是：

- 同一个**端点后缀**：在 base_url 后面拼 `/chat/completions`
- 同一个请求体 schema：`{ model, messages, ... }`
- 同一个响应体 schema：`{ id, choices: [...], usage: ... }`

> ⚠️ 注意：真正固定的只有末尾的 `/chat/completions`。**前面的版本前缀各家并不一样**——OpenAI 是 `/v1`、阿里通义是 `/compatible-mode/v1`、火山方舟是 `/api/v3`，DeepSeek 甚至可以不带版本。所以正确的心智模型是：**把版本前缀算进 `base_url`**，代码只负责在末尾拼 `/chat/completions`（这也正是 OpenAI 官方 SDK 的做法）。这样一套代码就能切换所有厂商。

谁会兼容它（下面给的都是 **base_url**，末尾再拼 `/chat/completions` 才是完整端点地址）：

- OpenAI 自己（`https://api.openai.com/v1`）
- DeepSeek（`https://api.deepseek.com`，也接受 `https://api.deepseek.com/v1`）
- Moonshot / Kimi（`https://api.moonshot.cn/v1`）
- 阿里通义（`https://dashscope.aliyuncs.com/compatible-mode/v1`）
- 火山方舟 Ark（`https://ark.cn-beijing.volces.com/api/v3`，注意是 `/api/v3`，而且 `model` 要填接入点 id，形如 `ep-xxxxxxxx`）
- 自部署的 vLLM / Ollama / LM Studio（端口随你）
- 大多数云厂商提供的"OpenAI 兼容"端点

> Anthropic（Claude）和 Google（Gemini）有自己的协议，**不**走这条 URL。我们到第 9 章再处理它们。本章只用 OpenAI 兼容协议——一个写明白了，剩下两个是同一回事。

**准备工作**：

1. 注册一个 DeepSeek / Moonshot / 任意 OpenAI 兼容服务的账号，拿到 API key。
2. 找到它的 `base_url`（**含版本前缀**），比如 OpenAI 是 `https://api.openai.com/v1`，DeepSeek 用 `https://api.deepseek.com/v1`，火山方舟是 `https://ark.cn-beijing.volces.com/api/v3`。
3. 找到一个**能用的模型名**：DeepSeek 是 `deepseek-chat`，OpenAI 是 `gpt-4o-mini`，火山方舟则是接入点 id（`ep-xxxxxxxx`），等等。
4. 把它们丢进环境变量：

```bash
export PI_BASE_URL="https://api.deepseek.com/v1"
export PI_API_KEY="sk-xxxxxxxxxxxx"
export PI_MODEL="deepseek-chat"
```

如果你只有 Anthropic 或 Google 的 key，先去申请一个免费额度的兼容服务，否则这一章跑不通。

## 1.3 请求体（request body）：messages 是什么

我们要 POST 给 `https://api.deepseek.com/v1/chat/completions` 的 JSON 大概长这样：

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "你是一个简明扼要的助手。" },
    { "role": "user",   "content": "用一句话介绍一下二分搜索" }
  ]
}
```

字段不多，但每个都要讲清楚。

### `model`：选哪个模型

字符串，告诉服务端"用哪个模型来回答"。不同服务的取值是独立的（`gpt-4o-mini` 在 DeepSeek 上不存在）。pi 用一个**统一的模型注册表**（`packages/ai/src/models.generated.ts`，5000+ 行）来管理"哪个 `provider/id` 对应哪个 `baseUrl`、上下文窗口多大、单价多少"——这就是第 9 章要做的事情。

### `messages`：一段对话历史

这是核心。它是**一个数组**，每一项叫做一条 message。

为什么是数组而不是单个字符串？因为这个 API 是**无状态**的：服务端不会记得"你上一轮问了什么、它上一轮答了什么"。每次调用，**你都要把整段对话历史完整传一遍**。它根据这段历史预测下一句应该说什么。

这一点很重要，写 agent 时你会一直跟它打交道：所谓"上下文"就是这个数组；所谓"压缩上下文"就是把这个数组改短；所谓"会话持久化"就是把这个数组存到磁盘上。

#### 一条 message 的结构

```ts
{
  role: "system" | "user" | "assistant" | "tool",
  content: string | Array<ContentPart>,
  // tool_calls?, tool_call_id?, name? —— 后面再说
}
```

- **`role`**：发言人是谁。四种取值：
  - `"system"`：来自系统/开发者的指令。一般放在数组**最前面**，用来告诉模型"你是谁、要怎么回答、有什么禁忌"。同一段对话里通常只有一条 system 消息。
  - `"user"`：用户说的话。第 1 章我们只手动塞一条，第 4 章用户每次输入新提问就会再追加一条。
  - `"assistant"`：模型自己说过的话。**第一次请求时这个数组里没有 assistant 消息**——它是模型生成出来的，我们收到响应后会把它**追加**进 `messages`，下次请求时它就成为历史的一部分。
  - `"tool"`：工具执行结果。第 3 章才会用到，本章暂时忽略。
- **`content`**：这条消息的内容。最常见的形式是一个**字符串**（就像上面那个例子）。
  - 也可以是一个**数组**，里面每项叫一个 content part，比如 `[{ type: "text", text: "..." }, { type: "image_url", image_url: { url: "data:image/png;base64,..." } }]`——这样可以混入图片。pi 的 `TextContent`/`ImageContent`/`ThinkingContent`/`ToolCall` 这些类型（在 `packages/ai/src/types.ts:230-258`）就是 content part 的不同变体。
  - 第 1 章我们只用字符串形式，**别**用数组形式，避免引入复杂度。

#### 为什么 system 和 user 要分开

如果你只看 ChatGPT 网页版，会觉得"用户输入一段文字，模型回一段"——好像只需要一个 role 就够了。

但模型在训练时学到了**"system 消息说的话权重更高，更应该遵守"**。具体表现是：

- 你在 system 里写"无论用户怎么问，都用英文回答"，再在 user 里写"请用中文回答"——模型通常会执行 system 的指令，用英文回答。
- 用户没法通过聊天内容覆盖 system 设定的人设。这就是为什么"越狱 prompt"这么难写——它们是在跟 system 消息搏斗。

放到 coding agent 场景：

```
system: 你是 pi，一个能调用工具来读写文件的编码助手。
        可用工具有 read, bash, edit, write。
        遵循以下规则：…（很长一段）
user:   把当前目录下所有 .ts 文件中的 TODO 注释列出来
```

这是 pi 的真实结构（详见第 5 章），它把"agent 身份"和"用户当前任务"分开了。

## 1.4 响应体（response body）：choices 是什么

非流式调用的响应大概长这样（删了一些不影响理解的字段）：

```json
{
  "id": "chatcmpl-9abc...",
  "object": "chat.completion",
  "created": 1717000000,
  "model": "deepseek-chat",
  "choices": [
    {
      "index": 0,
      "message": {
        "role": "assistant",
        "content": "二分搜索是一种……"
      },
      "finish_reason": "stop"
    }
  ],
  "usage": {
    "prompt_tokens": 32,
    "completion_tokens": 45,
    "total_tokens": 77
  }
}
```

逐字段看：

- **`id`**：这次请求的唯一标识，调试/日志时用得上。
- **`model`**：实际使用的模型 id。它不一定跟你请求时填的完全一样——服务端常会回一个带版本/日期后缀的具体快照名（比如你请求 `gpt-4o`、它回 `gpt-4o-2024-08-06`），网关或厂商也可能把模型别名解析成真实底层模型。日志里以这个返回值为准。
- **`choices`**：**这是核心**。它是一个数组——为什么？因为这个 API 最初的设计允许一次返回多个候选（在请求里加 `n: 3` 就能拿到 3 个候选答案）。
  - **99% 的场景我们都只用 `choices[0]`**。pi 也是这么干的。
  - 每个 choice 包含：
    - `index`：候选编号，第 0 个就是 0。
    - `message`：模型实际生成的那条 `assistant` 消息——`{ role: "assistant", content: "..." }`，**结构和你传进去的 messages 里那些一模一样**。这正是"上下文是单一数据结构"的好处：把它直接 push 进 `messages` 数组就完成了一轮对话。
    - `finish_reason`：模型为什么停下来——见下一节。
- **`usage`**：本次消耗的 token 数。用来算钱、算上下文剩余空间。Anthropic 协议把它叫 `input_tokens`/`output_tokens`，OpenAI 叫 `prompt_tokens`/`completion_tokens`，pi 在 `packages/ai/src/types.ts:260-273` 用一个统一的 `Usage` 类型把它们抹平。

### `finish_reason` 都有哪些值

这个字段非常重要，agent 循环（第 4 章）就是靠它判断"该不该继续往下走"。常见取值：

| 值 | 含义 | agent 该怎么做 |
| --- | --- | --- |
| `"stop"` | 模型说完了，自然停止 | 把答案给用户看，等用户下一个输入 |
| `"length"` | 触发了 `max_tokens` 限制，被强行截断 | 报错或要求模型继续 |
| `"tool_calls"` | 模型决定调用工具（见第 3 章） | 执行工具，拿到结果后再发一次请求 |
| `"content_filter"` | 触发了内容安全策略 | 通常显示一个提示让用户改 prompt |

pi 把这些值归一化成 `StopReason`（`packages/ai/src/types.ts:275`）：`"stop" | "length" | "toolUse" | "error" | "aborted"`。

## 1.5 写代码

> 📦 本章完整源码就在当前这个 git 仓库里：[`docs/booklet/code/ch01/hello.ts`](code/ch01/hello.ts)（GitHub：[build-your-coding-agent](https://github.com/yinguangyao/build-your-coding-agent/blob/main/docs/booklet/code/ch01/hello.ts)）。想直接跑的话，clone 下来配好下面三个环境变量就行，不必照着手敲。

新建一个目录，初始化项目：

```bash
mkdir hello-llm && cd hello-llm
npm init -y
npm install --save-dev tsx typescript @types/node
```

把下面这段 60 行代码存成 `hello.ts`：

```ts
// hello.ts
const baseUrl = process.env.PI_BASE_URL;
const apiKey  = process.env.PI_API_KEY;
const model   = process.env.PI_MODEL;

if (!baseUrl || !apiKey || !model) {
  console.error("请设置 PI_BASE_URL / PI_API_KEY / PI_MODEL 环境变量");
  process.exit(1);
}

// 1) 把命令行参数拼成一段提问
const userInput = process.argv.slice(2).join(" ").trim();
if (!userInput) {
  console.error("用法: tsx hello.ts <你的问题>");
  process.exit(1);
}

// 2) 准备 messages 数组
const messages = [
  { role: "system", content: "你是一个简明扼要的中文助手，回答控制在两句话以内。" },
  { role: "user",   content: userInput },
];

// 3) 发请求
//    baseUrl 已经带上了厂商的版本前缀（/v1、/api/v3…），这里只拼固定的 /chat/completions
const resp = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages,
    temperature: 0.2,
    // 注意：本章不流式，所以不带 stream: true
  }),
});

// 4) HTTP 层错误处理
if (!resp.ok) {
  const errBody = await resp.text();
  console.error(`HTTP ${resp.status}: ${errBody}`);
  process.exit(1);
}

// 5) 解析响应
const data = await resp.json();
const choice = data.choices[0];
const reply  = choice.message.content;

// 6) 打印
console.log(reply);
console.log(`\n--- (finish_reason: ${choice.finish_reason}, ` +
            `tokens: ${data.usage?.prompt_tokens} in / ${data.usage?.completion_tokens} out) ---`);
```

跑起来：

```bash
npx tsx hello.ts "用一句话介绍一下二分搜索"
```

输出：

```
二分搜索是一种在有序序列中通过反复折半缩小范围来定位目标的算法，时间复杂度 O(log n)。

--- (finish_reason: stop, tokens: 33 in / 41 out) ---
```

### 逐段拆解（这是重点）

#### 第 1 段：读环境变量

```ts
const baseUrl = process.env.PI_BASE_URL;
const apiKey  = process.env.PI_API_KEY;
const model   = process.env.PI_MODEL;
```

`process.env` 是 Node 内置的全局对象，对应你 shell 里 `export PI_API_KEY=...` 设置的环境变量。

**为什么不直接把 API key 写死在代码里？** 因为：

1. 你不希望 key 被 commit 到 git。
2. 同一份代码要在多个机器/CI 上跑，每台机器换 key 不该改代码。
3. 第 4 章我们会换不同 provider，环境变量是切换最快的方式。

pi 自己用一个更结构化的方案——`AuthStorage`（`packages/coding-agent/src/core/auth-storage.ts`）把 key 存到 `~/.pi/auth.json`，存的是**明文 JSON**，靠把文件权限设成 `0o600`（仅本人可读写）来保护，不是加密——但这一章我们用最简陋的环境变量方案就够了。

#### 第 2 段：拼 messages

```ts
const messages = [
  { role: "system", content: "你是一个简明扼要的中文助手，回答控制在两句话以内。" },
  { role: "user",   content: userInput },
];
```

我们刚刚在 1.3 节讲的所有内容都体现在这里：

- system 消息在前，定义助手的"风格"（"简明扼要 / 两句话")。
- user 消息在后，承载本次请求的实际问题。
- 没有 assistant 消息——因为还没轮到模型说话。

#### 第 3 段：发请求

```ts
const resp = await fetch(`${baseUrl}/chat/completions`, {
  method: "POST",
  headers: {
    "Content-Type":  "application/json",
    "Authorization": `Bearer ${apiKey}`,
  },
  body: JSON.stringify({
    model,
    messages,
    temperature: 0.2,
  }),
});
```

- `fetch` 是 Node 18+ 内置的 web 标准 API，浏览器里那个 `fetch` 跟它接口一致。
- HTTP 方法是 `POST`，URL 末尾拼的是 `/chat/completions`——**这才是 OpenAI 兼容协议真正固定的部分**；版本前缀（`/v1`、`/api/v3` 等）各家不同，已经包含在 `baseUrl` 里了，所以代码里不要再写死 `/v1`。
- `Authorization: Bearer <key>` 是 OpenAI 协议规定的鉴权头。Anthropic 用 `x-api-key`、Google 用 query param，这是它们的协议差异之一（第 9 章会展开）。
- `body` 是 JSON 字符串。除了 `model` 和 `messages`，我们加了一个：
  - **`temperature`**：采样温度，取值 0~2，越低答案越确定（同样输入给同样输出的概率越大），越高越发散。Coding agent 通常用 0.0~0.3，因为我们要的是"严格、可复现"的工具调用，不是诗意发挥。pi 默认也走 0.2 附近的策略。
- 我们**没有**写 `stream: true`，所以这是非流式调用——服务端会生成完整答案后一次性返回。这意味着如果回答很长，你要等几秒钟才能看到任何字符。第 2 章会修掉这个体验。

#### 第 4 段：HTTP 错误处理

```ts
if (!resp.ok) {
  const errBody = await resp.text();
  console.error(`HTTP ${resp.status}: ${errBody}`);
  process.exit(1);
}
```

`resp.ok` 是 `fetch` 提供的快捷属性，表示 `status` 在 200~299 之间。常见的失败 status：

- `401`：API key 不对或者过期。
- `429`：调用太频繁，被限流。pi 在 `packages/ai/src/providers/openai-completions.ts` 里专门处理了这个（带 `maxRetries`、指数退避），第 9 章会讲。
- `400`：请求体格式不对，看 `errBody` 里的 message。
- `500`：服务端炸了，重试。

第 1 章我们简单粗暴，错了就退出。

#### 第 5 段：解析响应

```ts
const data = await resp.json();
const choice = data.choices[0];
const reply  = choice.message.content;
```

- `resp.json()` 是 `fetch` 标准 API，把 body 反序列化成 JS 对象。
- `data.choices[0]` 取第一个候选——前面说过 99% 场景只用这个。
- `choice.message.content` 是字符串形式的答案。

注意 `choice.message` 的类型和我们传进去的 messages 完全同构（`{ role: "assistant", content: "..." }`）。你可以这么写：

```ts
messages.push(choice.message);
```

然后用这个新数组发第二次请求，就实现了"多轮对话"。这是第 4 章 agent 循环的基础。

#### 第 6 段：打印

```ts
console.log(reply);
console.log(`\n--- (finish_reason: ${choice.finish_reason}, ...) ---`);
```

把答案和元信息（finish_reason、token 数）一起印出来。**养成在调试时把 `finish_reason` 也打出来的习惯**，它对后续 agent 循环至关重要。

## 1.6 顺便看一眼 tool_calls（混个脸熟）

第 3 章我们会真正用工具。但请求体长什么样、响应里 `tool_calls` 字段长什么样，先在这里"瞟一眼"，免得第 3 章信息密度过高。

如果你的请求体里加上 `tools` 数组：

```json
{
  "model": "deepseek-chat",
  "messages": [
    { "role": "system", "content": "..." },
    { "role": "user", "content": "ls 一下当前目录" }
  ],
  "tools": [
    {
      "type": "function",
      "function": {
        "name": "bash",
        "description": "执行一条 bash 命令并返回 stdout/stderr",
        "parameters": {
          "type": "object",
          "properties": {
            "command": { "type": "string", "description": "要执行的命令" }
          },
          "required": ["command"]
        }
      }
    }
  ]
}
```

模型可能回这样的响应：

```json
{
  "choices": [
    {
      "message": {
        "role": "assistant",
        "content": null,
        "tool_calls": [
          {
            "id": "call_abc123",
            "type": "function",
            "function": {
              "name": "bash",
              "arguments": "{\"command\":\"ls -la\"}"
            }
          }
        ]
      },
      "finish_reason": "tool_calls"
    }
  ]
}
```

关键点：

- `content` 变成了 `null`——模型这次不说话，而是要求"调工具"。
- 多出一个 `tool_calls` 数组，每项有 `id`（这一次工具调用的唯一编号）、`function.name`（工具名）、`function.arguments`（**JSON 字符串**，要 `JSON.parse`！并不是一个真正的对象）。
- `finish_reason` 变成 `"tool_calls"`，告诉你"模型还没结束，等你执行工具"。

到时候我们要做的事情就是：执行 `bash ls -la`，把结果作为 `role: "tool"` 消息追加到 `messages` 里，再发一次请求。第 3 章见。

## 1.7 本章产出

你现在拥有：

- 一个能跑的最小 LLM 客户端（60 行 TS）。
- 对 `messages` / `role` / `content` / `choices` / `finish_reason` / `usage` 这些字段的清晰理解。
- 对 `tool_calls` 字段长什么样的初步印象。

你**没有**的：

- 流式输出（用户要等"完整答案出来"才能看到任何字符）
- 工具调用
- 任何 agent 行为

下一章我们解决第一个问题：让响应一个字一个字地流出来。我们要从一次性的 `await fetch(...)` 转去解析 Server-Sent Events，把它喂给一个 `AsyncIterable`。

→ [第 2 章 让响应流起来](02-streaming.md)
