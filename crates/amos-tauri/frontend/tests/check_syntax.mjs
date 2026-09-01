// Amos — frontend syntax check using bun's transpiler (no execution).
// Run with:  bun tests/check_syntax.mjs   (or `bun run check`)

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../js');
const transpiler = new Bun.Transpiler({ loader: 'js' });

let count = 0;
let bad = 0;

function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else if (p.endsWith('.js')) {
      count++;
      const src = fs.readFileSync(p, 'utf8');
      try {
        transpiler.transformSync(src);
      } catch (err) {
        bad++;
        console.error(`FAIL ${p}: ${err.message}`);
      }
    }
  }
}

walk(root);
console.log(`${count} files checked, ${bad} failed`);
process.exit(bad ? 1 : 0);
