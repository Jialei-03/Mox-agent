// 七个编程工具，名字和参数与 Pi 的内置工具一致：read、write、edit、bash、grep、find、ls。路径都相对于工作目录。
import { spawn } from 'node:child_process';
import { globSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import type { Tool } from './loop.ts';

// 输出最多 2000 行、50KB。read 留开头（可以用 offset 接着读），bash 留结尾（错误通常在最后）
const MAX_LINES = 2000, MAX_BYTES = 50 * 1024;
function clip(text: string, keep: 'head' | 'tail' = 'head') {
  const lines = text.split('\n');
  let out = (keep === 'head' ? lines.slice(0, MAX_LINES) : lines.slice(-MAX_LINES)).join('\n');
  const bytes = Buffer.from(out);                                   // 按字节算（中文一个字 3 字节），切断的半个字去掉
  if (bytes.length > MAX_BYTES) out = (keep === 'head' ? bytes.subarray(0, MAX_BYTES) : bytes.subarray(-MAX_BYTES)).toString().replace(/^\uFFFD+|\uFFFD+$/g, '');
  if (out === text) return text;
  return keep === 'head' ? `${out}\n…（后面省略了 ${text.length - out.length} 个字符）` : `…（前面省略了 ${text.length - out.length} 个字符）\n${out}`;
}
// grep、find 不进 .git 和 node_modules
const files = (root: string, pattern: string) =>
  globSync(pattern.includes('/') ? pattern : `**/${pattern}`, { cwd: root, exclude: p => /(^|\/)(\.git|node_modules)$/.test(String(p)) })
    .filter(f => statSync(join(root, f)).isFile()).sort();
const object = (properties: Record<string, object>, required: string[]) => ({ type: 'object', properties, required });
const string = (description: string) => ({ type: 'string', description });
const number = (description: string) => ({ type: 'number', description });
const boolean = (description: string) => ({ type: 'boolean', description });

export function codingTools(cwd: string): Tool[] {
  const at = (path = '.') => resolve(cwd, path);
  return [
    {
      name: 'read',
      description: '读取文本文件。输出最多 2000 行或 50KB，大文件用 offset 和 limit 分段读，直到读完。',
      parameters: object({ path: string('文件路径'), offset: number('从第几行开始（从 1 数）'), limit: number('最多读几行') }, ['path']),
      run: ({ path, offset = 1, limit }) => {
        const lines = readFileSync(at(path), 'utf8').split('\n');
        if (offset > lines.length) throw new Error(`offset ${offset} 超出了文件长度（${lines.length} 行）`);
        const wanted = lines.slice(offset - 1, limit ? offset - 1 + limit : undefined).slice(0, MAX_LINES);
        let count = 0;                                                  // 在 50KB 以内能放下几行
        for (let size = 0; count < wanted.length && (size += Buffer.byteLength(wanted[count]) + 1) <= MAX_BYTES; count++);
        count = Math.max(count, 1);
        const text = wanted.slice(0, count).join('\n');
        const next = offset + count;
        return next <= lines.length ? `${text}\n\n[显示了第 ${offset}–${next - 1} 行，共 ${lines.length} 行；用 offset=${next} 接着读]` : text;
      },
    },
    {
      name: 'write',
      description: '写文件：不存在就创建，存在就整个覆盖，自动创建上级目录。',
      parameters: object({ path: string('文件路径'), content: string('文件的完整内容') }, ['path', 'content']),
      run: ({ path, content }) => {
        mkdirSync(dirname(at(path)), { recursive: true });
        writeFileSync(at(path), content);
        return `已写入 ${path}`;
      },
    },
    {
      name: 'edit',
      description: '用精确文本替换修改一个文件。每个 edits[].oldText 必须和原文逐字一致、在文件里只出现一次，且互不重叠；挨得近的改动合成一处。',
      parameters: object({
        path: string('文件路径'),
        edits: { type: 'array', description: '一处或多处替换，都按原文件匹配', items: object({ oldText: string('要替换的原文，必须唯一'), newText: string('替换后的内容') }, ['oldText', 'newText']) },
      }, ['path', 'edits']),
      run: ({ path, edits, oldText, newText }) => {
        const text = readFileSync(at(path), 'utf8');
        const spans = (edits ?? [{ oldText, newText }]).map((e: { oldText: string; newText: string }) => {
          const count = e.oldText ? text.split(e.oldText).length - 1 : 0;
          if (count !== 1) throw new Error(`${count ? `oldText 出现了 ${count} 次，请带上更多上下文让它唯一` : 'oldText 在文件里找不到，先 read 再改'}：${e.oldText?.slice(0, 80)}`);
          const start = text.indexOf(e.oldText);
          return { start, end: start + e.oldText.length, newText: e.newText };
        }).sort((a: { start: number }, b: { start: number }) => a.start - b.start);
        let out = '', pos = 0;
        for (const span of spans) {
          if (span.start < pos) throw new Error('有两处 edits 重叠了，请合并成一处');
          out += text.slice(pos, span.start) + span.newText;
          pos = span.end;
        }
        writeFileSync(at(path), out + text.slice(pos));
        return `已修改 ${path}（${spans.length} 处）`;
      },
    },
    {
      name: 'bash',
      description: '在工作目录执行 shell 命令，返回输出（stdout 和 stderr 合在一起）和退出码，退出码不是 0 时作为错误返回。输出太长时保留最后 2000 行或 50KB。',
      parameters: object({ command: string('要执行的命令'), timeout: number('超时秒数（可选，默认不限）') }, ['command']),
      // 命令单独成一个进程组：超时或取消时连同它启动的子进程一起杀掉。非零退出码作为错误交给模型
      run: ({ command, timeout }, signal) =>
        new Promise((done, fail) => {
          const child = spawn('bash', ['-c', command], { cwd, detached: true });
          let output = '', stopped = '';
          const kill = (why: string) => { stopped = why; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} };
          const timer = timeout ? setTimeout(() => kill(`超时 ${timeout} 秒，已终止`), timeout * 1000) : undefined;
          const abort = () => kill('已取消');
          signal?.addEventListener('abort', abort, { once: true });
          child.stdout.on('data', d => (output += d));
          child.stderr.on('data', d => (output += d));
          child.on('error', e => fail(e));
          // 等 exit 而不是 close：命令放到后台的进程可能一直握着输出管道
          child.on('exit', code => setTimeout(() => {
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            const text = clip(`${output}\n[${stopped || `退出码 ${code}`}]`, 'tail');
            if (code === 0 && !stopped) done(text);
            else fail(new Error(text));
          }, 50));
        }),
    },
    {
      name: 'grep',
      description: '在文件内容里搜索，返回“路径:行号: 内容”。默认最多 100 处匹配，不搜索 .git 和 node_modules。',
      parameters: object({
        pattern: string('正则表达式，literal 为 true 时按普通文本匹配'),
        path: string('要搜索的目录或文件，默认工作目录'),
        glob: string("只搜索匹配的文件，比如 '*.ts' 或 'src/**/*.spec.ts'"),
        ignoreCase: boolean('不区分大小写，默认 false'),
        literal: boolean('把 pattern 当普通文本，默认 false'),
        context: number('每处匹配前后各显示几行，默认 0'),
        limit: number('最多返回几处匹配，默认 100'),
      }, ['pattern']),
      run: ({ pattern, path, glob = '*', ignoreCase = false, literal = false, context = 0, limit = 100 }) => {
        const regex = new RegExp(literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern, ignoreCase ? 'i' : '');
        const root = at(path);
        const targets = statSync(root).isFile() ? [root] : files(root, glob).map(f => join(root, f));
        const out: string[] = [];
        let matches = 0;
        for (const file of targets) {
          const text = readFileSync(file, 'utf8');
          if (text.includes('\0')) continue;                           // 跳过二进制文件
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && matches < limit; i++) {
            if (!regex.test(lines[i])) continue;
            matches++;
            for (let j = Math.max(0, i - context); j <= Math.min(lines.length - 1, i + context); j++) {
              out.push(`${relative(cwd, file)}:${j + 1}${j === i ? ':' : '-'} ${lines[j].slice(0, 500)}`);
            }
          }
        }
        return out.length ? clip(out.join('\n')) + (matches >= limit ? `\n[已达到 ${limit} 处的上限]` : '') : '没有匹配';
      },
    },
    {
      name: 'find',
      description: "按 glob 模式查找文件，返回相对于搜索目录的路径。默认最多 1000 个，不进 .git 和 node_modules。",
      parameters: object({ pattern: string("glob 模式，比如 '*.ts'、'**/*.json'、'src/**/*.spec.ts'"), path: string('在哪个目录下找，默认工作目录'), limit: number('最多返回几个，默认 1000') }, ['pattern']),
      run: ({ pattern, path, limit = 1000 }) => {
        const found = files(at(path), pattern);
        return found.length ? clip(found.slice(0, limit).join('\n')) + (found.length > limit ? `\n[共 ${found.length} 个，只显示前 ${limit} 个]` : '') : '没有找到';
      },
    },
    {
      name: 'ls',
      description: '列出目录内容，按字母排序，目录名后面带 /，包括以点开头的文件。默认最多 500 项。',
      parameters: object({ path: string('要列出的目录，默认工作目录'), limit: number('最多返回几项，默认 500') }, []),
      run: ({ path, limit = 500 }) => {
        const entries = readdirSync(at(path), { withFileTypes: true }).map(e => (e.isDirectory() ? `${e.name}/` : e.name)).sort();
        return entries.length ? entries.slice(0, limit).join('\n') + (entries.length > limit ? `\n[共 ${entries.length} 项，只显示前 ${limit} 项]` : '') : '（空目录）';
      },
    },
  ];
}
