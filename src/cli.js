import { writeFileSync } from 'node:fs';
import { probeHttp, withTools } from './probe.js';
import { probeStdio } from './stdio.js';
import { lintTools } from './rules.js';
import { optimizeTools } from './optimize.js';
import { checkLicense, licenseFromEnv } from './license.js';
import { buildReport, toText, PRO_PITCH, OFFLINE_FIX } from './format.js';

export const VERSION = '0.1.0';

export const HELP = `mcp-readiness ${VERSION} — scan an MCP server for production readiness.

Usage:
  mcp-readiness <url>
  mcp-readiness --stdio <cmd> [args...]
  mcp-readiness <cmd> [args...]           # local stdio server (when the first arg is not a URL)

Free:
  --json              machine-readable report (score, tokens, findings, tools)
  --fail-under N      exit 1 if the score is below N (for CI)
  --token T           bearer token for authenticated servers (or MCP_TOKEN)
  --timeout MS        HTTP / stdio timeout in milliseconds (default 15000)

Pro (requires MCP_READINESS_LICENSE, an mrc_live_ key):
  --fix               apply the lossless tool-description slim and print savings
  --out FILE          write the slimmed tools list (requires --fix)
  --license KEY       Pro key (otherwise MCP_READINESS_LICENSE)

The package name on npm is mcp-readiness-cli (the name "mcp-readiness" is already taken).
After publish: npx mcp-readiness-cli <url>
`;

export function parseArgs(argv) {
  const o = { failUnder: null, json: false, fix: false, headers: {} };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined || String(v).startsWith('--')) throw new Error(`missing value for ${a}`);
      return v;
    };
    if (a === '--stdio') { o.stdio = argv.slice(i + 1); if (!o.stdio.length) throw new Error('--stdio requires a command'); break; }
    else if (a === '--json') o.json = true;
    else if (a === '--fix') o.fix = true;
    else if (a === '--fail-under') {
      const n = Number(next());
      if (!Number.isFinite(n) || n < 0 || n > 100) throw new Error('--fail-under must be a number between 0 and 100');
      o.failUnder = n;
    } else if (a === '--out' || a === '--fix-out') o.out = next();
    else if (a === '--token') o.token = next();
    else if (a === '--license') o.license = next();
    else if (a === '--timeout') {
      const n = Number(next());
      if (!Number.isFinite(n) || n <= 0) throw new Error('--timeout must be a positive number of milliseconds');
      o.timeoutMs = n;
    } else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-V' || a === '--version') o.version = true;
    else if (a.startsWith('-')) throw new Error(`unknown option: ${a}`);
    else rest.push(a);
  }
  if (!o.stdio) {
    if (rest[0] && /^https?:\/\//i.test(rest[0])) {
      if (rest.length > 1) throw new Error('unexpected extra arguments after the URL (use --stdio for a local command)');
      o.url = rest[0];
    } else if (rest.length) o.stdio = rest;
  }
  return o;
}

const withTimeout = (p, ms) => Promise.race([
  p,
  new Promise((_, no) => setTimeout(() => no(new Error(`timeout after ${ms / 1000}s`)), ms).unref()),
]);

export async function run(argv, deps = {}) {
  const env = deps.env ?? process.env;
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s + (s.endsWith('\n') ? '' : '\n')));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s + (s.endsWith('\n') ? '' : '\n')));
  const writeFile = deps.writeFileSync ?? writeFileSync;
  const probeH = deps.probeHttp ?? probeHttp;
  const probeS = deps.probeStdio ?? probeStdio;
  const checkLic = deps.checkLicense ?? checkLicense;

  let o;
  try { o = parseArgs(argv); } catch (e) { stderr(e.message); stderr(HELP); return 2; }
  if (o.help) { stdout(HELP); return 0; }
  if (o.version) { stdout(VERSION); return 0; }
  if (!o.url && !o.stdio) { stderr('usage: mcp-readiness <url> | --stdio <cmd...>'); stderr(HELP); return 2; }
  if (o.out && !o.fix) { stderr('--out requires --fix'); return 2; }

  const token = o.token ?? env.MCP_TOKEN;
  const timeoutMs = o.timeoutMs ?? 15000;
  const target = o.url || o.stdio.join(' ');

  let scan;
  try {
    if (o.url) scan = await withTimeout(probeH(o.url, { token, timeoutMs, fetchImpl: deps.fetchImpl }), timeoutMs + 5000);
    else scan = await withTimeout(probeS(o.stdio[0], o.stdio.slice(1)), timeoutMs + 5000);
  } catch (e) {
    stderr(`scan failed: ${e.message || e}`);
    return 2;
  }

  const tools = scan.tools || [];
  const lint = tools.length ? lintTools(tools) : { findings: [], total: 0 };
  const report = buildReport(scan, lint, target, { tools });

  let fixResult = null;
  if (o.fix) {
    const lic = await checkLic(o.license || licenseFromEnv(env), { fetchImpl: deps.fetchImpl, apiUrl: env.MCP_READINESS_API_URL });
    if (lic.valid) {
      fixResult = optimizeTools(tools, { level: 'safe' });
      report.fix = { level: 'safe', before: fixResult.before, after: fixResult.after, saved: fixResult.saved, perTool: fixResult.perTool.filter((t) => t.saved > 0) };
      if (o.out) writeFile(o.out, JSON.stringify({ tools: fixResult.tools }, null, 2));
    } else if (lic.offline) {
      stderr(`${OFFLINE_FIX} (${lic.reason})`);
    } else {
      if (!o.json) stdout(toText(report) + '\n\n' + PRO_PITCH + (lic.reason ? `\n(${lic.reason})` : ''));
      else stdout(JSON.stringify({ ...report, pro: { ok: false, reason: lic.reason, pitch: PRO_PITCH } }, null, 2));
      return 2;
    }
  }

  if (o.json) {
    const full = withTools({ ...scan, ...report }, target);
    if (report.fix) full.fix = report.fix;
    if (o.out && fixResult) full.wrote = o.out;
    stdout(JSON.stringify(full, null, 2));
  } else {
    let text = toText(report);
    if (report.fix) {
      text += `\n\nPro fix (lossless): ${report.fix.before.toLocaleString('en-US')} → ${report.fix.after.toLocaleString('en-US')} tokens (−${report.fix.saved})`;
      if (o.out) text += `\nWrote ${o.out}`;
      else text += '\nPass --out tools.slim.json to write the slimmed tools list.';
    }
    stdout(text);
  }

  if (o.failUnder != null && (report.score == null || report.score < o.failUnder)) {
    stderr(`score ${report.score ?? 'n/a'} is below --fail-under ${o.failUnder}`);
    return 1;
  }
  return 0;
}
