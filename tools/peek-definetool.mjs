import fs from 'node:fs';
const f='C:/Users/APOTO/.dsh/profiles/desktop/node_modules/@copylee/dsh-office/lib/index.js';
const t=fs.readFileSync(f,'utf8');
const i=t.indexOf('function defineTool');
console.log(i<0?'NOT FOUND':t.slice(i, i+1800));
