#!/usr/bin/env node
import { run } from '../src/cli.js';
run(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => { console.error(`mcp-readiness: ${e.message || e}`); process.exit(2); },
);
