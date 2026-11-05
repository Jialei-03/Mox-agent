// 测试用的 MCP 服务器：slow 永远不回复（测取消），crash 让进程退出（测崩溃之后）。
import { createInterface } from 'node:readline';
const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') reply(id, { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 's', version: '1' } });
  if (method === 'tools/list') reply(id, { tools: [{ name: 'slow' }, { name: 'crash' }] });
  if (method === 'tools/call' && params.name === 'crash') process.exit(1);
});
