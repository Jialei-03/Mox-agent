// 模型：OpenAI 兼容的 Chat Completions 流式接口。消息格式直接沿用它的格式。
export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type AssistantMsg = { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] };
export type Msg = { role: 'system' | 'user'; content: string } | AssistantMsg | { role: 'tool'; tool_call_id: string; content: string };
export type ToolSpec = { name: string; description: string; parameters: object };
export type Request = { messages: Msg[]; tools?: ToolSpec[]; signal?: AbortSignal; onText?: (text: string) => void };
export type Model = (request: Request) => Promise<{ message: AssistantMsg; finish: string }>;

export function openai({ baseUrl = 'https://api.openai.com/v1', apiKey = '', model = '' }): Model {
  return async ({ messages, tools = [], signal, onText }) => {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, stream: true, ...(tools.length ? { tools: tools.map(f => ({ type: 'function', function: f })) } : {}) }),
    });
    if (!res.ok || !res.body) throw new Error(`模型请求失败（${res.status}）：${(await res.text()).slice(0, 500)}`);

    let text = '', finish = '', buffer = '';
    const calls: ToolCall[] = [];
    const decoder = new TextDecoder();
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop()!;
      for (const line of lines) {
        if (!line.startsWith('data:') || line.includes('[DONE]')) continue;
        const choice = JSON.parse(line.slice(5)).choices?.[0];
        if (!choice) continue;
        if (choice.delta?.content) { text += choice.delta.content; onText?.(choice.delta.content); }
        // 工具调用按 index 分片到达：id 和名字在第一片，参数是一段段 JSON 文本，拼起来才完整
        for (const part of choice.delta?.tool_calls ?? []) {
          const call = calls[part.index ?? 0] ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
          call.id ||= part.id ?? '';
          call.function.name ||= part.function?.name ?? '';
          call.function.arguments += part.function?.arguments ?? '';
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      }
    }
    // 没收到 finish_reason 就结束：连接中途断了，说到一半的话不能当成回答
    if (!finish) throw new Error('模型的响应在完成之前就断开了');
    return { message: { role: 'assistant', content: text || null, ...(calls.length ? { tool_calls: calls } : {}) }, finish };
  };
}
