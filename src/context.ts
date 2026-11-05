// 系统提示：基本规则 + 项目说明（AGENTS.md / CLAUDE.md）+ Skills 目录。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export type Skill = { name: string; description: string; file: string };

/** 每个 Skill 是一个目录，里面的 SKILL.md 用 frontmatter 写 name 和 description。 */
export function loadSkills(dirs: string[]): Skill[] {
  const skills: Skill[] = [];
  for (const dir of dirs.filter(d => existsSync(d))) {
    for (const entry of readdirSync(dir)) {
      const file = join(dir, entry, 'SKILL.md');
      if (!existsSync(file)) continue;
      const meta = readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '';
      const field = (key: string) => meta.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim();
      skills.push({ name: field('name') ?? entry, description: field('description') ?? '', file });
    }
  }
  return skills;
}

/** 从根目录走到工作目录，每一层的 AGENTS.md（没有就找 CLAUDE.md）都放进来，越近的越靠后。 */
function projectNotes(cwd: string, home: string) {
  const dirs: string[] = [];
  for (let dir = cwd; ; dir = dirname(dir)) {
    dirs.unshift(dir);
    if (dir === dirname(dir)) break;
  }
  const files = [join(home, '.mox', 'AGENTS.md'), ...dirs.map(d => [join(d, 'AGENTS.md'), join(d, 'CLAUDE.md')].find(existsSync) ?? '')];
  return [...new Set(files)].filter(f => f && existsSync(f)).map(f => `<file path="${f}">\n${readFileSync(f, 'utf8').trim()}\n</file>`);
}

export function systemPrompt(cwd: string, home: string, skills: Skill[]) {
  const notes = projectNotes(cwd, home);
  return [
    '你是 mox，一个在终端里工作的编程助手。用工具读代码、改文件、运行命令来完成用户的任务。',
    '- 改文件前先读；小改动用 edit，新文件用 write。\n- 能用命令验证的结果，就运行命令验证。\n- 做完后用几句话说明做了什么。',
    `工作目录：${cwd}\n今天：${new Date().toISOString().slice(0, 10)}`,
    notes.length ? `项目说明，请遵守：\n${notes.join('\n')}` : '',
    skills.length ? `Skills 是可选的操作手册。任务和某个 Skill 相关时，先用 read 读它的 SKILL.md，再照着做：\n${skills.map(s => `- ${s.name}：${s.description}（${s.file}）`).join('\n')}` : '',
  ].filter(Boolean).join('\n\n');
}
