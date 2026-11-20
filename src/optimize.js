// Deterministic optimizer for tool definitions. Never calls an LLM, never changes names or argument shapes.
// Levels:  safe       semantics-preserving only ($schema, unused $defs, whitespace, redundant titles, empty fields)
//          standard   + filler openers, markdown emphasis, additionalProperties:false (keep validating server-side)
//          aggressive + drop HTTP error listings and code blocks, cap descriptions at N sentences
import { BOILERPLATE } from './rules.js';
import { toolTokens } from './tokens.js';

const LEVELS = { safe: 0, standard: 1, aggressive: 2 };

function cleanText(s, lvl, opts) {
  if (typeof s !== 'string') return s;
  let t = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/[ \t]{2,}/g, ' ').trim();
  if (lvl >= 1) {
    for (const re of BOILERPLATE) if (re.test(t)) { t = t.replace(re, ''); t = t.charAt(0).toUpperCase() + t.slice(1); break; }
    t = t.replace(/\*\*(.+?)\*\*/g, '$1').replace(/__(.+?)__/g, '$1').replace(/^#{1,6}\s+/gm, '');
  }
  if (lvl >= 2) {
    t = t.replace(/```[\s\S]*?```/g, '').replace(/(^|\n)\s*error responses?:?[\s\S]*$/i, '').trim();
    const max = opts.maxSentences ?? 3;
    const sentences = t.replace(/\n+/g, ' ').match(/[^.!?]+[.!?]+(\s|$)|[^.!?]+$/g) ?? [t];
    if (sentences.length > max) t = sentences.slice(0, max).join('').trim();
  }
  return t;
}

function refs(obj) {
  return new Set([...JSON.stringify(obj ?? {}).matchAll(/"\$ref":"#\/(?:\$defs|definitions)\/([^"]+)"/g)].map(m => m[1]));
}

function pruneDefs(schema) {
  for (const key of ['$defs', 'definitions']) {
    const defs = schema[key]; if (!defs) continue;
    const used = refs({ ...schema, $defs: undefined, definitions: undefined });
    let grew = true; while (grew) { grew = false; for (const k of [...used]) for (const r of refs(defs[k])) if (!used.has(r)) { used.add(r); grew = true; } }
    for (const k of Object.keys(defs)) if (!used.has(k)) delete defs[k];
    if (!Object.keys(defs).length) delete schema[key];
  }
}

function walk(node, name, lvl, opts) {
  if (Array.isArray(node)) return node.forEach(n => walk(n, undefined, lvl, opts));
  if (!node || typeof node !== 'object') return;
  delete node.$schema;
  if (typeof node.description === 'string') {
    node.description = cleanText(node.description, lvl, { maxSentences: lvl >= 2 ? 1 : undefined });
    if (!node.description) delete node.description;
  }
  if (name && node.title && node.title.toLowerCase().replace(/[^a-z0-9]/g, '') === name.toLowerCase().replace(/[^a-z0-9]/g, '')) delete node.title;
  if (lvl >= 1 && node.additionalProperties === false) delete node.additionalProperties;
  if (node.properties && typeof node.properties === 'object') for (const [k, v] of Object.entries(node.properties)) walk(v, k, lvl, opts);
  for (const k of ['items', 'anyOf', 'oneOf', 'allOf', 'not', 'additionalProperties']) if (node[k] && typeof node[k] === 'object') walk(node[k], undefined, lvl, opts);
  for (const k of ['$defs', 'definitions']) if (node[k]) for (const [dk, dv] of Object.entries(node[k])) walk(dv, dk, lvl, opts);
}

export function optimizeTools(tools, { level = 'safe', maxSentences = 3 } = {}) {
  const lvl = LEVELS[level];
  if (lvl === undefined) throw new Error(`Unknown level "${level}" (safe|standard|aggressive)`);
  const out = structuredClone(tools).map(t => {
    if (t.description) t.description = cleanText(t.description, lvl, { maxSentences });
    if (t.inputSchema) { pruneDefs(t.inputSchema); walk(t.inputSchema, undefined, lvl, { maxSentences }); }
    return t;
  });
  const before = tools.map(t => toolTokens(t).total);
  const after = out.map(t => toolTokens(t).total);
  const perTool = tools.map((t, i) => ({ name: t.name, before: before[i], after: after[i], saved: before[i] - after[i] }));
  const sum = a => a.reduce((x, y) => x + y, 0);
  return { tools: out, perTool, before: sum(before), after: sum(after), saved: sum(before) - sum(after) };
}
