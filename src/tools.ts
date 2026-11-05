// 四个编程工具：read、write、edit、bash。路径都相对于工作目录。
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { Tool } from './loop.ts';

const LIMIT = 30_000;
const clip = (s: string) => (s.length > LIMIT ? `${s.slice(0, LIMIT / 2)}\n…（中间省略 ${s.length - LIMIT} 个字符）…\n${s.slice(-LIMIT / 2)}` : s);
const object = (properties: Record<string, object>, required = Object.keys(properties)) => ({ type: 'object', properties, required });
const string = (description: string) => ({ type: 'string', description });
const number = (description: string) => ({ type: 'number', description });

export function codingTools(cwd: string): Tool[] {
  const at = (path: string) => resolve(cwd, path);
  return [
    {
      name: 'read',
      description: '读取文本文件，每行带行号。大文件用 offset 和 limit 分段读。',
      parameters: object({ path: string('文件路径'), offset: number('从第几行开始，默认 1'), limit: number('最多读几行，默认 2000') }, ['path']),
      run: ({ path, offset = 1, limit = 2000 }) =>
        clip(readFileSync(at(path), 'utf8').split('\n').slice(offset - 1, offset - 1 + limit).map((line, i) => `${offset + i}\t${line}`).join('\n')),
    },
    {
      name: 'write',
      description: '创建文件或整个覆盖文件。',
      parameters: object({ path: string('文件路径'), content: string('文件的完整内容') }),
      run: ({ path, content }) => {
        mkdirSync(dirname(at(path)), { recursive: true });
        writeFileSync(at(path), content);
        return `已写入 ${path}`;
      },
    },
    {
      name: 'edit',
      description: '把文件里的 old 替换成 new。old 必须和原文逐字一致，并且在文件里只出现一次。',
      parameters: object({ path: string('文件路径'), old: string('要替换的原文'), new: string('替换后的内容') }),
      run: ({ path, old, new: next }) => {
        const text = readFileSync(at(path), 'utf8');
        const count = text.split(old).length - 1;
        if (count !== 1) throw new Error(count ? `old 出现了 ${count} 次，请带上更多上下文让它唯一` : 'old 在文件里找不到，先 read 再改');
        writeFileSync(at(path), text.replace(old, () => next));
        return `已修改 ${path}`;
      },
    },
    {
      name: 'bash',
      description: '在工作目录执行 shell 命令，返回输出和退出码。',
      parameters: object({ command: string('要执行的命令'), timeout: number('超时秒数，默认 120') }, ['command']),
      run: ({ command, timeout = 120 }, signal) =>
        new Promise((done, fail) => {
          const child = spawn('bash', ['-c', command], { cwd, signal, timeout: timeout * 1000 });
          let output = '';
          child.stdout.on('data', d => (output += d));
          child.stderr.on('data', d => (output += d));
          child.on('close', (code, killedBy) => done(clip(`${output}\n[${code === null ? `被 ${killedBy} 终止（超时 ${timeout} 秒？）` : `退出码 ${code}`}]`)));
          child.on('error', e => fail(new Error(clip(`${output}\n[${e.name === 'AbortError' ? '已取消' : e.message}]`))));
        }),
    },
  ];
}
