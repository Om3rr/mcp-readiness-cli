// Zero-dependency token estimator. Approximates BPE tokenizers (cl100k / o200k style)
// using the same pre-tokenization regex shape, then a length heuristic per piece.
// Calibrated against gpt-tokenizer (o200k_base) on real MCP tool lists: measured +1% to +9% (slightly conservative) on 14 real servers.
const PIECE = /'(?:s|t|re|ve|m|ll|d)| ?\p{L}+| ?\p{N}{1,3}| ?[^\s\p{L}\p{N}]+|\s+/gu;

export function estimateTokens(text) {
  if (text == null) return 0;
  const s = typeof text === 'string' ? text : JSON.stringify(text);
  let n = 0;
  for (const m of s.matchAll(PIECE)) {
    const p = m[0];
    if (/^\s+$/.test(p)) { n += 1; continue; }
    const core = p.startsWith(' ') ? p.slice(1) : p;
    if (/^\p{L}+$/u.test(core)) {
      if (/[^\x00-\x7F]/.test(core)) n += Math.ceil(core.length / 2);
      else n += core.length <= 9 ? 1 : Math.ceil(core.length / 7);
    } else if (/^\p{N}+$/u.test(core)) n += 1;
    else n += Math.max(1, Math.ceil(core.length / 4));
  }
  return n;
}

/** What the model actually sees for one tool: name + description + input schema. */
export function toolPayload(tool) {
  const t = { name: tool.name, description: tool.description ?? '' };
  if (tool.inputSchema) t.input_schema = tool.inputSchema;
  return JSON.stringify(t);
}

export function toolTokens(tool) {
  return {
    total: estimateTokens(toolPayload(tool)),
    description: estimateTokens(tool.description ?? ''),
    schema: estimateTokens(tool.inputSchema ? JSON.stringify(tool.inputSchema) : ''),
  };
}
