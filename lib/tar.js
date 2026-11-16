// 极简 ustar（POSIX tar）读写：只处理普通文件，够打包同步用
const BLOCK = 512;

function octal(value, width) {
  const s = value.toString(8);
  return s.padStart(width - 1, '0') + '\0';
}

function writeString(buf, offset, str, len) {
  const bytes = Buffer.from(str, 'utf8');
  bytes.copy(buf, offset, 0, Math.min(bytes.length, len));
}

function header(name, size, mtime, type = '0') {
  const buf = Buffer.alloc(BLOCK, 0);
  let prefix = '';
  let short = name;
  if (Buffer.byteLength(name, 'utf8') > 100) {
    const idx = name.lastIndexOf('/', name.length - 1);
    if (idx <= 0) throw new Error(`tar: 路径过长 ${name}`);
    prefix = name.slice(0, idx);
    short = name.slice(idx + 1);
    if (Buffer.byteLength(prefix, 'utf8') > 155 || Buffer.byteLength(short, 'utf8') > 100) {
      throw new Error(`tar: 路径过长 ${name}`);
    }
  }
  writeString(buf, 0, short, 100);
  writeString(buf, 100, octal(0o644, 8), 8);
  writeString(buf, 108, octal(0, 8), 8);
  writeString(buf, 116, octal(0, 8), 8);
  writeString(buf, 124, octal(size, 12), 12);
  writeString(buf, 136, octal(mtime || 0, 12), 12);
  buf.fill(0x20, 148, 156); // chksum 先填空格
  buf.write(type, 156, 'ascii');
  writeString(buf, 257, 'ustar\0', 6);
  writeString(buf, 263, '00', 2);
  writeString(buf, 265, 'root', 32);
  writeString(buf, 297, 'root', 32);
  writeString(buf, 345, prefix, 155);

  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += buf[i];
  const chk = sum.toString(8).padStart(6, '0') + '\0 ';
  buf.write(chk, 148, 'ascii');
  return buf;
}

function padBlocks(size) {
  const rem = size % BLOCK;
  return rem === 0 ? 0 : BLOCK - rem;
}

/** entries: [{ name, data: Buffer }] -> Buffer */
export function packTar(entries) {
  const parts = [];
  for (const e of entries) {
    let head;
    try {
      head = header(e.name, e.data.length, 0);
      parts.push(head);
    } catch {
      // 超过 ustar 单段/前缀上限：用 GNU 长名扩展块（type 'L'）带完整路径
      const longName = Buffer.from(e.name + '\0', 'utf8');
      parts.push(header('././@LongLink', longName.length, 0, 'L'));
      parts.push(longName);
      const pad0 = padBlocks(longName.length);
      if (pad0) parts.push(Buffer.alloc(pad0, 0));
      // 跟随条目的名字只作占位（解包时用 pendingName 覆盖），必须是短 ASCII，
      // 否则中文长名按字节算又会超 100 字节。
      parts.push(header('LONGNAME', e.data.length, 0));
    }
    parts.push(e.data);
    const pad = padBlocks(e.data.length);
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(BLOCK * 3, 0)); // 两个全零块 + 对齐
  return Buffer.concat(parts);
}

/** Buffer -> [{ name, data }] */
export function unpackTar(buf) {
  const out = [];
  let off = 0;
  let pendingName = null;
  while (off + BLOCK <= buf.length) {
    const h = buf.subarray(off, off + BLOCK);
    if (h.every((b) => b === 0)) break;
    const rawName = h.subarray(0, 100).toString('utf8').replace(/\0.*$/, '');
    const prefix = h.subarray(345, 500).toString('utf8').replace(/\0.*$/, '');
    const size = parseInt(h.subarray(124, 136).toString('ascii').replace(/\0.*$/, '').trim() || '0', 8);
    const type = h.subarray(156, 157).toString('ascii');
    off += BLOCK;
    if (type === 'L') {
      pendingName = buf.subarray(off, off + size).toString('utf8').replace(/\0.*$/, '');
    } else if (type === '0' || type === '\0') {
      const name = pendingName || (prefix ? `${prefix}/${rawName}` : rawName);
      pendingName = null;
      out.push({ name, data: buf.subarray(off, off + size) });
    }
    off += size + padBlocks(size);
  }
  return out;
}
