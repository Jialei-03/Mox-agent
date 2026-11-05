// MCP 客户端：用 stdio 启动服务器，按行收发 JSON-RPC，把它的工具变成 mox 的工具。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { Tool } from './loop.ts';

export type ServerConfig = { command: string; args?: string[]; env?: Record<string, string> };

export async function connectMcp(servers: Record<string, ServerConfig>, warn: (message: string) => void = () => {}) {
  const tools: Tool[] = [];
  const children: Array<{ kill: () => void }> = [];
  for (const [server, { command, args = [], env }] of Object.entries(servers)) {
    const child = spawn(command, args, { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'ignore'] });
    children.push(child);
    const pending = new Map<number, (reply: any) => void>();
    let nextId = 0;
    createInterface({ input: child.stdout }).on('line', line => {
      try { const reply = JSON.parse(line); pending.get(reply.id)?.(reply); pending.delete(reply.id); } catch {}
    });
    let dead = '';                                                  // 服务器退出后，之后的调用立刻失败，不会一直等
    const fail = (message: string) => { dead = message; for (const settle of pending.values()) settle({ error: { message } }); pending.clear(); };
    child.on('error', e => fail(e.message));
    child.stdin.on('error', () => {});
    child.on('exit', () => fail(`MCP 服务器 ${server} 已退出`));
    const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`);
    const request = (method: string, params: object = {}, signal?: AbortSignal) =>
      new Promise<any>((resolve, reject) => {
        if (dead) return reject(new Error(dead));
        const id = ++nextId;
        pending.set(id, reply => (reply.error ? reject(new Error(reply.error.message)) : resolve(reply.result)));
        // 取消：不再等这个结果，并按协议通知服务器
        signal?.addEventListener('abort', () => { pending.delete(id); send({ method: 'notifications/cancelled', params: { requestId: id } }); reject(new Error('已取消')); }, { once: true });
        send({ id, method, params });
      });

    try {
      const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('10 秒内没有响应')), 10_000).unref());
      await Promise.race([request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'mox', version: '0.1.0' } }), timeout]);
      send({ method: 'notifications/initialized' });
      for (const tool of (await request('tools/list')).tools) {
        tools.push({
          name: `mcp__${server}__${tool.name}`.replace(/[^\w-]/g, '_').slice(0, 64),
          description: tool.description ?? '',
          parameters: tool.inputSchema ?? { type: 'object', properties: {} },
          run: async (args, signal) => {
            const result = await request('tools/call', { name: tool.name, arguments: args }, signal);
            const text = result.content.map((c: any) => c.text ?? `[${c.type}]`).join('\n');
            if (result.isError) throw new Error(text);
            return text;
          },
        });
      }
    } catch (e) {
      warn(`MCP 服务器 ${server} 连接失败：${(e as Error).message}`);
      child.kill();
    }
  }
  return { tools, close: () => children.forEach(c => c.kill()) };
}
