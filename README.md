# mcp-readiness-cli

Scan an MCP server (remote HTTP or local stdio) in one command. The free CLI prints the readiness score, the token cost of tool descriptions, and the top fixes. `--fix` (the lossless slim of those descriptions) is part of MCP Readiness Pro.

The npm package name is **`mcp-readiness-cli`**. The unscoped name `mcp-readiness` is already used by another project, so after publish the command is `npx mcp-readiness-cli`. This package is **not published yet**.

## Quickstart

```bash
# Remote Streamable HTTP server
npx mcp-readiness-cli https://mcp.context7.com/mcp

# Local stdio server
npx mcp-readiness-cli --stdio node examples/demo-stdio.mjs

# Until this package is on npm, run it from a clone
node bin/mcp-readiness.js https://mcp.context7.com/mcp
```

Verified output against Context7 (`https://mcp.context7.com/mcp`, protocol 2025-06-18), captured 20 Nov 2026:

```
MCP Readiness: Context7 4.7.3
Target: https://mcp.context7.com/mcp
Score: 95/100
Tools: 2  ·  Tool descriptions: ~563 tokens  (list payload ~1,145 tokens)

Top fixes:
  ⚠️  "resolve-library-id" description is 2006 chars — Long descriptions burn context on every turn and hide instructions.
      Fix: Keep under ~1,000 chars; move docs to resources.
  ⚠️  resolve-library-id: Description is ~440 tokens (limit 300) — ≈140 tokens
      Fix: Keep the first 1-3 sentences; move usage guides and examples to server instructions, a prompt or a resource.

Heaviest tool descriptions:
     440  resolve-library-id  (schema 190, total 663)
     123  query-docs  (schema 343, total 482)
```

Token counts are estimates (about ±10%).

## CI

```bash
npx mcp-readiness-cli --json --fail-under 80 https://your-server/mcp
npx mcp-readiness-cli --fail-under 80 --stdio node ./server.js
```

- `--json` prints a machine-readable report (score, token breakdown, findings, tool list).
- `--fail-under N` exits `1` when the score is below N.
- `--token` (or `MCP_TOKEN`) is the bearer token for authenticated servers.
- A failed connection exits `2`.

## Pro fix

`--fix` applies a lossless, deterministic slim of tool descriptions and schemas (names and argument shapes stay the same). It needs a Pro key:

```bash
export MCP_READINESS_LICENSE=mrc_live_…   # or pass --license
npx mcp-readiness-cli --fix --out tools.slim.json https://your-server/mcp
```

The key is checked against the MCP Readiness scanner API (`GET {MCP_READINESS_API_URL}/api/license`). If the API cannot be reached, `--fix` is skipped with a warning and the free scan still completes. Without a key, the CLI prints how to get Pro and does not write a file.

## Install (after npm publish)

```bash
npm i -g mcp-readiness-cli
mcp-readiness-cli https://your-server/mcp
```

A `mcp-readiness` binary is also installed for local/global use. Do not run `npx mcp-readiness` — that would invoke a different package.

## License

MIT. Scanning checks are adapted from [mcp-readiness-check](https://github.com/Om3rr/mcp-readiness-check). Token estimates and lossless slimming ideas come from the MCP Readiness family (ToolSlim); the rewrite itself stays behind the Pro key.
