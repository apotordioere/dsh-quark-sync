import fs from 'node:fs';
const dir = 'C:/Users/APOTO/.dsh/profiles/desktop/node_modules/@copylee/dsh-office/lib';
const files = fs.readdirSync(dir);
console.log('files:', files.join(','));
for (const f of files.filter((n) => /tool/i.test(n))) {
  const txt = fs.readFileSync(`${dir}/${f}`, 'utf8');
  const idx = txt.indexOf('name: "office_');
  console.log(`--- ${f} (${txt.length} B) name 位置 ${idx}`);
  if (idx > 0) console.log(txt.slice(Math.max(0, idx - 400), idx + 900));
}
