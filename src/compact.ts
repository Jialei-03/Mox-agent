// 上下文压缩：把较早的消息交给模型写成摘要，只保留最近的一段原文。
import type { Model, Msg } from './model.ts';

// 粗略估算：英文和代码约 4 个字符一个 token，中文等非 ASCII 字符约 0.7 个 token 一个字
export function estimateTokens(value: unknown) {
  const text = JSON.stringify(value) ?? '';
  const wide = text.match(/[^\x00-\x7f]/g)?.length ?? 0;
  return Math.ceil((text.length - wide) / 4 + wide * 0.7);
}

const PROMPT = '下面是一段编程助手和用户的对话。请写一份摘要，让助手只看摘要就能继续工作：用户的目标、已经做了什么、改过哪些文件、关键结论、还没完成的事。只输出摘要。';

/** 就地压缩 messages，返回摘要和保留的条数；没有可以压缩的内容时返回 undefined。 */
export async function compact(messages: Msg[], model: Model, keepTokens = 20_000, signal?: AbortSignal) {
  // 从后往前找切点：只切在用户消息前面，工具调用和它的结果不会被拆开
  let cut = messages.length;
  for (let i = messages.length - 1; i > 0 && estimateTokens(messages.slice(i)) <= keepTokens; i--) {
    if (messages[i].role === 'user') cut = i;
  }
  if (cut === 0 || messages.length === 0) return undefined;
  const transcript = messages.slice(0, cut).map(m => {
    const calls = m.role === 'assistant' && m.tool_calls ? ` 调用 ${m.tool_calls.map(c => `${c.function.name}(${c.function.arguments})`).join('、')}` : '';
    return `[${m.role}] ${(m.content ?? '').slice(0, 2000)}${calls}`;
  });
  const { message } = await model({ signal, messages: [{ role: 'user', content: `${PROMPT}\n\n<对话>\n${transcript.join('\n')}\n</对话>` }] });
  const summary: Msg = { role: 'user', content: `（更早的对话已经压缩成下面的摘要）\n${message.content}` };
  messages.splice(0, cut, summary);
  return { summary, keep: messages.length - 1 };
}
