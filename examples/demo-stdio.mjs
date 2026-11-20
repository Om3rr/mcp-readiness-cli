#!/usr/bin/env node
// Minimal well-behaved stdio MCP server, used by tests and the README quickstart.
import { createInterface } from 'node:readline';

const tools = [{
  name: 'demo_get_time',
  title: 'Get server time',
  description: 'Returns the current UTC time.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];

createInterface({ input: process.stdin }).on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.id === undefined) return;
  const send = (body) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, ...body }) + '\n');
  if (m.method === 'initialize') {
    return send({ result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo-stdio', version: '1.0.0' } } });
  }
  if (m.method === 'tools/list') return send({ result: { tools } });
  return send({ error: { code: -32601, message: 'Method not found' } });
});
