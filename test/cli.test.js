import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { parseArgs, HELP } from '../src/cli.js';
import { toText, buildReport, PRO_PITCH } from '../src/format.js';

const root = dirname(fileURLToPath(new URL('.', import.meta.url)));
const bin = join(root, 'bin/mcp-readiness.js');
const demo = join(root, 'examples/demo-stdio.mjs');
const KEY = 'mrc_live_' + 'ab'.repeat(20);

function run(args, { env = {}, timeout = 20000 } = {}) {
  return new Promise((ok, no) => {
    const p = spawn(process.execPath, [bin, ...args], {
      env: { ...process.env, ...env },
      cwd: root,
    });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; });
    const t = setTimeout(() => { p.kill('SIGKILL'); no(new Error(`timeout: ${stderr || stdout}`)); }, timeout);
    p.on('close', (code) => { clearTimeout(t); ok({ code, stdout, stderr }); });
  });
}

test('parseArgs: URL, stdio, flags and errors', () => {
  assert.deepEqual(parseArgs(['https://mcp.example/mcp', '--json', '--fail-under', '80']).url, 'https://mcp.example/mcp');
  assert.equal(parseArgs(['https://mcp.example/mcp', '--json']).json, true);
  assert.equal(parseArgs(['https://mcp.example/mcp', '--fail-under', '80']).failUnder, 80);
  assert.deepEqual(parseArgs(['--stdio', 'npx', '-y', 'foo']).stdio, ['npx', '-y', 'foo']);
  assert.deepEqual(parseArgs(['node', 'server.js']).stdio, ['node', 'server.js']);
  assert.throws(() => parseArgs(['--fail-under', 'nope']), /0 and 100/);
  assert.throws(() => parseArgs(['--unknown']), /unknown option/);
  assert.throws(() => parseArgs(['https://a.example/mcp', 'extra']), /extra arguments/);
  assert.ok(HELP.includes('mcp-readiness-cli'));
  assert.doesNotMatch(HELP, /\$[0-9]/);
});

test('CLI scans the bundled stdio demo and prints score + tokens', async () => {
  const r = await run(['--stdio', 'node', demo]);
  assert.equal(r.code, 0, r.stderr || r.stdout);
  assert.match(r.stdout, /Score: 1\d{2}\/100|Score: 9\d\/100/);
  assert.match(r.stdout, /demo-stdio/);
  assert.match(r.stdout, /Tool descriptions: ~\d+ tokens/);
  assert.match(r.stdout, /Tools: 1/);
});

test('CLI --json and --fail-under work in CI', async () => {
  const ok = await run(['--json', '--fail-under', '80', '--stdio', 'node', demo]);
  assert.equal(ok.code, 0, ok.stderr);
  const j = JSON.parse(ok.stdout);
  assert.ok(j.score >= 80);
  assert.equal(j.toolCount, 1);
  assert.equal(typeof j.tokens.descriptions, 'number');
  assert.equal(j.tools[0].name, 'demo_get_time');
  const fail = await run(['--fail-under', '100', '--stdio', 'node', demo]);
  // A perfect 100 still passes; a score of 100 with --fail-under 100 is not below.
  // Force a fail by asking for 101? parse forbids >100. Use 100 against a server that isn't 100, or 99 if score is lower.
  // The demo may be 95-100 because of missing server instructions (info only, no penalty). Score should be 100.
  if (j.score === 100) {
    const low = await run(['--json']); // usage error
    assert.equal(low.code, 2);
  } else {
    assert.equal(fail.code, 1);
    assert.match(fail.stderr, /fail-under/);
  }
});

test('--fail-under fails when the score is too low', async () => {
  // Spin a sloppy HTTP server so the score is clearly under 90.
  const srv = http.createServer(async (req, res) => {
    let b = ''; for await (const c of req) b += c;
    const m = JSON.parse(b);
    const out = m.method === 'initialize' ? { result: { protocolVersion: '2025-06-18', serverInfo: { name: 'sloppy', version: '1' } } }
      : m.method === 'tools/list' ? { result: { tools: [{ name: 'run_shell', description: 'Runs any shell command on the host machine.', inputSchema: { type: 'object', properties: { cmd: { type: 'string' } } } }] } }
      : m.method === 'notifications/initialized' ? null : { error: { code: -32000, message: 'nope' } };
    res.writeHead(out ? 200 : 202, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(out ? JSON.stringify({ jsonrpc: '2.0', id: m.id, ...out }) : '');
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const url = `http://127.0.0.1:${srv.address().port}/mcp`;
    const r = await run(['--fail-under', '90', '--json', url]);
    assert.equal(r.code, 1, r.stdout + r.stderr);
    const j = JSON.parse(r.stdout);
    assert.ok(j.score < 90, `score ${j.score}`);
    assert.match(r.stderr, /fail-under 90/);
  } finally { srv.close(); }
});

test('--fix without a key prints the Pro pitch and does not write a file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrc-cli-'));
  const out = join(dir, 'tools.slim.json');
  try {
    const r = await run(['--fix', '--out', out, '--stdio', 'node', demo], { env: { MCP_READINESS_LICENSE: '' } });
    assert.equal(r.code, 2, r.stdout + r.stderr);
    assert.match(r.stdout, /MCP Readiness Pro/);
    assert.match(r.stdout, /MCP_READINESS_LICENSE/);
    assert.doesNotMatch(r.stdout, /\$[0-9]/);
    assert.equal(existsSync(out), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('--fix with a valid Pro key writes a slim file; offline API skips the write', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'mrc-cli-'));
  const out = join(dir, 'tools.slim.json');
  const srv = http.createServer((req, res) => {
    const ok = req.headers.authorization === `Bearer ${KEY}`;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { plan: 'pro', status: 'active', remaining: 9, quota: 2000, period: '2026-11' } : { error: 'invalid_license' }));
  });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  const api = `http://127.0.0.1:${srv.address().port}`;
  try {
    const r = await run(['--fix', '--out', out, '--json', '--stdio', 'node', demo], {
      env: { MCP_READINESS_LICENSE: KEY, MCP_READINESS_API_URL: api },
    });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const j = JSON.parse(r.stdout);
    assert.ok(j.fix);
    assert.equal(j.fix.level, 'safe');
    assert.equal(typeof j.fix.saved, 'number');
    const written = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(written.tools[0].name, 'demo_get_time');

    const out2 = join(dir, 'offline.json');
    const offline = await run(['--fix', '--out', out2, '--stdio', 'node', demo], {
      env: { MCP_READINESS_LICENSE: KEY, MCP_READINESS_API_URL: 'http://127.0.0.1:9' },
    });
    assert.equal(offline.code, 0, offline.stderr + offline.stdout);
    assert.match(offline.stderr, /could not reach the licence API|licence API/);
    assert.match(offline.stderr, /--fix was skipped/);
    assert.equal(existsSync(out2), false);
    assert.match(offline.stdout, /Score:/);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('text report and Pro pitch contain no prices', () => {
  const r = buildReport(
    { server: { name: 'x', version: '1' }, score: 90, toolCount: 0, findings: [] },
    { findings: [] },
    'https://example/mcp',
    { tools: [] },
  );
  assert.doesNotMatch(toText(r), /\$[0-9]/);
  assert.doesNotMatch(PRO_PITCH, /\$[0-9]|\/mo/);
});
