import fs from 'node:fs';
const f = 'C:/Users/APOTO/.dsh/profiles/desktop/node_modules/@copylee/dsh-office/lib/index.js';
const lines = fs.readFileSync(f, 'utf8').split('\n');
lines.forEach((l, i) => {
  if (/dsh-tools|defineTool/.test(l) && /import|require/.test(l)) {
    console.log(`${i + 1}: ${l.trim().slice(0, 220)}`);
  }
});
