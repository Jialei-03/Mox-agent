// Agent 循环：请求模型 → 执行它要的工具 → 把结果交回去，直到模型不再调用工具。
import type { Model, Msg, ToolCall, ToolSpec } from './model.ts';

export type Tool = ToolSpec & { run: (args: any, signal?: AbortSignal) => Promise<string> | string };
export type Event =
  | { type: 'text'; text: string }
  | { type: 'message'; message: Msg }
  | { type: 'tool_start'; call: ToolCall }
  | { type: 'tool_end'; call: ToolCall; result: string; error: boolean };
export type LoopOptions = {
  model: Model;
  system: string;
  tools: Tool[];
  signal?: AbortSignal;
  onEvent?: (event: Event) => void;
  beforeTool?: (name: string, args: any) => Promise<string | void> | string | void; // 返回字符串表示拒绝，内容是理由
  afterTool?: (name: string, args: any, result: string) => Promise<string | void> | string | void; // 返回字符串就替换结果
  steer?: () => string[];                                                         // 运行中用户插的话
  compact?: (messages: Msg[]) => Promise<void>;                                   // 每次请求前，必要时就地压缩
};

/** 在 messages 上就地追加，返回模型最后的回答。 */
export async function runLoop(messages: Msg[], options: LoopOptions): Promise<string> {
  const emit = options.onEvent ?? (() => {});
  const push = (message: Msg) => { messages.push(message); emit({ type: 'message', message }); };
  const specs = options.tools.map(({ name, description, parameters }) => ({ name, description, parameters }));
  while (true) {
    await options.compact?.(messages);
    const { message, finish } = await options.model({
      messages: [{ role: 'system', content: options.system }, ...messages],
      tools: specs,
      signal: options.signal,
      onText: text => emit({ type: 'text', text }),
    });
    push(message);
    // 每个工具调用都必须有一条结果，失败、拒绝、取消也一样，否则下一次请求不合法
    for (const call of message.tool_calls ?? []) push({ role: 'tool', tool_call_id: call.id, content: await execute(call, finish, options, emit) });
    const steering = options.steer?.() ?? [];
    for (const text of steering) push({ role: 'user', content: text });
    if (!message.tool_calls?.length && !steering.length) return message.content ?? '';
  }
}

async function execute(call: ToolCall, finish: string, options: LoopOptions, emit: (event: Event) => void) {
  emit({ type: 'tool_start', call });
  let result: string, error = true;
  try {
    if (options.signal?.aborted) throw new Error('用户取消了');
    if (finish === 'length') throw new Error('输出被截断，参数可能不完整，请重新调用');
    const tool = options.tools.find(t => t.name === call.function.name);
    if (!tool) throw new Error(`没有名为 ${call.function.name} 的工具`);
    const args = JSON.parse(call.function.arguments || '{}');
    const denied = await options.beforeTool?.(tool.name, args);
    if (denied) throw new Error(denied);
    result = await tool.run(args, options.signal);
    result = (await options.afterTool?.(tool.name, args, result)) || result;
    error = false;
  } catch (e) {
    result = `错误：${(e as Error).message}`;
  }
  emit({ type: 'tool_end', call, result, error });
  return result;
}
