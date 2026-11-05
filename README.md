# mox

一个零依赖的 Coding Agent，全部代码 480 行，每个机制一个文件。

它是一个能用的命令行 Agent：读代码、改文件、跑命令，会话可以恢复，上下文满了会压缩，能接 MCP 服务器、加载 Skills 和扩展，还能把子任务交给子 Agent。同时它短到一个下午就能读完，是 [Learn Pi Agent](https://github.com/Jialei-03/learn-pi-agent) 课程里动手搭 Agent 的范例。

```
› 运行 python3 test_calc.py，修好失败的测试

● bash {"command":"python3 test_calc.py"}
  ✓ Traceback (most recent call last): … AssertionError [退出码 1]
● read {"path":"calc.py"}
  ✓ 1 def add(a, b): 2 return a - b
● edit {"path":"calc.py","old":"return a - b","new":"return a + b"}
? 允许 edit …  [y] 允许  [a] 本次会话都允许  [n] 拒绝 y
  ✓ 已修改 calc.py
● bash {"command":"python3 test_calc.py"}
  ✓ ok [退出码 0]
修好了：add 原来写成了减法，改成 a + b 后测试通过。
```

## 安装

需要 Node.js 22.18 或更新版本（直接运行 TypeScript，不用编译，也没有 npm 依赖）。

```bash
git clone https://github.com/Jialei-03/Mox-agent.git
cd Mox-agent && npm link      # 之后在任何目录都能用 mox 命令
```

模型走 OpenAI 兼容的 Chat Completions 接口，MiniMax、DeepSeek、OpenAI、OpenRouter、Ollama 等都可以：

```bash
export MOX_BASE_URL=https://api.minimaxi.com/v1
export MOX_API_KEY=你的 Key
export MOX_MODEL=MiniMax-M3.1-Flash
```

## 用法

```bash
mox                      # 交互模式
mox -p "修复失败的测试"    # 执行一次就退出
mox -c                   # 继续这个目录最近一次的会话
mox --yolo               # 执行工具前不再询问
mox --trust              # 同时加载项目里的 .mox/ 和 .agents/skills
```

交互模式里：运行中直接打字，这句话会作为“插话”在下一轮送到模型；Ctrl+C 取消当前运行；`/compact` 手动压缩上下文；`/<skill 名>` 使用某个 Skill；`/exit` 退出。

## 代码地图

| 文件 | 行数 | 机制 |
| --- | --- | --- |
| [`src/model.ts`](src/model.ts) | 43 | 流式调用模型，把分片到达的工具调用拼完整 |
| [`src/loop.ts`](src/loop.ts) | 61 | Agent 循环：请求 → 执行工具 → 交回结果，直到模型不再调用工具；插话、取消、截断保护 |
| [`src/tools.ts`](src/tools.ts) | 60 | `read`、`write`、`edit`、`bash` 四个工具，输出过长时截断 |
| [`src/session.ts`](src/session.ts) | 43 | 会话写成 JSONL，逐条追加；恢复时给中途退出的工具调用补上“中断” |
| [`src/compact.ts`](src/compact.ts) | 24 | 上下文压缩：较早的消息交给模型写成摘要，切点只落在用户消息前 |
| [`src/context.ts`](src/context.ts) | 42 | 系统提示：AGENTS.md / CLAUDE.md、Skills 目录 |
| [`src/mcp.ts`](src/mcp.ts) | 54 | MCP 客户端：stdio 上的 JSON-RPC，把服务器的工具变成 mox 的工具 |
| [`src/cli.ts`](src/cli.ts) | 153 | 命令行：权限确认、扩展、子 Agent、交互与一次性两种模式 |

建议的阅读顺序：`model.ts` → `loop.ts` → `tools.ts` → `cli.ts`，读完这四个文件就理解了一个 Agent 的骨架，其余每个文件各自补上一种能力。

## 配置

`~/.mox/` 下的配置总是加载；项目里的 `.mox/` 可能是别人写的代码，加 `--trust` 才加载。

```
~/.mox/
├── AGENTS.md          # 对所有项目生效的说明
├── mcp.json           # MCP 服务器
├── extensions/*.ts    # 扩展
├── skills/<名字>/SKILL.md
└── sessions/          # 会话记录（自动生成）
```

**项目说明**：从根目录到工作目录，每一层的 `AGENTS.md`（没有就找 `CLAUDE.md`）都会放进系统提示。

**MCP**（格式和 Claude Code 一样）：

```json
{ "mcpServers": { "fs": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "."] } } }
```

工具名会变成 `mcp__fs__read_file` 这样的形式。

**Skills**：每个 Skill 是一个目录，`SKILL.md` 开头用 frontmatter 写 `name` 和 `description`。系统提示里只列名字和描述，模型需要时自己用 `read` 读全文。

**扩展**：一个模块默认导出一个函数，可以注册工具、拦截工具调用（返回字符串就是拒绝的理由，模型会看到它）：

```ts
// ~/.mox/extensions/guard.ts
export default mox => {
  mox.onToolCall((name, args) => name === 'bash' && /\brm\b/.test(args.command) ? '不允许删除文件' : undefined);
  mox.registerTool({
    name: 'now', description: '当前时间', parameters: { type: 'object', properties: {} },
    run: () => new Date().toString(),
  });
};
```

注意上面这种按命令文本拦截的规则挡不住换个写法：测试里 `rm a.txt` 被拦下后，模型会改用 `unlink a.txt`。真正要保护文件，得在操作系统一层做（沙箱）。

## 测试

测试直接调用真实模型，每个机制一条：修 bug、权限拒绝、插话、取消、会话恢复、压缩、项目说明、MCP、子 Agent 与扩展的端到端运行。

```bash
export MOX_BASE_URL=… MOX_API_KEY=… MOX_MODEL=MiniMax-M3.1-Flash
npm test        # 约 50 秒；没设置 MOX_MODEL 时只跑不需要模型的几条
```

## 刻意没做的

为了让每一行都容易读懂，mox 省掉了这些：只支持 OpenAI 兼容接口（不单独适配 Anthropic 原生协议）、工具顺序执行、没有沙箱、没有会话分支、没有 RPC/SDK 模式、请求失败不自动重试。生产级的做法可以对照 [Pi](https://github.com/earendil-works/pi) 的源码，Learn Pi Agent 课程逐章讲了它们。

## 许可

MIT
