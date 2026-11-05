// 会话：一个 JSONL 文件，一行一条记录。消息一产生就追加，进程随时被杀也不丢已经发生的事。
import { appendFileSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Msg } from './model.ts';

export type Session = {
  file: string;
  messages: Msg[];
  save: (message: Msg) => void;
  compacted: (summary: Msg, keep: number) => void; // 压缩：摘要替换掉除最近 keep 条以外的全部消息
};

/** resume 为 true 时打开这个目录最近的会话，否则新建一个。 */
export function openSession(cwd: string, home: string, resume = false): Session {
  const dir = join(home, '.mox', 'sessions', cwd.replace(/[\\/:]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const latest = resume ? readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().at(-1) : undefined;
  const file = join(dir, latest ?? `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
  const write = (record: object) => appendFileSync(file, `${JSON.stringify(record)}\n`);
  const messages: Msg[] = [];
  for (const line of latest ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []) {
    const record = JSON.parse(line);
    if (record.type === 'compact') messages.splice(0, messages.length - record.keep, record.summary);
    else messages.push(record.message);
  }
  const session: Session = {
    file,
    messages,
    save: message => write({ type: 'message', message }),
    compacted: (summary, keep) => write({ type: 'compact', summary, keep }),
  };

  // 上次在工具执行到一半时退出：给没有结果的调用补上“中断”，对话才能接着发给模型
  const last = messages.findLastIndex(m => m.role === 'assistant');
  const answered = new Set(messages.slice(last + 1).map(m => (m.role === 'tool' ? m.tool_call_id : '')));
  for (const call of last === -1 ? [] : (messages[last] as Extract<Msg, { role: 'assistant' }>).tool_calls ?? []) {
    if (answered.has(call.id)) continue;
    const result: Msg = { role: 'tool', tool_call_id: call.id, content: '中断：上次运行在这个工具执行时退出，结果未知，需要的话请检查后重试。' };
    messages.push(result);
    session.save(result);
  }
  return session;
}
