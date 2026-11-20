#!/usr/bin/env node
// Minimal well-behaved Streamable HTTP MCP server, used by tests.
import http from 'node:http';
const tools = [{
  name: 'demo_get_time',
  title: 'Get server time',
  description: 'Returns the current UTC time.',
  inputSchema: { type: 'object', properties: {}, required: [] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
}];
const server = http.createServer((req, res) => {
  if (req.headers.origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(req.headers.origin)) {
    res.writeHead(403); return res.end();
  }
  let b = '';
  req.on('data', (c) => (b += c));
  req.on('end', () => {
    let m; try { m = JSON.parse(b); } catch { res.writeHead(400); return res.end(); }
    if (m.id === undefined) { res.writeHead(202); return res.end(); }
    const ok = (result) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, result })); };
    const err = (code, message) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ jsonrpc: '2.0', id: m.id, error: { code, message } })); };
    if (m.method === 'initialize') return ok({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'demo-http', version: '1.0.0' } });
    if (m.method === 'tools/list') return ok({ tools });
    return err(-32601, 'Method not found');
  });
});
const port = Number(process.env.PORT || 8799);
server.listen(port, '127.0.0.1', () => process.stderr.write(`demo-http listening on 127.0.0.1:${port}\n`));
