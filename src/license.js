// Pro licence check for --fix.
// Accepts MCP Readiness family keys "mrc_live_…" / "mrc_test_…" and validates them
// against the scanner worker: GET {MCP_READINESS_API_URL}/api/license
// with Authorization: Bearer <key>.
// If the API cannot be reached, the result is marked offline so the CLI can
// skip --fix with a clear warning instead of failing the free scan.
export const FAMILY_API = 'https://mcp-readiness.example.workers.dev'; // replace with the live scanner API at launch
export const PRO_PLANS = new Set(['pro', 'team', 'org']);
export const KEY_RE = /^mrc_(live|test)_[0-9a-f]{40}$/;

export function licenseFromEnv(env = process.env) {
  return env.MCP_READINESS_LICENSE || '';
}

export async function verifyFamilyKey(key, { fetchImpl = fetch, apiUrl = process.env.MCP_READINESS_API_URL || FAMILY_API } = {}) {
  try {
    const r = await fetchImpl(`${String(apiUrl).replace(/\/$/, '')}/api/license`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(8000),
    });
    const j = await r.json().catch(() => ({}));
    if (r.status === 401 || j.error) return { valid: false, reason: j.error || 'invalid_license' };
    if (!r.ok) return { valid: false, offline: true, reason: `licence API HTTP ${r.status}` };
    if (j.status !== 'active') return { valid: false, reason: `license_${j.status || 'unknown'}` };
    if (!PRO_PLANS.has(j.plan)) return { valid: false, reason: `plan "${j.plan}" does not include the fix step (needs Pro)` };
    return { valid: true, plan: j.plan, payload: j };
  } catch (e) {
    return { valid: false, offline: true, reason: `could not reach the licence API (${e.message})` };
  }
}

export async function checkLicense(key = licenseFromEnv(), deps = {}) {
  if (!key) return { valid: false, reason: 'no licence key (set MCP_READINESS_LICENSE to your mrc_live_ key)' };
  if (!KEY_RE.test(key)) return { valid: false, reason: 'key must be an mrc_live_ or mrc_test_ family key' };
  return verifyFamilyKey(key, deps);
}
