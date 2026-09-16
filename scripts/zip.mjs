import { deflateSync, deflateRawSync, crc32 } from "zlib";

function concat(parts) {
  const len = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function u16(n) {
  const b = new Uint8Array(2);
  new DataView(b.buffer).setUint16(0, n, true);
  return b;
}

function u32(n) {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, true);
  return b;
}

function dosTime(d = new Date()) {
  const t =
    ((d.getHours() & 31) << 11) |
    ((d.getMinutes() & 63) << 5) |
    ((Math.floor(d.getSeconds() / 2)) & 31);
  const dt =
    (((d.getFullYear() - 1980) & 127) << 9) |
    (((d.getMonth() + 1) & 15) << 5) |
    (d.getDate() & 31);
  return { t, dt };
}

/**
 * @param {{ name: string, data: Uint8Array }[]} files
 */
export function zipFiles(files) {
  const enc = new TextEncoder();
  const { t, dt } = dosTime();
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const file of files) {
    const name = enc.encode(file.name.replace(/\\/g, "/"));
    const data = file.data;
    const crc = crc32(data) >>> 0;
    const compressed = new Uint8Array(deflateRawSync(Buffer.from(data), { level: 9 }));
    const local = concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(8),
      u16(t),
      u16(dt),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      name,
      compressed,
    ]);
    const central = concat([
      u32(0x02014b50),
      u16(20),
      u16(20),
      u16(0),
      u16(8),
      u16(t),
      u16(dt),
      u32(crc),
      u32(compressed.length),
      u32(data.length),
      u16(name.length),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(0),
      u32(offset),
      name,
    ]);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }

  const centralSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = concat([
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(files.length),
    u16(files.length),
    u32(centralSize),
    u32(offset),
    u16(0),
  ]);
  return concat([...locals, ...centrals, end]);
}

export function pngGlyph(size, rgb, letter = "P") {
  const row = size * 4 + 1;
  const raw = new Uint8Array(row * size);
  const glyphs = {
    S: ["01110", "10001", "01100", "00010", "10001", "01110", "00000"],
    U: ["10001", "10001", "10001", "10001", "10001", "01110", "00000"],
    P: ["11110", "10001", "10001", "11110", "10000", "10000", "00000"],
  };
  const glyph = glyphs[letter] || glyphs.P;
  const gw = 5;
  const gh = 7;
  const cell = Math.max(1, Math.floor(size / 10));
  const ox = Math.floor((size - gw * cell) / 2);
  const oy = Math.floor((size - gh * cell) / 2);
  for (let y = 0; y < size; y++) {
    raw[y * row] = 0;
    for (let x = 0; x < size; x++) {
      const i = y * row + 1 + x * 4;
      raw[i] = rgb[0];
      raw[i + 1] = rgb[1];
      raw[i + 2] = rgb[2];
      const gx = Math.floor((x - ox) / cell);
      const gy = Math.floor((y - oy) / cell);
      const on = gy >= 0 && gy < gh && gx >= 0 && gx < gw && glyph[gy].charAt(gx) === "1";
      raw[i + 3] = on ? 230 : 0;
    }
  }
  function be32(n) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, n);
    return b;
  }
  function chunk(type, data) {
    const tenc = new TextEncoder().encode(type);
    const body = concat([tenc, data]);
    const crc = crc32(body) >>> 0;
    return concat([be32(data.length), body, be32(crc)]);
  }
  const ihdr = concat([be32(size), be32(size), new Uint8Array([8, 6, 0, 0, 0])]);
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const idat = deflateSync(Buffer.from(raw));
  return concat([sig, chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(idat)), chunk("IEND", new Uint8Array())]);
}
