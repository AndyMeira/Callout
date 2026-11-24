/* fit-mesh.js — recalibra o alinhamento game→malha usando o PRÓPRIO nav como
   referência (mesmo espaço de coordenadas, mediana de erro -3,6 HU comprovada).
   Objetivo: maximizar células onde o topo da malha bate com o piso do nav.
   Em seguida reancora o Z (escala/offset) regredindo a tabela antiga contra o
   piso EXATO da malha (mais limpo que o regredir contra o nav ruidoso).
   Grava tools/out/fit-<mapa>.json (mesmo formato que o genmesh.js lê). */
'use strict';
const fs = require('fs');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8');
const lib = src.slice(0, src.indexOf('/* ---------- calibra')).replace(/'use strict';/, '');
const api = new Function('require', lib + '\n; return { parseNav, containsXY, idwZ };')(require);
const { parseNav, containsXY, idwZ } = api;

function parseMesh(buf) {
  const nV = buf.readUInt32LE(8), nF = buf.readUInt32LE(12);
  return { verts: new Float32Array(buf.buffer, buf.byteOffset + 16, nV * 3), faces: new Uint32Array(buf.buffer, buf.byteOffset + 16 + nV * 12, nF * 3), nV, nF };
}
function triZ(v, a, b, c, x, y) {
  const ax = v[a * 3], ay = v[a * 3 + 1], bx = v[b * 3], by = v[b * 3 + 1], cx = v[c * 3], cy = v[c * 3 + 1];
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return null;
  return l1 * v[a * 3 + 2] + l2 * v[b * 3 + 2] + l3 * v[c * 3 + 2];
}
function rasterTop(mesh, K, minX, maxX, minY, maxY) {
  const bins = new Map();
  const { verts, faces } = mesh;
  for (let f = 0; f < faces.length; f += 3) {
    let a0 = 1e9, a1 = -1e9, b0 = 1e9, b1 = -1e9;
    for (let j = 0; j < 3; j++) { const i = faces[f + j]; const X = verts[i * 3], Y = verts[i * 3 + 1]; if (X < a0) a0 = X; if (X > a1) a1 = X; if (Y < b0) b0 = Y; if (Y > b1) b1 = Y; }
    const c0 = Math.max(0, ((a0 - minX) / (maxX - minX) * K) | 0), c1 = Math.min(K - 1, ((a1 - minX) / (maxX - minX) * K) | 0);
    const r0 = Math.max(0, ((b0 - minY) / (maxY - minY) * K) | 0), r1 = Math.min(K - 1, ((b1 - minY) / (maxY - minY) * K) | 0);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * K + c; if (!bins.has(k)) bins.set(k, []); bins.get(k).push(f); }
  }
  const rast = new Float32Array(K * K).fill(NaN);
  for (let by = 0; by < K; by++) for (let bx = 0; bx < K; bx++) {
    const x = minX + (bx + .5) / K * (maxX - minX), y = minY + (by + .5) / K * (maxY - minY);
    let top = -Infinity;
    for (const f of bins.get(by * K + bx) || []) {
      const z = triZ(verts, faces[f], faces[f + 1], faces[f + 2], x, y);
      if (z !== null && z > top) top = z;
    }
    if (top > -Infinity) rast[by * K + bx] = top;
  }
  return { rast, K };
}
function rasterNavFloor(nav, K, minX, maxX, minY, maxY) {
  const bins = new Map();
  for (let ai = 0; ai < nav.areas.length; ai++) {
    const a = nav.areas[ai];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const c of a.corners) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
    const c0 = Math.max(0, ((x0 - minX) / (maxX - minX) * K) | 0), c1 = Math.min(K - 1, ((x1 - minX) / (maxX - minX) * K) | 0);
    const r0 = Math.max(0, ((y0 - minY) / (maxY - minY) * K) | 0), r1 = Math.min(K - 1, ((y1 - minY) / (maxY - minY) * K) | 0);
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) { const k = r * K + c; if (!bins.has(k)) bins.set(k, []); bins.get(k).push(ai); }
  }
  const rast = new Float32Array(K * K).fill(NaN);
  for (let by = 0; by < K; by++) for (let bx = 0; bx < K; bx++) {
    const x = minX + (bx + .5) / K * (maxX - minX), y = minY + (by + .5) / K * (maxY - minY);
    let zmin = Infinity;
    for (const ai of bins.get(by * K + bx) || []) {
      const a = nav.areas[ai];
      if (containsXY(a.corners, x, y)) { const z = idwZ(a.corners, x, y); if (z < zmin) zmin = z; }
    }
    if (zmin < Infinity) rast[by * K + bx] = zmin;
  }
  return { rast, K };
}
function bil(r, u, v) {
  const { rast, K } = r;
  const fx = Math.max(0, Math.min(K - 1.001, u * K - .5)), fy = Math.max(0, Math.min(K - 1.001, v * K - .5));
  const x0 = fx | 0, y0 = fy | 0, tx = fx - x0, ty = fy - y0;
  const g = (x, y) => rast[y * K + x];
  let s = 0, w = 0;
  for (const [x, y, ww] of [[x0, y0, (1 - tx) * (1 - ty)], [Math.min(K - 1, x0 + 1), y0, tx * (1 - ty)], [x0, Math.min(K - 1, y0 + 1), (1 - tx) * ty], [Math.min(K - 1, x0 + 1), Math.min(K - 1, y0 + 1), tx * ty]]) {
    const val = g(x, y);
    if (!isNaN(val)) { s += val * ww; w += ww; }
  }
  return w > .5 ? s / w : NaN;
}

const OUT = path.join(__dirname, 'out');
const HALF = 76.8, SPAN = 153.6;
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
function readOld(mapName) {
  let m;
  if (mapName === 'mirage') m = /ht:"([A-Za-z0-9+/=]+)",hmax:([\d.]+)/.exec(html);
  else m = /const B64=IS_MIR\?MIRAGE\.ht:'([A-Za-z0-9+/=]+)'.*?HMAX=IS_MIR\?MIRAGE\.hmax:([\d.]+)/s.exec(html);
  const bin = Buffer.from(m[1], 'base64');
  const M = Math.sqrt(bin.length) | 0;
  return { M, hmax: parseFloat(m[2]), get: (c, r) => bin[r * M + c] / 255 * parseFloat(m[2]) };
}

const resultado = {};
for (const mapName of ['dust2', 'mirage']) {
  const nav = parseNav(fs.readFileSync(path.join(__dirname, 'nav', `de_${mapName}.nav`)));
  const mesh = parseMesh(fs.readFileSync(path.join(__dirname, 'mesh', `de_${mapName}.mesh`)));
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let i = 0; i < mesh.nV * 3; i += 3) {
    const X = mesh.verts[i], Y = mesh.verts[i + 1];
    if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
  }
  const K = 512;
  const rm = rasterTop(mesh, K, minX, maxX, minY, maxY);
  const rn = rasterNavFloor(nav, K, minX, maxX, minY, maxY);
  // objetivo: max de células com |topoMalha - pisoNav| < 10 HU (roofs somem no ruido constante)
  const score = (dx, dy, sx, sy, flipX, flipY) => {
    let ok = 0, n = 0;
    for (let rr = 0; rr < 64; rr++) for (let cc = 0; cc < 64; cc++) {
      const gx = (cc + .5) / 64 * SPAN - HALF, gz = (rr + .5) / 64 * SPAN - HALF;
      let u = (gx - dx) / (SPAN * sx) + .5, v = (gz - dy) / (SPAN * sy) + .5;
      if (flipX) u = 1 - u; if (flipY) v = 1 - v;
      if (u < 0 || u > 1 || v < 0 || v > 1) continue;
      const mz = bil(rm, u, v), nz = bil(rn, u, v);
      if (isNaN(nz) || isNaN(mz)) continue;
      n++;
      if (Math.abs(mz - nz) < 10) ok++;
    }
    return n > 500 ? ok / n : -1;
  };
  let best = { s: -1 };
  for (const flipY of [false, true]) for (const flipX of [false, true])
    for (let dx = -10; dx <= 10; dx += 2) for (let dy = -10; dy <= 10; dy += 2)
      for (let sxi = 0; sxi <= 5; sxi++) for (let syi = 0; syi <= 5; syi++) {
        const sx = .88 + sxi * .09, sy = .88 + syi * .09;
        const s = score(dx, dy, sx, sy, flipX, flipY);
        if (s > best.s) best = { s, dx, dy, sx, sy, flipX, flipY };
      }
  console.log(`${mapName} grosso: acerto=${(best.s * 100).toFixed(1)}% dx=${best.dx} dy=${best.dy} sx=${best.sx.toFixed(2)} sy=${best.sy.toFixed(2)}`);
  for (let it = 0; it < 3; it++) {
    const stp = [1.5, .5, .15][it], st = [.03, .008, .002][it];
    for (let dx = best.dx - 2 * stp; dx <= best.dx + 2 * stp; dx += stp)
      for (let dy = best.dy - 2 * stp; dy <= best.dy + 2 * stp; dy += stp)
        for (let sx = best.sx - 2 * st; sx <= best.sx + 2 * st; sx += st)
          for (let sy = best.sy - 2 * st; sy <= best.sy + 2 * st; sy += st) {
            const s = score(dx, dy, sx, sy, best.flipX, best.flipY);
            if (s > best.s) best = { s, dx, dy, sx, sy, flipX: best.flipX, flipY: best.flipY };
          }
  }
  console.log(`${mapName} final: acerto=${(best.s * 100).toFixed(1)}%`);
  // reancoragem do Z: tabela antiga vs piso EXATO da malha nas células cobertas
  const old = readOld(mapName);
  const pts = [];
  for (let rr = 0; rr < old.M; rr += 1) for (let cc = 0; cc < old.M; cc += 1) {
    const gx = (cc + .5) / old.M * SPAN - HALF, gz = (rr + .5) / old.M * SPAN - HALF;
    let u = (gx - best.dx) / (SPAN * best.sx) + .5, v = (gz - best.dy) / (SPAN * best.sy) + .5;
    if (best.flipX) u = 1 - u; if (best.flipY) v = 1 - v;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const mz = bil(rm, u, v), nz = bil(rn, u, v);
    if (isNaN(mz) || isNaN(nz) || Math.abs(mz - nz) > 10) continue; // só pisos limpos
    pts.push([mz, old.get(cc, rr)]);
  }
  let ax = 0, ay = 0, axx = 0, axy = 0;
  for (const [x, y] of pts) { ax += x; ay += y; axx += x * x; axy += x * y; }
  const n = pts.length;
  const a = (n * axy - ax * ay) / (n * axx - ax * ax || 1e-9);
  const b = (ay - a * ax) / n;
  let ssr = 0, sst = 0; const my = ay / n;
  for (const [x, y] of pts) { const f = a * x + b; ssr += (y - f) ** 2; sst += (y - my) ** 2; }
  console.log(`${mapName} Z: escala=${a.toFixed(6)} offset=${b.toFixed(3)} R2=${(1 - ssr / sst).toFixed(4)} (n=${n})`);
  resultado[mapName] = { dx: +best.dx.toFixed(3), dy: +best.dy.toFixed(3), sx: +best.sx.toFixed(4), sy: +best.sy.toFixed(4), flipX: best.flipX, flipY: best.flipY, escalaZ: +a.toFixed(6), offsetZ: +b.toFixed(3), R2: +(1 - ssr / sst).toFixed(4), acertoXY: +best.s.toFixed(4) };
  fs.writeFileSync(path.join(OUT, `fit-${mapName}.json`), JSON.stringify(resultado[mapName], null, 2));
}
console.log('fits atualizados.');
