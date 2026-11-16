// tar 长路径回归测试：ustar 前缀装不下时走 GNU '@LongLink'
import { packTar, unpackTar } from '../lib/tar.js';
import { deviceId } from '../lib/scope.js';

const deep = 'harness/profiles/desktop/node_modules/@jimp/plugin-print/src/__image_snapshots__/' + 'a'.repeat(120) + '/x.png';
const short = 'workspace/readme.md';
const entries = [
  { name: short, data: Buffer.from('hello') },
  { name: deep, data: Buffer.from('deep-content') },
  { name: 'workspace/中文目录/文件.txt', data: Buffer.from('中文内容') },
];
const tar = packTar(entries);
const back = unpackTar(tar);
const ok = back.length === 3 && back.every((e, i) => e.name === entries[i].name && e.data.toString() === entries[i].data.toString());
console.log(`tar 往返: ${ok ? 'OK' : 'FAIL'} (${back.length} 项, ${tar.length} B)`);
if (!ok) {
  for (const e of back) console.log('  got:', e.name, e.data.length);
  process.exit(1);
}
console.log('deviceId:', deviceId());
