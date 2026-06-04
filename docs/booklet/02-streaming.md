# 第 2 章 让响应流起来

> 第 1 章我们等模型整段答案生成完才打印。如果答案 500 字，光生成可能就要 5 秒——5 秒里用户对着一个空终端，体验非常糟。
>
> 这一章把这次 HTTP 调用改成"流式"：模型每生成一个 token 就推一段过来，我们边收边打印，做出"打字机"效果。
>
> 但流式背后藏了三个我们之前没见过的东西：**SSE 协议**、**ReadableStream**、**AsyncIterable**。我们一个一个拆开讲，不留任何"黑盒"。

## 2.1 这一章要做什么

体感是这样的：

```bash
$ npx tsx hello.ts "解释一下 React 的 hooks 是什么"
React 的 Hooks 是…………（一边敲一边出，像打字机）
--- (stop, 132 tokens in / 280 out) ---
```

代码量比第 1 章多了一点（大约 130 行），但**多出来的部分全是解析协议**，不是新的业务逻辑。

学完这一章你会拥有：

- 一个能解析 OpenAI 兼容 SSE 流的 `streamOpenAI()` 函数。
- 一个 `AssistantMessageEventStream` 风格的事件流抽象（pi 的 `packages/ai/src/utils/event-stream.ts` 里也是这么写的，长 88 行，我们等会儿把它逐字看一遍）。
- 后面所有章节都能复用这两个东西。

## 2.2 SSE 是什么

**SSE = Server-Sent Events**，是一个 W3C 标准（属于 HTML5 标准的一部分），定义了"服务端通过一条普通的 HTTP 长连接持续往客户端推送文本事件"的格式。

跟你已经会的东西比一下：

| 协议 | 方向 | 用什么传输 | 难度 |
| --- | --- | --- | --- |
| 普通 HTTP 请求 | 一次性返回 | TCP | 你已经会 |
| WebSocket | 双向，客户端服务端都能主动发 | TCP，自己的握手 | 偏复杂 |
| **SSE** | **单向，只能服务端推** | **就是一条没读完的 HTTP 响应** | **比 WebSocket 简单很多** |

直觉类比：**SSE 就像是只能写不能读的单向 WebSocket，而且它复用普通 HTTP，不需要单独的握手协议。**

为什么大模型用 SSE 而不是 WebSocket？

1. 因为模型只需要往外推 token，不需要客户端中途说话——这是 SSE 的核心场景。
2. SSE 直接走 HTTP，所有反向代理、CDN、负载均衡器都天然支持，不需要 WS Upgrade 配置。
3. 实现简单：服务端 `Content-Type: text/event-stream`，按格式打文本就行；客户端读一个普通响应即可。

### SSE 协议长什么样

服务端往响应体里写**事件**，每个事件由若干行文本组成，**事件之间用一个空行分隔**。最简单的形式：

```
data: hello

data: world

```

注意：

- 每行以 `data: ` 开头（冒号后面有一个空格——空格是可选的，大多数实现会写）。
- **一个空行**（即 `\n\n`）表示**当前事件结束**。
- 客户端把多个连续的 `data:` 行的内容拼起来，作为一个事件的数据。

对 OpenAI 兼容协议来说，每个 `data:` 行的内容是一段 JSON 字符串。一次 chat completion 的 SSE 长这样（我加了行号方便讲解，**真实流里没有行号**）：

```
1   data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"role":"assistant","content":""},"finish_reason":null}]}
2
3   data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"二分"},"finish_reason":null}]}
4
5   data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{"content":"搜索"},"finish_reason":null}]}
6
7   ...
8
9   data: {"id":"chatcmpl-1","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}
10
11  data: [DONE]
12
```

逐项拆解：

- 每个 chunk（"块"，模型生成的一小段）都是 `data: ` 开头、一行 JSON、紧跟一个空行。
- JSON 里的 `choices[0].delta` 是这一块**新增的内容**——不是累积值。你拿到 `"二分"` 后下一块拿到 `"搜索"`，要自己拼成 `"二分搜索"`。这是流式协议的关键约定。
- `finish_reason` 在前面几个 chunk 里都是 `null`（"还没结束"），最后一个 chunk 是 `"stop"`。
- 最后还会有一个特殊的 `data: [DONE]`——它**不是 JSON**，是 OpenAI 协议规定的"我真的发完了"哨兵。Anthropic 协议没有这个哨兵，靠 `message_stop` 事件类型表示结束（第 16 章再细看）。

> **题外话**：SSE 标准其实还允许 `event:` / `id:` / `retry:` 等字段，但 OpenAI 协议只用 `data:`，简化了不少。

## 2.3 我们要写哪些 API

要把上面这个 SSE 流喂给"打字机"般的输出，我们至少要拼三层：

1. **底层：从 `fetch` 拿到一个字节流**。`fetch` 返回的 `resp.body` 是一个 `ReadableStream<Uint8Array>`，每次读一段字节。
2. **中层：把字节流切成 SSE 事件**。我们要找 `\n\n` 边界，把前面累积的 `data:` 行解析出来，丢掉空行。
3. **高层：把每个事件转成结构化 chunk**。`JSON.parse` 那段字符串，提取 `delta`，累加到一个 `AssistantMessage` 上。

下面我们先把每一层用到的 web API 单独介绍一下，避免你看代码时"这是什么？"

### `fetch` + `resp.body`

`fetch(...)` 返回的 `Response` 有一个 `.body` 属性，类型是 `ReadableStream<Uint8Array>`。

- `Uint8Array` 是 JavaScript 的"字节数组"，你可以把它当成 `byte[]`。
- `ReadableStream` 是 web 标准里"可读流"的抽象：你不能一口气拿到所有数据，而是要不停地从它身上"读出下一块"。

通常我们这样用它：

```ts
const reader = resp.body.getReader();
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  // value 是 Uint8Array，是这一片字节数据
}
```

- `getReader()` 返回一个独占的读取器，同一时间只能有一个 reader 在读。
- `reader.read()` 返回 `Promise<{ value: Uint8Array; done: boolean }>`。`done` 为 `true` 表示流已经关掉了。
- 这里没有"想读多少字节"的参数——服务端推多大块你就拿多大块。可能一个 chunk 是 50 字节，也可能 500 字节，**还可能正好把一行 JSON 切到中间**。所以我们需要自己缓冲。

### `TextDecoder`

`Uint8Array` 是字节，但 SSE 协议里数据是文本（UTF-8 编码的 JSON）。我们需要把字节解码成字符串。

`TextDecoder` 是 web 标准 API（Node 也内置了），用来"按某种编码把字节流解成文本"：

```ts
const decoder = new TextDecoder("utf-8");
const text = decoder.decode(uint8Array, { stream: true });
```

- `"utf-8"` 是编码名。SSE 文本流默认就是 UTF-8（HTTP 文本的通用编码），跟 OpenAI 没有特殊关系——任何 SSE 流都这么解。
- **`{ stream: true }` 非常重要**：UTF-8 是变长编码，一个中文字符占 3 字节。如果一个字符的 3 个字节正好被切到两个 chunk 里，不加 `stream: true` 会把切边的字节解成 `�` 乱码字符。加上 `stream: true`，decoder 会在内部缓存"半个字符"，等下一次 `decode()` 时拼起来。
- 全部读完后再 `decoder.decode()`（无参或 `{ stream: false }`）一次，flush 掉残留 buffer。

如果你不用 `TextDecoder`，用 `Buffer.from(value).toString("utf-8")` 也能写——但那是 Node 专属 API，不能在浏览器里跑；并且 Buffer 没有 `stream` 模式，跨 chunk 中文就会乱码。pi 选择 `TextDecoder` 是为了同一份代码在 Node / 浏览器 / Bun / Deno 都能跑。

### `AsyncIterable` 和 `async function*`

我们希望调用者用一种很自然的方式消费 chunk：

```ts
for await (const chunk of streamOpenAI(...)) {
  process.stdout.write(chunk.delta);
}
```

这个 `for await ... of` 语法跟你熟悉的 `for ... of` 几乎一样，只是循环体里每次拿到的是一个 `Promise` 的值——它**会自动 `await` 每一项**。

要让一个东西能被 `for await` 消费，它必须实现 `AsyncIterable` 接口。最简单的方式是**异步生成器（async generator）**：

```ts
async function* numbers() {
  yield 1;
  await someAsyncOp();
  yield 2;
  yield 3;
}
```

`async function*`（注意星号在 `function` 后面）告诉 JS：

- 调用 `numbers()` 不会立刻执行函数体，而是返回一个 `AsyncIterable`。
- 每次外面 `for await` 取一项时，函数体执行到下一个 `yield`，把 `yield` 后面的值"吐"出去，然后暂停。
- 函数体里可以 `await`，等待异步操作完成后再继续。
- 函数 `return`（或自然走完）就表示流结束。

如果你熟悉 Python 的 `async def` + `yield`，是同一个东西。如果你只熟悉 RxJS，可以把它当成"最小化的 Observable，只能消费一次"。

后面的 `streamOpenAI()` 就是一个 `async function*`。

## 2.4 写代码

完整代码在 `code/ch02/hello.ts`，下面分块讲。

### 第 1 块：调 fetch，拿到流

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
    stream: true,            // ← 这是关键
  }),
});

if (!resp.ok) {
  throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
}
if (!resp.body) {
  throw new Error("没有响应体");
}
```

跟第 1 章相比只多了一行 `stream: true`。服务端看到这个字段，就会把 `Content-Type` 设为 `text/event-stream`，开始按 SSE 协议推。

### 第 2 块：把字节流切成 SSE 事件（生成 `string` 行）

```ts
async function* readSSE(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";

  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      // 流读完之后，flush 一下 decoder 内部 buffer，
      // 再处理 buffer 里剩下的内容（极少数情况下结尾没有 \n\n）
      buffer += decoder.decode();
      if (buffer.length > 0) yield buffer;
      return;
    }

    buffer += decoder.decode(value, { stream: true });

    // 在 buffer 里找事件边界 "\n\n"
    let boundary;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const raw = buffer.slice(0, boundary);
      buffer   = buffer.slice(boundary + 2);
      yield raw;
    }
  }
}
```

逐行讲：

- `async function* readSSE(...)`：异步生成器，每次 `yield` 一个**完整 SSE 事件块**（裸字符串，可能是 `"data: {...}"` 或 `"data: [DONE]"`），不包括末尾的空行。
- `const reader = body.getReader()`：拿到字节级读取器。
- `const decoder = new TextDecoder("utf-8")`：复用同一个 decoder，跨 chunk 处理半个字符。
- `let buffer = ""`：累积"读到了一半"的文本。SSE 边界 `\n\n` 可能正好被 TCP 切到两个 chunk 里，所以我们要自己缓冲。
- `while (true) { const { value, done } = await reader.read(); }`：核心循环。
  - `done === true`：流结束。这时我们仍然要 `decoder.decode()`（不带 value）让它 flush 内部缓冲，然后把 buffer 里残留的事件吐出去。
  - `done === false`：`value` 是一段 `Uint8Array`，解码成文本，append 到 buffer。
- `buffer.indexOf("\n\n")`：在 buffer 里找第一个事件边界。
  - 找到了：从开头切到 `boundary` 是这次的事件（裸文本），剩下的留在 buffer 里继续。
  - 没找到：跳出内层 `while`，等下一次 `reader.read()` 读更多数据。
- `yield raw`：把这一个事件块抛给上一层调用者。

**这个函数没碰任何 JSON、没碰 OpenAI**——它纯粹处理 SSE 协议。这意味着它可以复用给 Anthropic Messages 流（它们也走 SSE）。pi 在 `packages/ai/src/providers/openai-completions.ts` 里其实**没有手写 SSE 解析**，而是用了 OpenAI 官方的 `openai` npm 包帮它做这件事。但我们这本小册的目的是搞懂原理，所以手写一遍。

### 第 3 块：把 SSE 事件块解析成结构化 chunk

```ts
type OpenAIDelta = {
  role?: "assistant";
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type OpenAIChunk = {
  choices: Array<{
    index: number;
    delta: OpenAIDelta;
    finish_reason: null | "stop" | "length" | "tool_calls" | "content_filter";
  }>;
};

function parseSSEEvent(raw: string): OpenAIChunk | "done" | null {
  // 一个事件块可能有多行，我们只看 "data:" 行
  let dataPart = "";
  for (const line of raw.split("\n")) {
    if (line.startsWith("data:")) {
      // 去掉 "data:" 前缀，连同后面那个可选空格
      dataPart += line.slice(line[5] === " " ? 6 : 5);
    }
  }
  if (!dataPart) return null;
  if (dataPart === "[DONE]") return "done";
  try {
    return JSON.parse(dataPart) as OpenAIChunk;
  } catch {
    return null;
  }
}
```

讲解：

- `OpenAIDelta`：服务端推过来的"增量"，可能带 `content`（文本碎片）或者 `tool_calls`（工具调用的增量参数）。**记住：它是增量，不是累积值。**
- `OpenAIChunk`：完整的 chunk 结构，跟非流式响应几乎一样，只是 `message` 变成了 `delta`。
- `parseSSEEvent(raw)`：
  - 遍历 raw 里每一行，只挑出以 `data:` 开头的。技术上 SSE 还有 `event:` / `id:` 等字段，但 OpenAI 不用，所以忽略。
  - 把所有 `data:` 行的内容拼起来。`line.slice(line[5] === " " ? 6 : 5)` 是处理 "`data:`" 后面那个**可选空格**（OpenAI 会带，Anthropic 风格服务有时不带）。
  - 如果拼出来是 `[DONE]`，返回特殊标记 `"done"`，让上层知道流结束。
  - 否则 `JSON.parse`，返回结构化的 chunk；解析失败就返回 `null` 让上层跳过。

### 第 4 块：把 chunk 累加成完整的 `AssistantMessage`

```ts
type AssistantMessage = {
  role: "assistant";
  content: string;
  tool_calls: Array<{ id: string; name: string; arguments: string }>;
  finish_reason: "stop" | "length" | "tool_calls" | null;
};

async function* streamOpenAI(req: {
  baseUrl: string;
  apiKey: string;
  model: string;
  messages: any[];
  tools?: any[];
}): AsyncIterable<{ delta?: string; done?: AssistantMessage }> {
  const resp = await fetch(`${req.baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${req.apiKey}`,
    },
    body: JSON.stringify({
      model: req.model,
      messages: req.messages,
      tools: req.tools,
      stream: true,
    }),
  });

  if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${await resp.text()}`);
  if (!resp.body) throw new Error("无响应体");

  // 累积当前 assistant message
  const acc: AssistantMessage = {
    role: "assistant",
    content: "",
    tool_calls: [],
    finish_reason: null,
  };

  for await (const raw of readSSE(resp.body)) {
    const parsed = parseSSEEvent(raw);
    if (parsed === null) continue;
    if (parsed === "done") {
      // OpenAI 会在 finish_reason 之后再发 [DONE]，我们已经在前面收过 finish_reason 了
      break;
    }

    const choice = parsed.choices?.[0];
    if (!choice) continue;
    const delta = choice.delta;

    // 1) 文本增量
    if (typeof delta.content === "string" && delta.content.length > 0) {
      acc.content += delta.content;
      yield { delta: delta.content };
    }

    // 2) 工具调用增量（第 3 章详谈，这里先把架子搭起来）
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        // tc.index 标识这是 acc.tool_calls 里第几个工具调用
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

    // 3) 结束原因
    if (choice.finish_reason) {
      acc.finish_reason = choice.finish_reason as any;
    }
  }

  yield { done: acc };
}
```

要点：

- 我们对外暴露的事件类型只有两种：`{ delta: string }`（"又来了一段文本"）和 `{ done: AssistantMessage }`（"全说完了，这是完整结果"）。pi 的 `AssistantMessageEvent`（`packages/ai/src/types.ts:353-365`）更细，分了 `text_start`/`text_delta`/`text_end`/`thinking_*`/`toolcall_*`/`done`/`error` 共 11 种事件类型——我们的简化版只用 2 种就够了。
- `acc.content += delta.content`：拼接文本。
- `acc.tool_calls[tc.index]`：工具调用按 `index` 索引到对应"槽位"。为什么需要 index？因为模型可以**一次性发起多个工具调用**（"并行 tool call"），每次 delta 只更新其中一个。`index` 告诉我们这一段增量属于哪个调用。
- `slot.arguments += tc.function.arguments`：工具调用参数本身也是流式拼接的字符串（最终是一段 JSON 文本）。**别在这里就 `JSON.parse`**，因为它可能是半截的——第 3 章我们等流结束再 parse。
- `yield { delta: ... }` 和 `yield { done: acc }`：把事件抛给最外层调用者。

### 第 5 块：调用方代码（打字机效果）

```ts
const messages = [
  { role: "system", content: "你是一个简明的中文助手。" },
  { role: "user",   content: userInput },
];

let finalMessage: AssistantMessage | undefined;
for await (const ev of streamOpenAI({ baseUrl, apiKey, model, messages })) {
  if (ev.delta) {
    process.stdout.write(ev.delta);
  }
  if (ev.done) {
    finalMessage = ev.done;
  }
}

if (finalMessage) {
  console.log(
    `\n--- (finish_reason: ${finalMessage.finish_reason}) ---`,
  );
}
```

`process.stdout.write` 而不是 `console.log`——后者会自动加换行，会把打字机效果毁掉。

跑起来你就能看到一字一字流出来。

## 2.5 对照 pi 的真实实现：`AssistantMessageEventStream`

我们用 `async function*` 把流"挤"了出来。pi 用一个稍微不一样的写法：**它先实现了一个通用的 `EventStream<T, R>`，再把流式 chunk 变成 `AssistantMessageEvent` 推进去**。

打开 `packages/ai/src/utils/event-stream.ts`，整个文件只有 88 行。前 67 行是 `EventStream<T, R>`，剩下是它的一个特化。

```ts
// 选取自 packages/ai/src/utils/event-stream.ts
export class EventStream<T, R = T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private waiting: ((value: IteratorResult<T>) => void)[] = [];
  private done = false;
  private finalResultPromise: Promise<R>;
  private resolveFinalResult!: (result: R) => void;
  private isComplete: (event: T) => boolean;
  private extractResult: (event: T) => R;

  constructor(isComplete: (event: T) => boolean, extractResult: (event: T) => R) {
    this.isComplete = isComplete;
    this.extractResult = extractResult;
    this.finalResultPromise = new Promise((resolve) => {
      this.resolveFinalResult = resolve;
    });
  }

  push(event: T): void { /* … */ }
  end(result?: R): void { /* … */ }
  async *[Symbol.asyncIterator](): AsyncIterator<T> { /* … */ }
  result(): Promise<R> { return this.finalResultPromise; }
}
```

为什么 pi 不用 `async function*`，而是手写一个类？

- `async function*` 是"**拉模式**"：调用方调用 `next()`，函数体才往前跑一步。
- 但 pi 的协议层是"**推模式**"：协议处理代码（来自 `openai` SDK 或 Anthropic SDK）会不停往里**推**事件，跟你的消费者节奏未必一致。

`EventStream` 在内部维护两个队列：

- `queue: T[]`：还没人来取的事件（生产者推得比消费者快）。
- `waiting: ((value) => void)[]`：在等下一个事件的 promise resolver（消费者比生产者快，先来等着）。

`push(event)` 的实现（节选）：

```ts
push(event: T): void {
  if (this.done) return;
  if (this.isComplete(event)) {
    this.done = true;
    this.resolveFinalResult(this.extractResult(event));
  }
  const waiter = this.waiting.shift();
  if (waiter) {
    waiter({ value: event, done: false });
  } else {
    this.queue.push(event);
  }
}
```

逐行：

- `if (this.done) return`：已经结束就丢弃后续事件，避免乱推。
- `if (this.isComplete(event))`：构造时传入的判定函数，比如 `(e) => e.type === "done" || e.type === "error"`——告诉 `EventStream` 哪些事件是"终结事件"。
- `this.resolveFinalResult(this.extractResult(event))`：把终结事件里的"最终结果"取出来（用另一个构造时传入的函数），resolve 给 `result()` 返回的那个 promise。这样调用者既可以 `for await` 拿过程，也可以 `await stream.result()` 直接拿最终的 `AssistantMessage`。
- 后半段：有人在等就直接 fulfil promise，没人在等就先排进队列。

`[Symbol.asyncIterator]()` 实现：

```ts
async *[Symbol.asyncIterator](): AsyncIterator<T> {
  while (true) {
    if (this.queue.length > 0) {
      yield this.queue.shift()!;
    } else if (this.done) {
      return;
    } else {
      const result = await new Promise<IteratorResult<T>>(
        (resolve) => this.waiting.push(resolve),
      );
      if (result.done) return;
      yield result.value;
    }
  }
}
```

- 优先吐掉 queue 里堆积的事件。
- queue 空了但 `done === true` 就结束。
- 都没有就 `await` 一个 promise，把它的 resolver 挂到 `waiting` 上，等生产者来 push。

这是经典的 **"unbounded async queue"**，N:1 推模式 + 拉模式消费者之间的桥梁。pi 自己的 agent 循环、SDK provider 都靠它打通。

`AssistantMessageEventStream` 只是 `EventStream` 的一个特化：

```ts
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
  constructor() {
    super(
      (event) => event.type === "done" || event.type === "error",
      (event) => {
        if (event.type === "done")  return event.message;
        if (event.type === "error") return event.error;
        throw new Error("Unexpected event type for final result");
      },
    );
  }
}
```

它把"什么算结束"和"结束时拿出哪个 `AssistantMessage`"两个判定填进父类即可。

## 2.6 把我们的 `streamOpenAI` 改造一下

为了让后面章节方便用，我们把第 4 块换一个写法，让它返回 `EventStream` 实例而不是 `AsyncIterable`：

```ts
// 简化版的 EventStream，留给读者自己抄
const stream = new EventStream<MyEvent, AssistantMessage>(
  (e) => e.type === "done",
  (e) => (e as DoneEvent).message,
);

// 然后在后台异步把 chunk push 进去：
(async () => {
  for await (const raw of readSSE(resp.body)) {
    // …如前面，调用 stream.push({...})
  }
  stream.push({ type: "done", message: acc });
})().catch((err) => stream.push({ type: "error", error: err }));

return stream;
```

这样调用方既可以 `for await (const ev of stream)` 拉事件，也可以 `await stream.result()` 直接拿最终消息。

第 4 章我们写 agent 循环时会用到 `await stream.result()`——agent 循环每一轮都是"先拿到完整 assistant message，再决定要不要执行工具"，所以 `result()` 接口非常合手。

## 2.7 这一章踩到的坑

写流式解析最容易踩的几个坑，记一下，省得后面再栽进去：

1. **以为 `delta.content` 是累积值**。它是增量，要自己 `+=`。
2. **以为 SSE 一行就是一个事件**。其实是"连续 `data:` 行+一个空行"才是一个事件。
3. **以为字节流是按行切的**。一个 TCP packet 可能正好把 `"二分搜索"` 的某个字节切在中间，所以要 `TextDecoder({ stream: true })` + `buffer.indexOf("\n\n")`。
4. **以为 `[DONE]` 是 JSON**。它不是。先比较字符串，再 `JSON.parse`。
5. **以为 `tool_calls[i]` 是完整对象**。它的 `arguments` 是流式拼接的字符串，**结束之后**才能 `JSON.parse`。
6. **以为流一定会正常收尾**。网络可能在 `[DONE]` 之前就断（`reader.read()` 抛错，或者干脆 `done` 了但你从没收到 `finish_reason`）。我们这版 `streamOpenAI` 只在 `!resp.ok` 时报错，对"读到一半断开"没有处理——表现就是 `acc.finish_reason` 停在 `null`，你拿到一个**不完整的 message**。生产代码要把这种情况识别出来（`finish_reason === null` 即视为流异常中断），要么重试、要么明确报错，别把半截消息当成功结果塞进历史。

## 2.8 本章产出

你现在拥有：

- 一个能解析 OpenAI 兼容 SSE 流的 `streamOpenAI()`，对外吐 `delta`/`done` 事件。
- 对 SSE 协议、`ReadableStream`、`TextDecoder({ stream: true })`、`async function*`、`AsyncIterable` 这一整套 web 流式基础设施的清晰理解。
- 对 pi 的 `EventStream<T, R>` 设计思路的把握——能看懂为什么它要手写一个推模式队列。

下一章我们把 `tools` 字段加进请求体，让模型主动调用我们写的"工具"，并把工具执行结果塞回 `messages` 里发第二次请求。这是"agent"的第一缕雏形。

→ [第 3 章 第一个工具调用](03-first-tool.md)
