// 扩展：一个模块默认导出一个函数，拿到 api 后注册工具、命令、系统提示片段和事件处理器。
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { Tool } from './loop.ts';

type Handler = (...args: any[]) => unknown;
export type ExtensionApi = {
  cwd: string;
  registerTool: (tool: Tool) => void;                                   // 和已有工具同名时替换它
  registerCommand: (name: string, run: (args: string) => unknown) => void;
  addSystemPrompt: (part: () => string) => void;                        // 每次运行前重新取值
  ask: (question: string, choices: string[]) => Promise<string | undefined>;
  // tool_call(name, args)：返回字符串就拒绝这次调用（字符串是给模型看的理由），返回 true 就放行、不再问用户。
  //   每个扩展都会被问到，拒绝优先：只要有一个拒绝就拒绝，安全不取决于加载顺序
  // tool_result(name, args, result)：返回字符串就替换工具结果；多个扩展依次接力，后一个拿到前一个改过的结果
  // agent_end(answer)：返回字符串就把它当作新的用户消息，让 Agent 接着干
  on: (event: 'tool_call' | 'tool_result' | 'agent_end' | 'shutdown', handler: Handler) => void;
};
export type Extension = (api: ExtensionApi) => unknown;

/** 目录里的 .ts / .js / .mjs 文件，按文件名排序。 */
export const extensionFiles = (dirs: string[]) =>
  dirs.filter(d => existsSync(d)).flatMap(d => readdirSync(d).filter(f => /\.(ts|js|mjs)$/.test(f)).sort().map(f => join(d, f)));

export async function loadExtensions(sources: Array<string | Extension>, host: { cwd: string; tools: Tool[]; ask: ExtensionApi['ask'] }) {
  const handlers: Record<string, Handler[]> = {};
  const commands = new Map<string, (args: string) => unknown>();
  const prompts: Array<() => string> = [];
  const api: ExtensionApi = {
    cwd: host.cwd,
    ask: host.ask,
    registerTool: tool => {
      const i = host.tools.findIndex(t => t.name === tool.name);
      if (i === -1) host.tools.push(tool);
      else host.tools[i] = tool;
    },
    registerCommand: (name, run) => commands.set(name, run),
    addSystemPrompt: part => prompts.push(part),
    on: (event, handler) => (handlers[event] ??= []).push(handler),
  };
  for (const source of sources) await (typeof source === 'function' ? source : (await import(pathToFileURL(resolve(source)).href)).default)(api);
  /** 按加载顺序调用处理器，第一个给出结论（非空返回值）的说了算。 */
  const emit = async (event: string, ...args: unknown[]): Promise<unknown> => {
    for (const handler of handlers[event] ?? []) {
      const result = await handler(...args);
      if (result) return result;
    }
  };
  const text = (value: unknown) => (typeof value === 'string' ? value : undefined);
  /** 工具调用要过所有扩展：有一个拒绝就拒绝（返回理由），否则有一个放行就放行（返回 true）。 */
  const verdict = async (name: string, args: unknown): Promise<string | true | undefined> => {
    let allowed = false;
    for (const handler of handlers.tool_call ?? []) {
      const result = await handler(name, args);
      if (typeof result === 'string' && result) return result;
      if (result === true) allowed = true;
    }
    return allowed || undefined;
  };
  /** 工具结果依次经过每个扩展：谁都可以改，后一个拿到前一个改过的结果（比如一个加注释、一个遮掉密钥）。 */
  const transform = async (name: string, args: unknown, result: string) => {
    for (const handler of handlers.tool_result ?? []) {
      const next = await handler(name, args, result);
      if (typeof next === 'string') result = next;
    }
    return result;
  };
  return { commands, prompts, emit, text, verdict, transform };
}
