#!/usr/bin/env node
// mox 命令行：把模型、循环、工具、会话、压缩、Skills、MCP、扩展、子 Agent 装在一起。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { compact, estimateTokens } from './compact.ts';
import { loadSkills, systemPrompt } from './context.ts';
import { runLoop, type Event, type LoopOptions, type Tool } from './loop.ts';
import { connectMcp } from './mcp.ts';
import { openai, type Msg } from './model.ts';
import { openSession } from './session.ts';
import { codingTools } from './tools.ts';

const HELP = `用法：mox [-p "任务"] [-c] [--yolo] [--trust]
  -p "任务"   执行一次就退出
  -c          继续这个目录最近一次的会话
  --yolo      执行工具前不再询问
  --trust     加载项目里的 .mox/（扩展、MCP、Skills）和 .agents/skills
环境变量：MOX_MODEL、MOX_API_KEY、MOX_BASE_URL（默认 https://api.openai.com/v1）、MOX_CONTEXT_WINDOW（默认 128000）
交互命令：/compact 压缩上下文，/<skill 名> 使用某个 Skill，/exit 退出`;

const argv = process.argv.slice(2);
const has = (flag: string) => argv.includes(flag);
const env = process.env;
if (has('-h') || has('--help')) { console.log(HELP); process.exit(0); }
if (!env.MOX_MODEL) { console.error(`请先设置 MOX_MODEL、MOX_API_KEY，以及 MOX_BASE_URL（不用 OpenAI 时）。\n\n${HELP}`); process.exit(1); }

const cwd = process.cwd(), home = homedir();
const print = (text: string) => process.stdout.write(text);
const dim = (s: string) => `\x1b[2m${s}\x1b[22m`, red = (s: string) => `\x1b[31m${s}\x1b[39m`, orange = (s: string) => `\x1b[38;5;208m${s}\x1b[39m`;
const oneLine = (s: string, n = 100) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

// ~/.mox 里的配置总是加载；项目里的配置可能是别人写的代码，加了 --trust 才加载
const trust = has('--trust');
const configDirs = [join(home, '.mox'), ...(trust ? [join(cwd, '.mox')] : [])];
const model = openai({ baseUrl: env.MOX_BASE_URL, apiKey: env.MOX_API_KEY, model: env.MOX_MODEL });
const tools: Tool[] = codingTools(cwd);

const mcpFiles = configDirs.map(d => join(d, 'mcp.json')).filter(existsSync);
const mcp = await connectMcp(Object.assign({}, ...mcpFiles.map(f => JSON.parse(readFileSync(f, 'utf8')).mcpServers)), m => console.error(dim(m)));
tools.push(...mcp.tools);

// 扩展：一个模块默认导出一个函数，拿到 api 后可以注册工具、拦截工具调用（返回字符串就是拒绝的理由）
const toolHooks: Array<(name: string, args: any) => unknown> = [];
for (const dir of configDirs.map(d => join(d, 'extensions')).filter(existsSync)) {
  for (const file of readdirSync(dir).filter(f => /\.(ts|js|mjs)$/.test(f)).sort()) {
    const setup = (await import(pathToFileURL(join(dir, file)).href)).default;
    await setup({ cwd, registerTool: (tool: Tool) => tools.push(tool), onToolCall: (hook: (name: string, args: any) => unknown) => toolHooks.push(hook) });
  }
}

const skills = loadSkills([...configDirs.map(d => join(d, 'skills')), join(home, '.agents', 'skills'), ...(trust ? [join(cwd, '.agents', 'skills')] : [])]);
const system = systemPrompt(cwd, home, skills);
const session = openSession(cwd, home, has('-c'));
const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: !!process.stdin.isTTY });

// 权限：只读工具直接执行，其余的先问用户
let answer: ((line: string) => void) | undefined;
const ask = (question: string) => new Promise<string>(resolve => { print(question); answer = resolve; });
const allowed = new Set(['read', 'task']);
async function beforeTool(name: string, args: unknown) {
  for (const hook of toolHooks) { const reason = await hook(name, args); if (reason) return String(reason); }
  if (has('--yolo') || allowed.has(name)) return;
  if (!process.stdin.isTTY) return '没有终端可以确认，已拒绝。想自动执行请加 --yolo';
  const reply = (await ask(`${orange('?')} 允许 ${name} ${dim(oneLine(JSON.stringify(args)))}  [y] 允许  [a] 本次会话都允许  [n] 拒绝 `)).toLowerCase();
  if (reply === 'a') allowed.add(name);
  if (reply !== 'y' && reply !== 'a') return '用户拒绝了这次调用';
}

// 有些模型（比如 MiniMax）把思考过程用 <think> 包在正文里，显示成灰色
let thinking = false;
const show = (indent = '') => (e: Event) => {
  if (e.type === 'text' && !indent) for (const part of e.text.split(/(<\/?think>)/)) {
    if (part === '<think>' || part === '</think>') thinking = part === '<think>';
    else print(thinking ? dim(part) : part);
  }
  if (e.type === 'tool_start') print(`\n${indent}${orange('●')} ${e.call.function.name} ${dim(oneLine(e.call.function.arguments))}\n`);
  if (e.type === 'tool_end') print(`${indent}  ${e.error ? red('✗') : dim('✓')} ${dim(oneLine(e.result))}\n`);
};

// 子 Agent：空白上下文、同样的工具和权限，只把最终回答交回来
tools.push({
  name: 'task',
  description: '把一个独立的子任务交给子 Agent。它从空白上下文开始，用同样的工具干活，只交回最终结论。适合大范围查找和调研，中间过程不会挤占当前对话。',
  parameters: { type: 'object', properties: { prompt: { type: 'string', description: '子任务的完整说明（子 Agent 看不到当前对话）' } }, required: ['prompt'] },
  run: ({ prompt }, signal) => runLoop([{ role: 'user', content: prompt }], { model, system, tools: tools.filter(t => t.name !== 'task'), signal, beforeTool, onEvent: show('    ') }),
});

let controller: AbortController | undefined;
const steering: string[] = [];
const contextWindow = Number(env.MOX_CONTEXT_WINDOW ?? 128_000);
async function maybeCompact(messages: Msg[], force = false) {
  if (!force && estimateTokens(messages) + estimateTokens(system) < contextWindow * 0.8) return;
  const result = await compact(messages, model, contextWindow * 0.2, controller?.signal);
  if (!result) return;
  session.compacted(result.summary, result.keep);
  print(dim(`\n（上下文已压缩：摘要 + 最近 ${result.keep} 条消息）\n`));
}

const options = (signal: AbortSignal): LoopOptions => ({
  model, system, tools, signal, beforeTool,
  steer: () => steering.splice(0),
  compact: messages => maybeCompact(messages),
  onEvent: e => {
    if (e.type === 'message') session.save(e.message);
    if (e.type === 'message' && e.message.role === 'user') print(dim(`\n↳ 插话已送达：${e.message.content}\n`));
    show()(e);
  },
});

async function run(input: string) {
  const skill = skills.find(s => input === `/${s.name}` || input.startsWith(`/${s.name} `));
  const message: Msg = { role: 'user', content: skill ? `${readFileSync(skill.file, 'utf8')}\n\n${input.slice(skill.name.length + 1).trim()}` : input };
  session.messages.push(message);
  session.save(message);
  controller = new AbortController();
  try {
    await runLoop(session.messages, options(controller.signal));
    print('\n');
    return true;
  } catch (e) {
    print(controller.signal.aborted ? dim('\n（已取消）\n') : red(`\n${(e as Error).message}\n`));
    return false;
  } finally {
    controller = undefined;
  }
}

const once = has('-p') ? argv[argv.indexOf('-p') + 1] ?? '' : undefined;
// 不用 process.exit：输出接在管道上时它可能截断还没写完的内容
const exit = (code = 0) => { process.exitCode = code; mcp.close(); rl.close(); };
rl.on('SIGINT', () => (controller ? controller.abort() : exit()));
rl.on('close', () => once === undefined && exit());
rl.on('line', line => {
  const text = line.trim();
  if (answer) { const reply = answer; answer = undefined; return reply(text); }
  if (controller) { if (text) steering.push(text); return; }          // 正在运行：作为插话，下一轮交给模型
  if (once !== undefined) return;
  if (text === '/exit') return exit();
  if (text === '/compact') return void maybeCompact(session.messages, true).catch(e => print(red(`${e.message}\n`))).finally(() => rl.prompt());
  if (!text) return rl.prompt();
  void run(text).then(() => rl.prompt());
});

if (once !== undefined) exit((await run(once)) ? 0 : 1);
else {
  print(`${orange('mox')} ${dim(`· ${env.MOX_MODEL} · ${cwd}`)}\n`);
  print(dim(`${session.messages.length ? `已恢复会话（${session.messages.length} 条消息）` : '新会话'}。运行中输入的话会作为插话送达；Ctrl+C 取消，/exit 退出。\n`));
  rl.setPrompt('› ');
  rl.prompt();
}
