import { readFileSync } from 'node:fs';
const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const have = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
let bad = 0;
for (const f of ['app.js', 'ar.js', 'sprinkler-ui.js']) {
  const src = readFileSync(new URL('../' + f, import.meta.url), 'utf8');
  const used = new Set([...src.matchAll(/\$\('([a-z0-9-]+)'\)/g)].map((m) => m[1]));
  for (const id of used) if (!have.has(id)) { console.log('MISSING in index.html:', id, '(used by', f + ')'); bad++; }
}
console.log(bad ? bad + ' missing ids' : 'all element ids exist');
