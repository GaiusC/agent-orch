#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Windows shells and Node 18/20 do not expand this test glob. Enumerate it
// explicitly so supported Node versions run the same suite on every platform.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = fs.readdirSync(path.join(root, 'tests'))
  .filter(name => name.endsWith('.test.mjs')).sort().map(name => `tests/${name}`);
const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files],
  { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exitCode = result.status ?? 1;
