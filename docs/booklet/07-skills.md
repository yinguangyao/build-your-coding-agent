# 第 7 章 技能

> 📂 **本章配套代码**：[https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch07](https://github.com/yinguangyao/build-your-coding-agent/tree/main/docs/booklet/code/ch07)

> 第 5、6 章给 agent 装上了工具——但工具是**写进代码**的：想加一个能力就得改源码、重新部署。可团队里真正想让 agent "学会"的东西，很多根本不是代码，而是**知识**：怎么给这个项目发版、commit message 守什么规范、内部那套发布 CLI 的参数顺序。这些写成文档人看了就会，为它改一版源码、重新发布显然不值。
>
> 2025 年底 Anthropic 给出的答案是 **Agent Skills**——把一项能力写成一个文件夹（一份 `SKILL.md` + 可选脚本），丢进约定目录，agent 就学会了，不写一行代码。规范开放在 [agentskills.io](https://agentskills.io)，pi、Claude Code 都认同一套。我会按老规矩**从零实现一个 skill 加载器**：最笨的版本 → 翻车 → 修，修完你会发现规范里每条看似多余的规定都在堵一个真实的坑。中间专门花一节回答一个绕不开的问题：**skill 能自带脚本，这些脚本在什么样的沙箱里跑？**

## 7.1 认识 Skills

工具长在 agent 的代码里，加一个就得改源码。但很多想让 agent 学会的能力其实是**知识**——发版流程、commit 规范、内部 CLI 用法。Anthropic 的 **Agent Skills** 就是为这种知识能力准备的：把一项能力写成一个文件夹（一份 `SKILL.md` 说明书 + 可选脚本资源），丢进约定目录，agent 就学会了，不改一行 agent 代码。Claude Code 率先落地，规范开放在 agentskills.io，很快成了跨工具标准，pi 实现的也是这一套。

别急着读规范，先看效果。我在 `demo-skills/` 里放了两个文件夹，agent 就多了两项本事：

```
demo-skills/
  release/
    SKILL.md            ← "怎么发版"的说明书
    bump-version.sh     ← 说明书里引用的脚本
  commit-style.md       ← "commit 规范"，简单到一个文件就够
```

```
$ npx tsx ch07/skills.ts
== 加载到的技能 ==
- commit-style: 按团队规范写 commit message。当用户要求提交代码或写 commit 时使用。
- release: 给本项目发版。当用户说"发版""发布新版本""bump version"时使用。
```

现在把 `release` 这个 skill 拆开给你看，规范的几部分一目了然：

```
release/                          ① 目录 = skill 的"包"，目录名兜底当名字
├── SKILL.md                      ② 唯一必需的文件
│   ├── --- frontmatter ---       ②a 元数据：给【加载器和模型】看的"商品标签"
│   │     name: release
│   │     description: 给本项目发版。当用户说"发版"…时使用。
│   ├── ------------------
│   └── 正文 markdown             ②b 说明书本体：给【模型】看的操作步骤
└── bump-version.sh               ③ 可选资源：脚本/模板/参考文件，正文里用相对路径引用
```

逐个说清每部分是干嘛的：

**① 目录**——skill 的分发单位。整个文件夹可以拷给同事、提交进 git、发布成包，到哪都能用。这正是"开放规范"的意义：同一个 skill 文件夹，Claude Code 和 pi 都认。

**②a frontmatter（YAML 元数据）**——夹在两行 `---` 之间，核心就两个字段：

| 字段 | 作用 | 约束 |
| --- | --- | --- |
| `name` | skill 的唯一标识，也是手动触发时的命令名（`/skill:release`） | 小写字母/数字/连字符，≤64 字符；**不写就用父目录名兜底** |
| `description` | **整个规范里最重要的一行字**——模型靠它（而不是正文）判断"什么时候该用这个技能" | 必填，≤1024 字符 |

为什么 `description` 地位这么高？因为它是唯一**常驻**模型上下文的部分（7.2 会看到）。写法上跟第 5 章工具的 description 一个道理：不光说"是什么"，还要说"**什么时候用**"——"当用户说'发版''bump version'时使用"这种触发词，直接决定技能会不会被想起来。

规范还允许各实现扩展自己的字段：pi 认 `disable-model-invocation`（7.5 讲），Claude Code 还有 `allowed-tools` 等——但 `name` + `description` 是跨工具通用的最小集。

**②b 正文**——普通 markdown，写给模型看的操作手册：步骤、规范、示例、注意事项。模型读到它之后照着做，所以写法就是"给一个聪明但不了解你项目的新同事写文档"。

**③ 资源文件**——脚本、模板、参考资料。正文里用**相对路径**引用（`./bump-version.sh`），按 skill 目录解析。这让 skill 不止能"教"，还能**自带工具**——说明书第一步就是"跑我带来的这个脚本"。（脚本由谁执行？在什么沙箱里跑？7.3 专门讲，答案可能跟你想的不一样。）

最后，**两种形态**：带资源的用目录式（`release/SKILL.md` + 文件们）；只有一段纯文字的可以缩成单文件（`commit-style.md`，frontmatter 写在文件头部）。7.4 会看到单文件形态有个必须注意的坑。

## 7.2 从零写加载器

规范看完了，按老规矩从零写加载器。活儿听起来很简单：**把技能的内容让模型看见**。最直觉的做法——扫描目录，把每个 skill 的全文拼进 system prompt：

```ts
// 第一版：简单粗暴
let skillSection = "\n\n# Skills\n";
for (const file of findAllSkillFiles(dir)) {
  skillSection += "\n---\n" + readFileSync(file, "utf-8");   // 全文拼进去
}
systemPrompt += skillSection;
```

两个 skill 的时候毫无问题。然后我算了一笔账：团队用了半年，攒了 30 个 skill，每个正文平均 800 字——

**翻车了，这是一笔每次请求都要交的冤枉税。** 30 × 800 字 ≈ 1.5 万 token **常驻** system prompt：

- 用户问"现在几点"，发版手册、commit 规范、数据库迁移指南……全部跟着这条请求**再发一遍**，按 token 计费；
- 第 1 章说过 messages 就是上下文——这 1.5 万 token 永久占着上下文窗口的一块，真正干活的对话空间被挤掉；
- 更糟的是注意力：30 份手册里 29 份跟当前任务无关，模型在噪音里反而容易看漏真正相关的那一份。

技能越多，agent 越笨、越贵。这个方向得换。

回头看 7.1 那张结构图，规范早就把答案藏在结构里了：**frontmatter 和正文是分开的**。frontmatter 是商品标签（很小），正文是说明书（很大）。那就只把标签放进 prompt，说明书留在磁盘上，**模型需要时自己用 read 工具去拿**——这就是规范的核心理念 **progressive disclosure**。

两种装法的 token 账，画出来一眼就分明：

```
第一版：全文塞
┌───────────────────── system prompt（每次请求都重发）─────────────────────┐
│ [发版手册 800字] [commit规范 800字] [迁移指南 800字] … ×30 ≈ 1.5万 token │  ← 常驻、计费、
│ 其中 29 份跟"现在几点"这种问题毫无关系，还在抢模型注意力                  │     挤占窗口
└──────────────────────────────────────────────────────────────────────────┘

progressive disclosure：只塞标签
┌───────────────────── system prompt ─────────────────────┐
│ <skill> name + description + location </skill> ×30        │  ← 清单 ≈ 千把 token
└───────────────────────────────────────────────────────────┘
                         │ 用户："帮我发个版" → description 命中
                         ▼
        模型 read(release/SKILL.md) 把那一份正文拉进上下文   ← 只有用到的才付费
```

实现分三步。先解析标签：

```ts
// 极简 frontmatter 解析（只认 --- 包起来的 key: value）
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
```

再扫目录——目录里有 `SKILL.md` 就是一个目录式 skill，根层散落的 `.md` 是单文件 skill：

```ts
export interface MiniSkill {
  name: string;
  description: string;
  filePath: string;   // ← 关键：记下全文在哪，等模型来读
  baseDir: string;    // ← 相对路径资源按这个目录解析
}

export function loadSkills(dir: string): MiniSkill[] {
  if (!existsSync(dir)) return [];
  const out: MiniSkill[] = [];
  for (const name of readdirSync(dir)) {
    const sub = join(dir, name);
    const file = existsSync(join(sub, "SKILL.md"))
      ? join(sub, "SKILL.md")                       // 目录式
      : name.endsWith(".md") ? sub : null;           // 单文件式
    if (!file) continue;
    const { fm } = parseFrontmatter(readFileSync(file, "utf-8"));
    if (!fm.description) continue;                   // 7.4 会解释这条
    out.push({
      name: fm.name ?? name.replace(/\.md$/, ""),
      description: fm.description,
      filePath: file,
      baseDir: dirname(file),
    });
  }
  return out;
}
```

最后，把"标签清单"渲染进 system prompt——**只有 name、description 和全文的位置**：

```ts
export function formatSkillsForPrompt(skills: MiniSkill[]): string {
  if (!skills.length) return "";
  const items = skills
    .map((s) =>
      `  <skill>\n    <name>${s.name}</name>\n` +
      `    <description>${s.description}</description>\n` +
      `    <location>${s.filePath}</location>\n  </skill>`)
    .join("\n");
  return (
    `\n\nThe following skills provide specialized instructions for specific tasks.\n` +
    `Use the read tool to load a skill's file when the task matches its description.\n` +
    `<available_skills>\n${items}\n</available_skills>`
  );
}
```

跑一下（`npx tsx ch07/skills.ts`，以下是真实输出）：

```
The following skills provide specialized instructions for specific tasks.
Use the read tool to load a skill's file when the task matches its description.
<available_skills>
  <skill>
    <name>commit-style</name>
    <description>按团队规范写 commit message。当用户要求提交代码或写 commit 时使用。</description>
    <location>.../code/ch07/demo-skills/commit-style.md</location>
  </skill>
  <skill>
    <name>release</name>
    <description>给本项目发版。当用户说"发版""发布新版本""bump version"时使用。</description>
    <location>.../code/ch07/demo-skills/release/SKILL.md</location>
  </skill>
</available_skills>
```

现在"模型怎么调用一个 skill"就清楚了——**没有任何新机制，复用第 5 章的 read**：

```
① system prompt 里有清单（每个 skill 一行标签 + 全文位置）
② 用户："帮我发个版"
③ 模型扫清单，release 的 description 命中
④ 模型自己发起 read("…/release/SKILL.md")     ← 这就是"调用 skill"
⑤ 全文进上下文，模型照着步骤干活（要跑 ./bump-version.sh 时按 baseDir 拼出绝对路径）
```

开头那两行指示语就是协议：第一行说"什么时候读"，清单里的 location 说"去哪读"。token 账也顺了：30 个 skill 的清单只占千把 token，正文只有被用到的那一份才进上下文——progressive disclosure 省掉的，正是前面那笔常驻税。

三个细节别漏：

- **XML 标签**包清单——模型对 XML 结构当"数据"读，不会跟对话混淆（后面压缩、注入的场景都是同一个惯例）；
- **指示语里还有一句路径规则**（pi 的完整版写的是 "When a skill file references a relative path, resolve it against the skill directory"）——告诉模型说明书里的 `./bump-version.sh` 要按 skill 目录解析，不是按 cwd；
- **这套机制的前提是工具集里有 `read`**。pi 的实现里有个明确门槛：没有 read 工具时，干脆不把 skills 段放进 prompt——清单给了也读不了，纯属浪费。

## 7.3 skill 脚本谁来执行

7.1 说过 skill 能自带脚本（`bump-version.sh`）。我第一次看到的时候也很自然地问：**这脚本谁来跑？需要给加载器写一个"脚本执行引擎"吗？**

答案是规范里最聪明的一个"不作为"：**不需要，根本没有"skill 运行时"这种东西。** 脚本的执行复用 agent 已有的 `bash` 工具——技能正文说"跑 `./bump-version.sh`"，模型按 baseDir 把相对路径拼成绝对路径（7.2 指示语里 "use that absolute path **in tool commands**" 说的就是这个），然后发起一次普通的 bash 调用。第 5 章的 bash 工具执行它，stdout 作为工具结果回来。

口说无凭。我把技能清单接进第 4 章的循环（`code/ch07/loop.ts`，把 `formatSkillsForPrompt(...)` 拼到 system prompt 末尾就完事了），真跑了一把——以下是**真实运行记录**（剪辑掉了部分中间输出）：

```
$ npx tsx ch07/loop.ts "帮我给这个项目发个 patch 版（最后打 tag 那步跳过）"
[tool] read({"path":".../demo-skills/release/SKILL.md"})        ← 路径 A：清单命中，读说明书
[result] ---\ndescription: 给本项目发版…\n---\n\n发版步骤：\n1. 跑 ./bump-version.sh …
[turn] 好的，按 skill 流程来：跑 bump 脚本升 patch 版本，跑测试，跳过打 tag。
[tool] bash({"command":"cd /tmp/demo && .../demo-skills/release/bump-version.sh patch"})
[result] bash: .../bump-version.sh: Permission denied\n\nCommand exited with code 126
[tool] bash({"command":"chmod +x .../bump-version.sh && cd /tmp/demo && .../bump-version.sh patch"})
[result] bump patch                                              ← 技能自带的脚本被 bash 工具执行了
[turn] 脚本输出正常，但没改版本号，手动更新 package.json：
[tool] edit({"path":"/tmp/demo/package.json","edits":[{"oldText":"\"version\": \"1.2.3\"","newText":"\"version\": \"1.2.4\""}]})
[result] Successfully replaced 1 block(s)
[tool] bash({"command":"cd /tmp/demo && npm test"})              ← 技能说明书的第 2 步
[result] > demo@1.2.4 test\n> echo all tests passed\n\nall tests passed
[turn] ✅ 完成！patch 版本已从 1.2.3 → 1.2.4，测试全绿。tag 已跳过。
[end]
```

这段记录里有几件事值得单独拎出来：

- **整条链没有任何新机制**：清单（7.2）→ `read` 说明书 → 按 baseDir 拼路径 → `bash` 跑脚本。技能"会执行脚本"是模型 + 既有工具组合出来的能力，不是加载器的功能——pi 的 `skills.ts` 里**一行执行代码都没有**，这是故意的。
- **执行面没有被扩大**。脚本走的是统一的 bash 通道，所以 bash 受到的一切管控——超时、输出截断、下面要讲的沙箱——**自动覆盖技能脚本**。
- **progressive disclosure 延伸到了代码**：500 行的脚本永远不进上下文，模型只看到一次调用和它的 stdout。把逻辑装进脚本而不是写在正文里，本身就是省 token 的技巧。
- **还白捡了一个真实的坑**：脚本没有可执行权限，bash 返回 `Permission denied`（exit 126）——模型读懂报错自己 `chmod +x` 修好了。技能作者的功课：要么保证脚本带 `+x` 提交，要么在说明书里写 `bash ./bump-version.sh`（不依赖执行位）。
- 最后留意它的应变：发现示例脚本只是 `echo`、没真改版本号，自己补了一手 `edit`——技能是**说明书**，不是宏。模型在"照着做"和"达成目标"之间始终有判断力。

### 脚本的沙箱

上面说得轻松，但反过来想一下：skill 是可以**拷给你、提交进别人仓库**的东西（7.1 说过，分发单位就是个文件夹）。你 clone 一个项目，`.pi/skills/` 里躺着一个 skill，正文第一步是"跑 `./deploy.sh`"——这脚本你没读过、是别人写的，模型却会照着 bash 出去。**skill 脚本本质上是近乎第三方的代码，跑的是任意命令。** 这正是该上沙箱的地方。

如果让我们自己设计这个沙箱，会怎么想？四个问题：

**① 在哪一层拦？** 这是整个设计里最省力的一步——前面反复说的"执行面没有被扩大"在这里直接变现：skill 脚本、模型自己想跑的命令、用户敲的命令，**全都从 bash 这一个口子出去**。所以沙箱只要卡住 bash 这一个收口，就覆盖了所有命令，skill 脚本一分不少。不用为 skill 单独写一套——它根本没有自己的执行通道。

**② 用什么机制隔离？** 进程级隔离不该自己造，操作系统早有现成的：macOS 的 `sandbox-exec`（Seatbelt），Linux 的 bubblewrap。它们能在内核层面圈定一个进程能读哪些路径、能写哪里、能连哪些网络。pi 用的是 Anthropic 封装的 `@anthropic-ai/sandbox-runtime`，把这两套抹平成一个接口。

**③ 拦下来之后，换成什么？** pi 在 bash 执行这层留了个 `user_bash` 钩子——扩展可以拦下每一次 bash 调用，换上自己的执行后端。默认不开沙箱时，命令直接 spawn，权限跟你本人在终端里敲一样（第 5 章见过，pi 连交互式确认都不做，是同一套最小内核的取舍）。装上沙箱扩展，钩子就把执行后端换掉：

```ts
pi.on("user_bash", () => {
  if (!sandboxEnabled) return;                       // 没开沙箱：走默认 spawn
  return { operations: createSandboxedBashOps() };   // 开了：换成沙箱版执行
});
```

换上的后端只多做一件事——把命令字符串先包一层 OS 隔离，再交给 bash：

```ts
const wrapped = await SandboxManager.wrapWithSandbox(command);
spawn("bash", ["-c", wrapped], { cwd, /* ... */ });
```

**④ 限制什么、放行什么？** 策略写在一份 `.pi/sandbox.json` 里，两个维度，都默认收紧、按需放开：

```json
{
  "network":    { "allowedDomains": ["registry.npmjs.org", "github.com", "*.github.com"] },
  "filesystem": { "denyRead":   ["~/.ssh", "~/.aws", "~/.gnupg"],
                  "allowWrite": [".", "/tmp"],
                  "denyWrite":  [".env", "*.pem", "*.key"] }
}
```

- **网络**：默认拒绝，给一份域名白名单放行（装依赖要用的 npm、github、pypi 这些）。白名单比黑名单是更安全的默认——没列的一律连不出去。
- **文件系统**：禁读敏感目录（`~/.ssh`、`~/.aws`、`~/.gnupg`），只许写当前项目目录和 `/tmp`，再禁写一批高危文件（`.env`、`*.pem`、`*.key`）。

落到 skill 上，妙处全在第 ① 步：`wrapWithSandbox` 包的是**一条命令字符串**，它根本不知道"skill"是什么。技能自带的 `deploy.sh`，落到这层就是一条普通 bash 命令。所以你一开沙箱，它和别的命令一起被关进同一个笼子——`skills.ts` 不需要、也确实没写一行配合代码。禁了网络，技能脚本就连不出去；不许写 `~/.ssh`，那个来路不明的 `deploy.sh` 也碰不到你的私钥。**安全策略长在 bash 这一个收口上，skill 没给自己凿新洞。**

> Claude Code 的处理方式一致（脚本同样经它的 Bash 工具执行），它的 `allowed-tools` 字段还能进一步限定"这个技能只许用哪些工具"——同一个思想：**技能的能力边界 = 它能用到的工具的边界**。

## 7.4 加载器的边界情况

加载器在干净的 demo 目录里跑得很好。放进真实环境，脏东西就来了。我挨个踩了一遍。

**脏东西一：没有 description 的 skill。** 有人丢了个没写 frontmatter 的笔记进 skills 目录。我第一反应是宽容点：description 缺了就拿正文第一行凑数？**不行。** description 是模型判断"何时用"的唯一依据，拿正文标题凑（"# 发版流程"）等于让模型瞎猜。所以 7.2 代码里那行 `if (!fm.description) continue` 就是规范的态度：**description 必填，缺了直接不加载**。一个永远不会被正确触发的技能，不如不存在。（name 可以兜底，description 不行。）

**脏东西二：单文件 skill 的 name 兜底陷阱。** "name 不写就用父目录名兜底"对目录式很友好，`release/SKILL.md` 的父目录就叫 release。但对**单文件** skill，`commit-style.md` 的父目录是 `demo-skills/` 本身！我去翻 pi 的真实实现，这个兜底逻辑是统一的（`name = frontmatter.name || 父目录名`），于是不写 name 的单文件 skill 全都叫 `demo-skills`，互相撞名。**所以：单文件 skill 必须显式写 name；要带脚本资源的，一律用目录式**，顺便还白得一个干净的专属 `baseDir`，相对路径不会跟别的 skill 混。

**脏东西三：重名。** 技能来源不止一处：pi 扫**全局** `~/.pi/agent/skills/`（个人通用技能）、**项目** `.pi/skills/`（这个仓库的技能，进 git 团队共享），还接受显式指定的路径。两边都有 `release` 怎么办？pi 的规则是**先到先得**：先加载的赢、后来的丢弃并记一条冲突诊断。而加载顺序是**全局在前、项目在后**，所以**同名时全局赢**。注意这跟直觉相反（也跟后面配置体系"项目覆盖全局"的方向相反），我一开始也记混了，以为项目里的版本生效了。

**脏东西四：不该被扫进来的文件。** 真实目录里有 `node_modules`、有 `.gitignore` 忽略的产物、有符号链接。我们的 mini 版只扫一层眼不见为净；pi 的完整实现有一套发现规则：目录里有 `SKILL.md` 就认定整个目录是一个 skill、**停止往下递归**（里面其它文件都算它的资源）；没有才继续找子目录里的 `SKILL.md`；全程跳过 dotfiles/`node_modules`、尊重 `.gitignore`，符号链接解引用后再判断。

## 7.5 手动触发

到这里技能是"模型自己决定用"的。我还差最后一块：**用户想直接点名**，"就按 release 这个技能来"，不想赌模型会不会想起来。再实现一条路径：用户敲 `/skill:release`，把全文**直接注入**这轮对话：

```ts
export function expandSkillCommand(text: string, skills: MiniSkill[]): string {
  if (!text.startsWith("/skill:")) return text;
  const space = text.indexOf(" ");
  const name = space === -1 ? text.slice(7) : text.slice(7, space);
  const args = space === -1 ? "" : text.slice(space + 1).trim();
  const skill = skills.find((s) => s.name === name);
  if (!skill) return text;                                       // 不认识就原样放行
  const { body } = parseFrontmatter(readFileSync(skill.filePath, "utf-8"));
  const block =
    `<skill name="${skill.name}" location="${skill.filePath}">\n` +
    `References are relative to ${skill.baseDir}.\n\n${body.trim()}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}
```

真实输出（demo 的第三段）：

```
== 路径 B：用户敲 /skill:release，全文直接注入 ==
<skill name="release" location=".../demo-skills/release/SKILL.md">
References are relative to .../demo-skills/release.

发版步骤：
1. 跑 `./bump-version.sh <major|minor|patch>` 更新 package.json（脚本在本 skill 目录里）
2. 跑测试：`npm test`，全绿才继续
3. 打 tag 并推送：…
</skill>

这次发个 patch 版本
```

注意注入块里那句 `References are relative to {baseDir}`，和 7.2 清单指示语里的路径规则呼应：无论哪条路径，模型都被告知"说明书里的相对路径按 skill 目录解析"。命令后面跟的文字（"这次发个 patch 版本"）拼在技能正文之后，变成这轮的具体要求。

两条路径对照：

| | 路径 A：模型自调用 | 路径 B：`/skill:name` |
| --- | --- | --- |
| 谁决定用 | 模型（description 命中） | 用户（手动点名） |
| 进上下文的 | 先只有清单，模型再 read 全文 | **全文立刻注入** |
| 依赖 read 工具 | 是 | 否（加载器自己读文件） |

有了路径 B，还能反过来玩：frontmatter 写 `disable-model-invocation: true`，让这个 skill **从路径 A 消失**（渲染清单时过滤掉，模型根本看不见），只留 `/skill:` 手动触发。用途：危险操作的 runbook、你只想自己在特定时刻调用的流程，说白了就是"模型别自作主张，我说用才用"。

## 7.6 怎么写好一个 skill

加载器写完了，但 skill 的效果一大半取决于**内容怎么写**。几条我自己踩出来的实践：

**① description 有公式：「做什么 + 什么时候用」。** 触发词必须写进去，模型扫清单时匹配的就是这一行字：

| 写法 | 效果 |
| --- | --- |
| ❌ `发版相关` | 太虚，模型不知道何时触发 |
| ❌ `这个技能能处理一切 git 相关问题` | 夸张万能 → 频繁**误**触发，挤掉真正该用的技能 |
| ✅ `给本项目发版。当用户说"发版""发布新版本""bump version"时使用。` | 做什么 + 触发词，精确命中 |

**② 单文件还是目录？标准很简单。** 一段纯文字、没有资源 → 单文件（**必须**显式写 name，7.4 的坑）；带脚本/模板、或正文超过一屏 → 目录式（白得一个干净的 baseDir）。

**③ 正文当 runbook 写，不当散文写。** 步骤编号、命令可直接复制、明确"什么算成功/什么算失败该停下"。你在第 5 章给工具写 description 的功夫，在这里要花在整个文档上，读者是同一个模型。

**④ 大块参考资料拆出去。** 一个 skill 要带 API 文档、字段对照表这种长资料时，别全写进 SKILL.md，拆成目录里的独立文件，正文里写"字段含义见 `./fields.md`"。模型需要时自己 read，**progressive disclosure 在 skill 内部继续生效**：SKILL.md 是第二层，资源文件是第三层。

**⑤ 常见反模式自查。** 把项目 README 原样丢进 skills 目录（没有触发场景，纯占清单）；一个 skill 塞下整个团队 wiki（description 写不准、正文超长，拆成多个）；脚本不带 `+x` 又不写 `bash` 前缀（7.3 的 126）；在 skill 目录里再嵌套 skill（扫不到）。

## 7.7 对照 pi 的工业级实现

写完这章，我打开 `packages/coding-agent/src/core/skills.ts` 对照了一遍。我们的 mini 版（`code/ch07/skills.ts`，离线可跑）和 pi 的真实实现（487 行）逐项对得上：

| 我们这章 | pi 源码 | pi 额外多做的 |
| --- | --- | --- |
| `parseFrontmatter` 极简版 | `utils/frontmatter.ts` | 完整 YAML 解析 |
| `loadSkills` 扫一层 | `loadSkillsFromDir`（`skills.ts:168-275`） | 递归发现（有 `SKILL.md` 停止下钻）、`.gitignore`/symlink 处理 |
| `description` 必填丢弃 | `loadSkillFromFile`（`:277-325`） | name 格式校验（`^[a-z0-9-]+$`、≤64，违规出 warning 但仍加载）、description ≤1024 |
| —— | `loadSkills`（`:387-487`） | 三来源（全局/项目/显式路径）、collision 先到先得 + 诊断、realpath 去重 |
| `formatSkillsForPrompt` | 同名函数（`:335-361`） | 同款 XML 清单（agentskills.io 的 integrate-skills 一节就是这个格式）、`disable-model-invocation` 过滤、XML 转义 |
| `expandSkillCommand` | `_expandSkillCommand`（`agent-session.ts:1155`） | 在会话层展开，所以非交互模式同样可用；读文件失败走诊断通道 |

## 7.8 踩过的坑与产出

先把坑列一遍，帮你省点时间：

1. **全文常驻 prompt 是一笔每次请求都交的税**——30 个 skill ≈ 1.5 万 token 噪音。progressive disclosure 不是优化，是规模化的前提。
2. **`description` 必填，缺了直接丢**——它是模型"想起这个技能"的唯一线索，拿正文标题凑数等于瞎猜。写法要带触发词（"当用户说 X 时使用"）。
3. **单文件 skill 必须显式写 name**——兜底逻辑取父目录名，单文件的父目录是 skills 根目录，全撞成一个名字。带资源的一律用目录式。
4. **重名是先到先得，全局在项目前加载 → 全局赢**——跟配置体系"项目覆盖全局"方向相反，我一开始也记混了。
5. **路径 A 依赖 read 工具**——没有 read 就别把清单放进 prompt，给了也读不了。
6. **相对路径按 skill 目录（baseDir）解析**——两条路径的注入文本里都要把这条规则告诉模型，否则它会拿 cwd 去拼 `./bump-version.sh`。
7. **技能脚本没有独立运行时——执行走 bash 工具**。好处是 bash 的全部管控自动覆盖技能脚本：打开 pi 的沙箱扩展（`user_bash` 钩子 + `sandbox-exec`/bubblewrap），那个来路不明的脚本不用任何配合就一并被隔离。代价是脚本要么带 `+x` 提交、要么说明书里写 `bash xxx.sh`，否则模型会撞上 exit 126。
8. **`disable-model-invocation` 只关路径 A**——清单里不渲染，模型看不见；`/skill:` 手动触发照常可用。
9. **目录里有 `SKILL.md` 就停止递归**——别在一个 skill 目录里再嵌套别的 skill，扫不到。

**本章产出。** 到这里你手上有了：

- 对 **Agent Skills 规范**的透彻理解：目录是分发单位、frontmatter 是常驻的"商品标签"（name 可兜底、description 必填）、正文是按需加载的说明书、资源按 baseDir 解析。
- 一个从"全文塞 prompt"翻车开始、一步步修出来的加载器（`code/ch07/skills.ts`）：frontmatter 解析、目录扫描、XML 清单渲染（路径 A）、`/skill:` 注入（路径 B），离线一条命令可跑。
- 一笔算清楚的 token 账——知道 progressive disclosure 为什么是规范的核心，而不是一个时髦词。
- 一套"skill 脚本在哪一层被沙箱关住"的设计：拦在 bash 这唯一收口、用 OS 级隔离、默认收紧白名单放行——以及"为什么 skills.ts 一行配合代码都不用写"的答案。

不改代码给 agent 加能力——技能这条路就走完了。接下来转向"agent 怎么记住、回溯、积累"——先从最基础的开始：怎么把一段对话**存下来**、重启后接着聊。

→ [第 8 章 会话持久化与多会话](08-sessions.md)
