import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { checkLicense, verifyFamilyKey, KEY_RE, licenseFromEnv } from '../src/license.js';

const KEY = 'mrc_live_' + 'ab'.repeat(20);
assert.equal(KEY_RE.test(KEY), true);

function apiServer(handler) {
  const srv = http.createServer((req, res) => handler(req, res));
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

test('missing and malformed keys are rejected without a network call', async () => {
  assert.equal((await checkLicense('')).valid, false);
  assert.match((await checkLicense('')).reason, /no licence key/);
  assert.equal((await checkLicense('not-a-key')).valid, false);
  assert.match((await checkLicense('not-a-key')).reason, /mrc_live_/);
  assert.equal((await checkLicense('mrc_live_short')).valid, false);
  assert.equal(licenseFromEnv({ MCP_READINESS_LICENSE: KEY }), KEY);
  assert.equal(licenseFromEnv({}), '');
});

test('family API accepts an active Pro key', async () => {
  const srv = await apiServer((req, res) => {
    const ok = req.url.startsWith('/api/license') && req.headers.authorization === `Bearer ${KEY}`;
    res.writeHead(ok ? 200 : 401, { 'content-type': 'application/json' });
    res.end(JSON.stringify(ok ? { plan: 'pro', status: 'active', remaining: 10, quota: 2000, period: '2026-11' } : { error: 'invalid_license' }));
  });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const good = await verifyFamilyKey(KEY, { apiUrl: url });
    assert.equal(good.valid, true);
    assert.equal(good.plan, 'pro');
    const bad = await verifyFamilyKey('mrc_live_' + 'cd'.repeat(20), { apiUrl: url });
    assert.equal(bad.valid, false);
    assert.equal(bad.reason, 'invalid_license');
    assert.equal(bad.offline, undefined);
  } finally { srv.close(); }
});

test('non-Pro plans and cancelled keys are rejected', async () => {
  const replies = [
    { plan: 'pack', status: 'active' },
    { plan: 'pro', status: 'cancelled' },
  ];
  let i = 0;
  const srv = await apiServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(replies[i++] || replies[0]));
  });
  const url = `http://127.0.0.1:${srv.address().port}`;
  try {
    const pack = await verifyFamilyKey(KEY, { apiUrl: url });
    assert.equal(pack.valid, false);
    assert.match(pack.reason, /does not include the fix step/);
    const cancelled = await verifyFamilyKey(KEY, { apiUrl: url });
    assert.equal(cancelled.valid, false);
    assert.equal(cancelled.reason, 'license_cancelled');
  } finally { srv.close(); }
});

test('unreachable licence API is marked offline', async () => {
  const r = await verifyFamilyKey(KEY, { apiUrl: 'http://127.0.0.1:9' });
  assert.equal(r.valid, false);
  assert.equal(r.offline, true);
  assert.match(r.reason, /could not reach the licence API/);
});

test('HTTP 5xx from the licence API is marked offline', async () => {
  const r = await verifyFamilyKey(KEY, {
    fetchImpl: async () => new Response('nope', { status: 503 }),
  });
  assert.equal(r.valid, false);
  assert.equal(r.offline, true);
  assert.match(r.reason, /HTTP 503/);
});
