/* Minimal zip reader (enough for .pptx): central directory, stored and deflated entries.
   No dependencies: inflation uses Node's zlib. Zip64 archives are not supported. */

import zlib from "node:zlib";

export function readZip(buf) {
  // the end-of-central-directory record is in the last 64 kB (+22 bytes)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("Not a zip file (no end of central directory).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (p === 0xffffffff) throw new Error("Zip64 archives are not supported.");
  const entries = new Map();
  for (let k = 0; k < count; k++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Corrupt zip central directory.");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    entries.set(name, { method, csize, local });
    p += 46 + nameLen + extraLen + commentLen;
  }
  const read = (name) => {
    const e = entries.get(name);
    if (!e) return null;
    const lp = e.local;
    if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error(`Corrupt zip entry ${name}.`);
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const data = buf.subarray(start, start + e.csize);
    if (e.method === 0) return Buffer.from(data);
    if (e.method === 8) return zlib.inflateRawSync(data);
    throw new Error(`Unsupported zip compression (method ${e.method}) in ${name}.`);
  };
  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read,
    text: (name) => { const b = read(name); return b ? b.toString("utf8") : null; },
  };
}
