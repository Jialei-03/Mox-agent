// 测试用的最小 MCP 服务器：只有一个 echo 工具。
import { createInterface } from 'node:readline';

const reply = (id, result) => process.stdout.write(`${JSON.stringify({ jsonrpc: '2.0', id, result })}\n`);
createInterface({ input: process.stdin }).on('line', line => {
  const { id, method, params } = JSON.parse(line);
  if (method === 'initialize') reply(id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'echo', version: '1' } });
  if (method === 'tools/list') reply(id, { tools: [{ name: 'echo', description: '原样返回文字', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }] });
  if (method === 'tools/call') reply(id, { content: [{ type: 'text', text: `echo: ${params.arguments.text}` }] });
});
