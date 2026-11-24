/* probe-flags.js — examina os bits de dynamic_attribute_flags do nav,
   procurando os marcadores de bombsite (A/B) para ancorar a calibracao */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8');
const cut = src.indexOf('/* ---------- principal ---------- */');
const lib = src.slice(0, cut).replace(/'use strict';/, '');
const api = new Function('require', lib + '\n; return { parseNav, containsXY, idwZ };')(require);
const { parseNav } = api;

const mapName = process.argv[2] || 'dust2';
const navRaw = fs.readFileSync(path.join(__dirname, 'nav', `de_${mapName}.nav`));
// parse manual com flags preservadas
const R_ = api.parseNav;
const nav = R_(navRaw);
// o parser atual descarta flags; rele o arquivo com um parser local igual mas guardando flags
const buf = navRaw;
const r = new (class { constructor(b) { this.b = b; this.p = 0; } take(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; } u8() { return this.take(1)[0]; } u32() { return this.take(4).readUInt32LE(0); } i32() { return this.take(4).readInt32LE(0); } i64() { return this.take(8).readBigInt64LE(0); } f32() { return this.take(4).readFloatLE(0); } vec3() { return [this.f32(), this.f32(), this.f32()]; } skip(n) { this.take(n); } align8() { this.skip((8 - this.p % 8) % 8); } cstring() { while (this.u8() !== 0) {} } })(buf);
const skipKV3Local = rr => { rr.align8(); const magic = rr.u32(); const ver = magic & 0xFF; rr.skip(16); const method = rr.u32(); rr.skip(4); rr.skip(16); rr.skip(4); const su = rr.i32(), sc = rr.i32(), nb = rr.i32(), nbl = rr.i32(); let sb = 0; if (ver >= 4) { rr.skip(4); sb = rr.i32(); } let u1, c1, u2, c2; if (ver >= 5) { u1 = rr.i32(); c1 = rr.i32(); u2 = rr.i32(); c2 = rr.i32(); rr.skip(32); } else { u1 = su; c1 = sc; u2 = 0; c2 = 0; } rr.skip((method === 0 ? u1 : c1) + (method === 0 ? u2 : c2) + sb); };
r.u32(); const version = r.u32(); r.u32(); r.u32();
if (version >= 36) skipKV3Local(r);
let polys = null;
if (version >= 31) {
  const nc = r.u32(); const corners = []; for (let i = 0; i < nc; i++) corners.push(r.vec3());
  const np = r.u32(); polys = [];
  for (let i = 0; i < np; i++) { const n = r.u8(); const p = []; for (let k = 0; k < n; k++) p.push(corners[r.u32()]); if (version >= 35) r.skip(4); polys.push(p); }
}
if (version >= 32) r.skip(4);
if (version >= 35) { const cnt = r.u32(); for (let i = 0; i < cnt; i++) { r.cstring(); r.skip(48); } }
if (version >= 36) skipKV3Local(r);
const na = r.u32();
const areas = [];
for (let i = 0; i < na; i++) {
  const id = r.u32(); const flags = r.i64(); r.u8();
  const pi = r.u32(); const corners = polys[pi];
  r.skip(4);
  for (let e = 0; e < corners.length; e++) { const n = r.u32(); for (let k = 0; k < n; k++) { r.u32(); r.u32(); } }
  r.skip(5);
  for (const q of [0, 0]) { const n = r.u32(); for (let k = 0; k < n; k++) r.u32(); }
  areas.push({ id, flags, corners });
}
// estatistica por bit
const byBit = new Map();
for (const a of areas) {
  let f = a.flags; let bit = 0;
  while (f > 0n) { if (f & 1n) { if (!byBit.has(bit)) byBit.set(bit, []); byBit.get(bit).push(a); } f >>= 1n; bit++; }
}
console.log(`mapa=${mapName} v${version} areas=${areas.length}`);
const rows = [];
for (const [bit, list] of byBit) {
  let sx = 0, sy = 0, sz = 0, spread = 0;
  for (const a of list) { let cx = 0, cy = 0, cz = 0; for (const c of a.corners) { cx += c[0]; cy += c[1]; cz += c[2]; } const n = a.corners.length; sx += cx / n; sy += cy / n; sz += cz / n; }
  const mx = sx / list.length, my = sy / list.length;
  for (const a of list) { let cx = 0, cy = 0; for (const c of a.corners) { cx += c[0]; cy += c[1]; } const n = a.corners.length; spread += Math.hypot(cx / n - mx, cy / n - my); }
  rows.push({ bit, areas: list.length, cx: Math.round(mx), cy: Math.round(my), cz: +(sz / list.length).toFixed(1), dispersao: Math.round(spread / list.length) });
}
rows.sort((a, b) => b.areas - a.areas);
console.table(rows.slice(0, 18));
