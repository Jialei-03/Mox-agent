// 每个机制一条测试，用真实模型跑。需要先设置 MOX_MODEL、MOX_API_KEY、MOX_BASE_URL。
// 模型的回答每次都不一样，所以断言只看结果：文件改没改、工具调没调、对话是否合法。
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { compact } from '../src/compact.ts';
import { loadSkills, systemPrompt } from '../src/context.ts';
import { runLoop, type Tool } from '../src/loop.ts';
import { connectMcp } from '../src/mcp.ts';
import { loadExtensions } from '../src/extensions.ts';
import { openai, type Msg } from '../src/model.ts';
import { openSession } from '../src/session.ts';
import { codingTools } from '../src/tools.ts';

const env = process.env;
const skip = env.MOX_MODEL ? false : '没有设置 MOX_MODEL，跳过需要模型的测试';
const model = openai({ baseUrl: env.MOX_BASE_URL, apiKey: env.MOX_API_KEY, model: env.MOX_MODEL });
const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'mox-')));   // macOS 的 /var 实际是 /private/var
const echoServer = join(import.meta.dirname, 'echo-mcp.mjs');
const results = (messages: Msg[]) => messages.filter(m => m.role === 'tool').map(m => m.content as string);
const called = (messages: Msg[]) => messages.flatMap(m => (m.role === 'assistant' ? m.tool_calls ?? [] : [])).map(c => c.function.name);
const agent = (cwd: string, tools: Tool[] = codingTools(cwd)) => ({ model, tools, system: systemPrompt(cwd, tmp(), []) });

test('循环 + 工具：读代码、跑测试、修 bug、再验证', { skip }, async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'calc.py'), 'def add(a, b):\n    return a - b\n');
  writeFileSync(join(dir, 'test_calc.py'), 'from calc import add\nassert add(2, 3) == 5\nprint("ok")\n');
  const messages: Msg[] = [{ role: 'user', content: '运行 python3 test_calc.py，修好失败的测试，再运行一遍确认。不要改测试文件。' }];
  await runLoop(messages, agent(dir));
  assert.equal(execFileSync('python3', ['test_calc.py'], { cwd: dir, encoding: 'utf8' }).trim(), 'ok');
  assert.ok(called(messages).includes('bash') && called(messages).some(n => n === 'edit' || n === 'write'));
  for (const [i, m] of messages.entries()) {   // 每个工具调用后面都紧跟着它的结果
    if (m.role === 'assistant') for (const [k, call] of (m.tool_calls ?? []).entries()) assert.equal((messages[i + 1 + k] as any).tool_call_id, call.id);
  }
});

test('工具：和 Pi 同名同参数的七个工具', async () => {
  const dir = tmp();
  const tool = Object.fromEntries(codingTools(dir).map(t => [t.name, t]));
  assert.deepEqual(Object.keys(tool), ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls']);
  await tool.write.run({ path: 'src/a.ts', content: 'const one = 1;\nconst two = 2;\n' });
  writeFileSync(join(dir, 'big.txt'), Array.from({ length: 2500 }, (_, i) => i + 1).join('\n'));
  assert.match(await tool.read.run({ path: 'big.txt' }), /用 offset=2001 接着读/);
  assert.equal(await tool.edit.run({ path: 'src/a.ts', edits: [{ oldText: 'one = 1', newText: 'one = 10' }, { oldText: 'two = 2', newText: 'two = 20' }] }), '已修改 src/a.ts（2 处）');
  assert.throws(() => tool.edit.run({ path: 'src/a.ts', edits: [{ oldText: 'const', newText: 'let' }] }), /出现了 2 次/);
  assert.equal(await tool.grep.run({ pattern: 'TWO', ignoreCase: true }), 'src/a.ts:2: const two = 20;');
  assert.equal(await tool.find.run({ pattern: '*.ts' }), 'src/a.ts');
  assert.equal(await tool.ls.run({}), 'big.txt\nsrc/');
  await assert.rejects(tool.bash.run({ command: 'seq 1 3000; exit 2' }), /^Error: …（前面省略[\s\S]*\n3000\n\n\[退出码 2\]$/);
  const started = Date.now();   // 超时连同后台子进程一起杀掉，不会被它握着的管道拖住
  await assert.rejects(tool.bash.run({ command: 'sleep 30 & sleep 30', timeout: 0.5 }), /超时 0.5 秒/);
  assert.ok(Date.now() - started < 2000);
});

test('权限：被拒绝的调用变成错误结果交回模型，文件没有被写', { skip }, async () => {
  const dir = tmp();
  const messages: Msg[] = [{ role: 'user', content: '用 write 工具创建 note.txt，内容是 hello。如果失败了，告诉我原因，不要换别的办法。' }];
  await runLoop(messages, { ...agent(dir), beforeTool: name => (name === 'write' || name === 'bash' ? '用户不允许修改文件' : undefined) });
  assert.ok(!existsSync(join(dir, 'note.txt')));
  assert.ok(results(messages).some(r => r.includes('用户不允许修改文件')));
});

test('插话：模型本来要结束了，插进来的话让它再跑一轮', { skip }, async () => {
  const queue = ['再用英文把同一句话说一遍'];
  const messages: Msg[] = [{ role: 'user', content: '用中文说一句问候语，一句话就好，不要用工具。' }];
  const answer = await runLoop(messages, { ...agent(tmp()), steer: () => queue.splice(0) });
  assert.deepEqual(messages.map(m => m.role), ['user', 'assistant', 'user', 'assistant']);
  assert.match(answer, /[a-z]{2,}/i);
});

test('取消：正在跑的命令被杀掉，剩下的调用也有结果，循环抛出', { skip }, async () => {
  const controller = new AbortController();
  const messages: Msg[] = [{ role: 'user', content: '用 bash 运行 sleep 30，然后告诉我结束了。' }];
  const started = Date.now();
  await assert.rejects(runLoop(messages, {
    ...agent(tmp()), signal: controller.signal,
    onEvent: e => e.type === 'tool_start' && setTimeout(() => controller.abort(), 300),
  }));
  assert.ok(Date.now() - started < 25_000);
  assert.match(results(messages).at(-1)!, /已取消|用户取消了/);
});

test('会话：逐条写进 JSONL，-c 恢复；上次中途退出的工具调用补上“中断”', () => {
  const home = tmp();
  const first = openSession('/proj', home);
  const call = (id: string) => ({ id, type: 'function' as const, function: { name: 'bash', arguments: '{}' } });
  const history: Msg[] = [
    { role: 'user', content: '跑测试' },
    { role: 'assistant', content: null, tool_calls: [call('c1'), call('c2')] },
    { role: 'tool', tool_call_id: 'c1', content: '通过' },
  ];
  history.forEach(first.save);
  const resumed = openSession('/proj', home, true);
  assert.equal(resumed.file, first.file);
  assert.deepEqual(resumed.messages.slice(0, 3), history);
  assert.equal((resumed.messages[3] as any).tool_call_id, 'c2');
  assert.match(resumed.messages[3].content as string, /中断/);
  assert.equal(openSession('/proj', home, true).messages.length, 4);
  assert.equal(openSession('/proj', tmp()).messages.length, 0);
  appendFileSync(first.file, '{"type":"mess\n');              // 写到一半的坏行被跳过，会话照样能打开
  assert.equal(openSession('/proj', home, true).messages.length, 4);
});

test('压缩：较早的消息换成模型写的摘要，切点落在用户消息前，重新打开会话结果一样', { skip }, async () => {
  const home = tmp();
  const session = openSession('/proj', home);
  const big = '日志：' + '构建通过。'.repeat(800);
  const history: Msg[] = [
    { role: 'user', content: '把项目代号从“鹦鹉螺”改成“珊瑚”，先改 README' }, { role: 'assistant', content: `README 已改。${big}` },
    { role: 'user', content: '再改 package.json' }, { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read', arguments: '{"path":"package.json"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: big }, { role: 'assistant', content: 'package.json 已改' },
    { role: 'user', content: '最后跑一遍测试' }, { role: 'assistant', content: '测试通过' },
  ];
  for (const m of history) { session.messages.push(m); session.save(m); }
  const result = await compact(session.messages, model, 3000);
  session.compacted(result!.summary, result!.keep);
  assert.equal(result!.keep, 6);
  assert.match(session.messages[0].content as string, /珊瑚/);
  assert.equal(session.messages[1].content, '再改 package.json');
  assert.deepEqual(openSession('/proj', home, true).messages, session.messages);
});

test('系统提示：从根目录到工作目录收集 AGENTS.md / CLAUDE.md，列出 Skills', () => {
  const root = tmp(), cwd = join(root, 'app');
  mkdirSync(join(cwd, '.agents/skills/deploy'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '用中文回答');
  writeFileSync(join(cwd, 'CLAUDE.md'), '测试命令是 npm test');
  writeFileSync(join(cwd, '.agents/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: 发布到生产环境\n---\n步骤……');
  const prompt = systemPrompt(cwd, tmp(), loadSkills([join(cwd, '.agents/skills'), join(cwd, 'missing')]));
  assert.ok(prompt.indexOf('用中文回答') < prompt.indexOf('测试命令是 npm test'));
  assert.match(prompt, /deploy：发布到生产环境/);
});

test('项目说明：模型照着 AGENTS.md 做事', { skip }, async () => {
  const dir = tmp();
  writeFileSync(join(dir, 'AGENTS.md'), '每次回答的最后一行必须是：—— mox');
  const answer = await runLoop([{ role: 'user', content: '1 加 1 等于几？不要用工具。' }], agent(dir));
  assert.match(answer.trim().split('\n').at(-1)!, /—— mox/);
});

test('扩展：注册工具（同名替换）、命令、系统提示片段，事件取第一个非空结果', async () => {
  const tools = codingTools(tmp());
  let mode = 'plan';
  const ext = await loadExtensions([
    mox => {
      mox.registerTool({ name: 'bash', description: '包了一层的 bash', parameters: {}, run: () => 'sandboxed' });
      mox.registerCommand('mode', (args: string) => { mode = args; });
      mox.addSystemPrompt(() => `当前模式：${mode}`);
      mox.on('tool_call', (name: string) => (mode === 'plan' && name === 'write' ? '计划模式下不能写文件' : undefined));
    },
    mox => mox.on('tool_call', (name: string) => (name === 'ls' ? true : '第二个扩展的理由')),
  ], { cwd: '/', tools, ask: async () => undefined });
  assert.equal(tools.length, 7);
  assert.equal(await tools.find(t => t.name === 'bash')!.run({}), 'sandboxed');
  assert.equal(await ext.emit('tool_call', 'write', {}), '计划模式下不能写文件');
  assert.equal(await ext.emit('tool_call', 'read', {}), '第二个扩展的理由');
  assert.equal(await ext.emit('tool_call', 'ls', {}), true);                // true 表示放行，不再问用户
  await ext.commands.get('mode')!('build');
  assert.equal(ext.prompts[0](), '当前模式：build');
  assert.equal(await ext.emit('agent_end', 'done'), undefined);
});

test('MCP：启动服务器、列出工具、调用；起不来的服务器只报警告', async () => {
  const warnings: string[] = [];
  const mcp = await connectMcp({ echo: { command: process.execPath, args: [echoServer] }, broken: { command: 'mox-no-such-command' } }, w => warnings.push(w));
  assert.deepEqual(mcp.tools.map(t => t.name), ['mcp__echo__echo']);
  assert.equal(await mcp.tools[0].run({ text: '你好' }), 'echo: 你好');
  assert.match(warnings[0], /broken/);
  mcp.close();

  const flaky = await connectMcp({ flaky: { command: process.execPath, args: [join(import.meta.dirname, 'flaky-mcp.mjs')] } });
  const [slow, crash] = flaky.tools;
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(slow.run({}, controller.signal), /已取消/);
  await assert.rejects(crash.run({}), /已退出/);
  await assert.rejects(slow.run({}), /已退出/);                // 崩溃之后立刻失败，不会一直等
  flaky.close();
});

test('命令行：子 Agent、扩展拦截、MCP 工具都由模型真实调用；-c 接着上次的会话', { skip }, async () => {
  const home = tmp(), cwd = tmp();
  writeFileSync(join(cwd, 'a.txt'), 'a');
  writeFileSync(join(cwd, 'b.txt'), 'b');
  mkdirSync(join(home, '.mox/extensions'), { recursive: true });
  writeFileSync(join(home, '.mox/extensions/guard.ts'), "export default mox => mox.on('tool_call', (name, args) => name === 'bash' && /\\brm\\b/.test(args.command) ? '扩展禁止删除文件' : undefined);");
  writeFileSync(join(home, '.mox/mcp.json'), JSON.stringify({ mcpServers: { echo: { command: process.execPath, args: [echoServer] } } }));
  const cli = (args: string[]) => new Promise<{ code: number | null; out: string }>(resolve => {
    const child = spawn(process.execPath, [join(import.meta.dirname, '../src/cli.ts'), ...args], { cwd, stdio: ['ignore', 'pipe', 'pipe'], env: { ...env, HOME: home } });
    let out = '';
    child.stdout.on('data', d => (out += d));
    child.stderr.on('data', d => (out += d));
    child.on('close', code => resolve({ code, out }));
  });

  const first = await cli(['--yolo', '-p', '按顺序做三件事：1. 用 task 工具让子 Agent 数一下当前目录有几个 .txt 文件；2. 用 bash 执行 rm a.txt；3. 用 mcp__echo__echo 工具发送“珊瑚”。最后汇报每一步的结果。']);
  assert.equal(first.code, 0, first.out);
  const session = openSession(cwd, home, true).messages;
  assert.ok(called(session).includes('task'), '主 Agent 调用了子 Agent');
  assert.ok(results(session).some(r => r.includes('扩展禁止删除文件')), '扩展拦下了 rm');
  // 不断言 a.txt 还在：按命令文本拦截挡不住换个写法，实测模型会改用 unlink a.txt 删掉它
  assert.ok(results(session).includes('echo: 珊瑚'), 'MCP 工具返回了结果');
  assert.ok(!session.some(m => m.role === 'tool' && m.content.includes('当前目录有几个')), '子 Agent 的过程没有进主会话');

  const second = await cli(['-c', '-p', '刚才用 echo 工具发送的词是什么？只回答那个词，不要用工具。']);
  assert.equal(second.code, 0, second.out);
  assert.match(second.out, /珊瑚/);
});
