// Lint rules for MCP tool definitions. Each finding: { rule, level: 'error'|'warn'|'info', tool, message, fix, savings? }
import { estimateTokens, toolTokens } from './tokens.js';

export const DEFAULTS = {
  maxDescTokens: 300,       // per tool description
  maxToolTokens: 800,       // per tool incl. schema
  maxTotalTokens: 10000,    // whole tool list
  maxTools: 40,
  maxEnum: 30,
  maxParamDescChars: 300,
};

export const BOILERPLATE = [
  /^\s*(this|the) tool (allows|lets|enables) (you|the (user|model|assistant|agent)) to\s+/i,
  /^\s*(this|the) tool (is used to|can be used to|will|is a tool that|is for)\s+/i,
  /^\s*use this tool (to|when you want to|in order to)\s+/i,
  /^\s*(a|an) tool (that|which|to)\s+/i,
  /^\s*tool (that|which|to|for)\s+/i,
];

const INJECTION = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /<\s*(important|system|secret)\s*>/i,
  /do not (tell|inform|mention (this )?to) the user/i,
  /\b(\.ssh|id_rsa|\.env\b|mcp\.json)\b/i,
  /[\u200B-\u200F\u202A-\u202E\u2066-\u2069]/,
];

const SHORT_OK = 20;

function walkProps(schema, path, out) {
  if (!schema || typeof schema !== 'object') return out;
  for (const [k, v] of Object.entries(schema.properties ?? {})) {
    out.push({ path: path ? `${path}.${k}` : k, name: k, schema: v });
    walkProps(v, path ? `${path}.${k}` : k, out);
    if (v?.items) walkProps(v.items, `${path ? path + '.' : ''}${k}[]`, out);
  }
  return out;
}

function countDefs(schema) {
  return Object.keys(schema?.$defs ?? schema?.definitions ?? {}).length;
}

function referencedDefs(schema) {
  const s = JSON.stringify(schema ?? {});
  return new Set([...s.matchAll(/"\$ref":"#\/(?:\$defs|definitions)\/([^"]+)"/g)].map(m => m[1]));
}

export function lintTools(tools, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const findings = [];
  const add = (f) => findings.push(f);
  const names = new Map();
  const paraCount = new Map();
  const defsSeen = new Map();

  for (const t of tools) {
    const tk = toolTokens(t);
    const d = t.description ?? '';
    const name = t.name ?? '(unnamed)';

    names.set(name, (names.get(name) ?? 0) + 1);
    if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) add({ rule: 'name-format', level: 'error', tool: name, message: 'Tool name must be 1-64 chars of [A-Za-z0-9_.-]; some clients reject anything else', fix: 'Rename to snake_case.' });

    if (!d.trim()) add({ rule: 'desc-missing', level: 'error', tool: name, message: 'No description: the model has to guess when to call this tool', fix: 'Add one sentence: what it does and when to use it.' });
    else if (d.trim().length < SHORT_OK) add({ rule: 'desc-too-short', level: 'warn', tool: name, message: `Description is only ${d.trim().length} chars`, fix: 'Say what it returns and when to prefer it over similar tools.' });

    if (tk.description > o.maxDescTokens) add({ rule: 'desc-too-long', level: 'warn', tool: name, message: `Description is ~${tk.description} tokens (limit ${o.maxDescTokens})`, fix: 'Keep the first 1-3 sentences; move usage guides and examples to server instructions, a prompt or a resource.', savings: tk.description - o.maxDescTokens });
    if (d.length > 4096) add({ rule: 'desc-client-truncation', level: 'error', tool: name, message: `Description is ${d.length} chars; Claude Code cuts upfront-loaded tool descriptions at 4,096 chars, so the model never sees the end`, fix: 'Put the critical facts first and cut to under 4,096 chars.' });
    if (tk.total > o.maxToolTokens) add({ rule: 'tool-too-big', level: 'warn', tool: name, message: `Tool definition is ~${tk.total} tokens (limit ${o.maxToolTokens}), sent on every request`, fix: 'Split the tool, flatten the schema, or trim descriptions.' });

    for (const re of BOILERPLATE) if (re.test(d)) { add({ rule: 'desc-boilerplate', level: 'info', tool: name, message: 'Description opens with filler ("This tool allows you to…")', fix: 'Start with the verb: "Search issues by…".', savings: estimateTokens(d.match(re)[0]) }); break; }
    if (/```/.test(d)) add({ rule: 'desc-code-block', level: 'info', tool: name, message: 'Description contains a fenced code block (examples are expensive on every request)', fix: 'Move examples to a resource or prompt; keep one short inline example at most.' });
    if (/(\*\*|__|^#+\s)/m.test(d)) add({ rule: 'desc-markdown', level: 'info', tool: name, message: 'Markdown emphasis/headings in description cost tokens and add nothing for the model', fix: 'Use plain text.' });
    if (/(^|\n)\s*(error responses?|errors?):?\s*\n?\s*\d{3}\b/i.test(d) || (d.match(/\b[45]\d\d\b:/g) ?? []).length >= 3) add({ rule: 'desc-http-errors', level: 'info', tool: name, message: 'Description lists HTTP error codes (generated from OpenAPI); the model rarely needs these up front', fix: 'Return actionable error messages from the tool instead.' });
    for (const re of INJECTION) if (re.test(d + JSON.stringify(t.inputSchema ?? {}))) { add({ rule: 'injection-pattern', level: 'error', tool: name, message: `Text that looks like a prompt-injection / tool-poisoning pattern (${re.source.slice(0, 40)})`, fix: 'Remove instructions aimed at the model; run mcp-readiness-check for a full security pass.' }); break; }

    for (const para of d.split(/\n\s*\n/).map(s => s.trim()).filter(s => s.length >= 120)) paraCount.set(para, [...(paraCount.get(para) ?? []), name]);

    const s = t.inputSchema;
    if (!s) add({ rule: 'schema-missing', level: 'error', tool: name, message: 'No inputSchema (MCP requires one, even if empty)', fix: 'Use {"type":"object","properties":{}}.' });
    else {
      if (s.type !== 'object') add({ rule: 'schema-not-object', level: 'error', tool: name, message: 'inputSchema.type must be "object"', fix: 'Wrap arguments in an object schema.' });
      if (s.$schema) add({ rule: 'schema-dollar-schema', level: 'info', tool: name, message: '"$schema" URL is sent to the model on every request', fix: 'Strip it from the tools/list payload.', savings: estimateTokens(`"$schema":"${s.$schema}",`) });
      const defs = s.$defs ?? s.definitions;
      if (defs) {
        const used = referencedDefs({ ...s, $defs: undefined, definitions: undefined });
        // transitively referenced
        let grew = true; while (grew) { grew = false; for (const k of [...used]) for (const r of referencedDefs(defs[k])) if (!used.has(r)) { used.add(r); grew = true; } }
        const unused = Object.keys(defs).filter(k => !used.has(k));
        if (unused.length) add({ rule: 'schema-unused-defs', level: 'warn', tool: name, message: `${unused.length} of ${countDefs(s)} $defs are never referenced by this tool`, fix: 'Prune unused $defs per tool (mcp-readiness --fix does this (Pro)).', savings: estimateTokens(JSON.stringify(Object.fromEntries(unused.map(k => [k, defs[k]])))) });
        const key = JSON.stringify(defs);
        defsSeen.set(key, [...(defsSeen.get(key) ?? []), name]);
      }
      for (const p of walkProps(s, '', [])) {
        const ps = p.schema ?? {};
        if (Array.isArray(ps.enum) && ps.enum.length > o.maxEnum) add({ rule: 'schema-big-enum', level: 'warn', tool: name, message: `Parameter "${p.path}" has a ${ps.enum.length}-value enum`, fix: 'Use a string with a short description, or a lookup tool.', savings: estimateTokens(JSON.stringify(ps.enum)) - 20 });
        if (typeof ps.description === 'string' && ps.description.length > o.maxParamDescChars) add({ rule: 'param-desc-too-long', level: 'info', tool: name, message: `Parameter "${p.path}" description is ${ps.description.length} chars`, fix: 'One sentence per parameter.' });
        if (ps.title && ps.title.toLowerCase().replace(/[^a-z0-9]/g, '') === p.name.toLowerCase().replace(/[^a-z0-9]/g, '')) add({ rule: 'schema-redundant-title', level: 'info', tool: name, message: `Parameter "${p.path}" has a title that just repeats its name`, fix: 'Drop the title.', savings: estimateTokens(`"title":"${ps.title}",`) });
        if (!ps.type && !ps.enum && !ps.const && !ps.$ref && !ps.anyOf && !ps.oneOf && !ps.allOf) add({ rule: 'param-untyped', level: 'warn', tool: name, message: `Parameter "${p.path}" has no type`, fix: 'Add a type so the model sends valid arguments.' });
      }
      const top = Object.keys(s.properties ?? {});
      if (top.length > 0 && !s.required) add({ rule: 'schema-no-required', level: 'info', tool: name, message: 'No "required" list: the model cannot tell which arguments are mandatory', fix: 'Add required: [...].' });
    }
  }

  for (const [n, c] of names) if (c > 1) add({ rule: 'name-duplicate', level: 'error', tool: n, message: `Tool name appears ${c} times`, fix: 'Tool names must be unique.' });
  for (const [para, ts] of paraCount) if (ts.length > 1) add({ rule: 'desc-duplicated-text', level: 'warn', tool: ts.join(', '), message: `Same ${para.length}-char paragraph repeated in ${ts.length} tools`, fix: 'Say it once in server instructions.', savings: estimateTokens(para) * (ts.length - 1) });
  for (const [k, ts] of defsSeen) if (ts.length > 2) add({ rule: 'schema-duplicated-defs', level: 'warn', tool: `${ts.length} tools`, message: `Identical $defs block (~${estimateTokens(k)} tokens) is copied into ${ts.length} tools`, fix: 'Prune per tool, or flatten the shared types.', savings: estimateTokens(k) * (ts.length - 1) });

  const total = tools.reduce((a, t) => a + toolTokens(t).total, 0);
  if (tools.length > o.maxTools) add({ rule: 'too-many-tools', level: 'warn', tool: '*', message: `${tools.length} tools (limit ${o.maxTools}); tool-selection accuracy drops as the list grows`, fix: 'Group into fewer tools, or expose toolsets the user can enable.' });
  if (total > o.maxTotalTokens) add({ rule: 'total-budget', level: 'warn', tool: '*', message: `Tool list is ~${total} tokens (budget ${o.maxTotalTokens}), sent with every model call`, fix: 'Run with --fix (Pro) to write a slimmer version.' });
  return { findings, total };
}
