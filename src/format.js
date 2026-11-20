import { toolTokens } from './tokens.js';

const ICON = { fail: '❌', error: '❌', warn: '⚠️', info: 'ℹ️', pass: '✅' };
const ORDER = { fail: 0, error: 0, warn: 1, info: 2, pass: 3 };

export function tokenBreakdown(tools = []) {
  const perTool = tools.map((t) => ({ name: t.name, ...toolTokens(t) })).sort((a, b) => b.description - a.description || b.total - a.total);
  const descriptions = perTool.reduce((s, t) => s + t.description, 0);
  const schemas = perTool.reduce((s, t) => s + t.schema, 0);
  const total = perTool.reduce((s, t) => s + t.total, 0);
  return { descriptions, schemas, total, perTool };
}

export function topFixes(scanFindings = [], lintFindings = [], { limit = 12 } = {}) {
  const fromScan = scanFindings
    .filter((f) => f.level === 'fail' || f.level === 'warn')
    .map((f) => ({ source: 'scan', level: f.level, id: f.id, title: f.title, detail: f.detail || '', fix: f.fix || '' }));
  const fromLint = lintFindings
    .filter((f) => f.level === 'error' || f.level === 'warn')
    .map((f) => ({
      source: 'tokens',
      level: f.level === 'error' ? 'fail' : f.level,
      id: f.rule,
      title: `${f.tool}: ${f.message}`,
      detail: f.savings ? `≈${f.savings} tokens` : '',
      fix: f.fix || '',
    }));
  return [...fromScan, ...fromLint].sort((a, b) => ORDER[a.level] - ORDER[b.level] || (b.detail ? 1 : 0) - (a.detail ? 1 : 0)).slice(0, limit);
}

export function buildReport(scan, lint, target, { tools } = {}) {
  const list = tools ?? scan.tools ?? [];
  const tokens = tokenBreakdown(list);
  const fixes = topFixes(scan.findings || [], lint.findings || []);
  return {
    target,
    server: scan.server,
    protocolVersion: scan.protocolVersion,
    authRequired: Boolean(scan.authRequired),
    oauth: scan.oauth,
    score: scan.score,
    toolCount: scan.toolCount,
    tokens,
    findings: scan.findings || [],
    lint: lint.findings || [],
    fixes,
    ...(list.length ? { tools: list } : {}),
  };
}

const fmt = (n) => Number(n || 0).toLocaleString('en-US');

export function toText(r) {
  const name = r.server?.name || r.target || 'MCP server';
  const ver = r.server?.version ? ` ${r.server.version}` : '';
  const L = [`MCP Readiness: ${name}${ver}`, `Target: ${r.target}`];
  L.push(`Score: ${r.score}/100`);
  if (r.authRequired) {
    L.push('Tools not scanned (this server requires a token). Re-run with --token after authenticating.');
  } else {
    L.push(`Tools: ${r.toolCount ?? 0}  ·  Tool descriptions: ~${fmt(r.tokens.descriptions)} tokens  (list payload ~${fmt(r.tokens.total)} tokens)`);
  }
  if (r.fixes?.length) {
    L.push('', 'Top fixes:');
    for (const f of r.fixes) L.push(`  ${ICON[f.level] || '•'}  ${f.title}${f.detail ? ` — ${f.detail}` : ''}${f.fix ? `\n      Fix: ${f.fix}` : ''}`);
  } else if (!r.authRequired) {
    L.push('', 'Top fixes: none. This tool list looks clean.');
  }
  if (r.tokens?.perTool?.length) {
    L.push('', 'Heaviest tool descriptions:');
    for (const t of r.tokens.perTool.slice(0, 8)) L.push(`  ${String(t.description).padStart(6)}  ${t.name}  (schema ${t.schema}, total ${t.total})`);
  }
  return L.join('\n');
}

export const PRO_PITCH = `--fix is part of MCP Readiness Pro.
This free scan still reports the score, token cost, and top fixes.
Get Pro: set MCP_READINESS_LICENSE to your mrc_live_ key and re-run with --fix.`;

export const OFFLINE_FIX = 'Could not reach the MCP Readiness licence API, so --fix was skipped. The free scan completed. Retry when you are online, or set MCP_READINESS_API_URL if you use a private API host.';
