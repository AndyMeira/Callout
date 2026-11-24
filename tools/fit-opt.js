/* fit-opt.js — encontra a transformacao exata nav→jogo maximizando a
   correlacao (R²) com a tabela antiga de alturas.
   1. rasteriza o nav (piso = menor z das areas que cobrem cada ponto) em 512×512
   2. busca grossa-fina de 4 parametros: deslocamento (dx,dy) e escala (sx,sy)
   3. salva o resultado em tools/out/fit-<mapa>.json para o gennav.js usar */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8');
const cut = src.indexOf('/* ---------- principal ---------- */');
const lib = src.slice(0, cut).replace(/'use strict';/, '');
const api = new Function('require', lib + '\n; return { parseNav, containsXY, idwZ, readOldTable };')(require);
const { parseNav, containsXY, idwZ, readOldTable } = api;

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const HALF = 76.8, SPAN = 153.6;
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });

function rasterize(nav) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const a of nav.areas) for (const c of a.corners) {
    if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
  }
  const K = 512;
  const rast = new Float32Array(K * K).fill(NaN);
  // bins de areas por bbox para consulta rapida
  const bins = new Map();
  const bkey = (bx, by) => by * K + bx;
  for (let ai = 0; ai < nav.areas.length; ai++) {
    const a = nav.areas[ai];
    let ax0 = 1e9, ax1 = -1e9, ay0 = 1e9, ay1 = -1e9;
    for (const c of a.corners) { if (c[0] < ax0) ax0 = c[0]; if (c[0] > ax1) ax1 = c[0]; if (c[1] < ay0) ay0 = c[1]; if (c[1] > ay1) ay1 = c[1]; }
    const bx0 = Math.floor((ax0 - minX) / (maxX - minX) * K), bx1 = Math.min(K - 1, Math.floor((ax1 - minX) / (maxX - minX) * K));
    const by0 = Math.floor((ay0 - minY) / (maxY - minY) * K), by1 = Math.min(K - 1, Math.floor((ay1 - minY) / (maxY - minY) * K));
    for (let by = Math.max(0, by0); by <= by1; by++) for (let bx = Math.max(0, bx0); bx <= bx1; bx++) {
      const k = bkey(bx, by);
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(ai);
    }
  }
  for (let by = 0; by < K; by++) for (let bx = 0; bx < K; bx++) {
    const nx = minX + (bx + .5) / K * (maxX - minX);
    const ny = minY + (by + .5) / K * (maxY - minY);
    const list = bins.get(bkey(bx, by));
    if (!list) continue;
    let zmin = Infinity;
    for (const ai of list) {
      const a = nav.areas[ai];
      if (containsXY(a.corners, nx, ny)) { const z = idwZ(a.corners, nx, ny); if (z < zmin) zmin = z; }
    }
    if (zmin < Infinity) rast[by * K + bx] = zmin;
  }
  return { rast, K, minX, maxX, minY, maxY };
}

function sample(r, u, v) { // u,v em [0,1] sobre os limites do nav; bilinear com NaN=sem cobertura
  const { rast, K } = r;
  const fx = Math.max(0, Math.min(K - 1.001, u * K - .5)), fy = Math.max(0, Math.min(K - 1.001, v * K - .5));
  const x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
  const g = (x, y) => rast[y * K + x];
  const a = g(x0, y0), b = g(Math.min(K - 1, x0 + 1), y0), c = g(x0, Math.min(K - 1, y0 + 1)), d = g(Math.min(K - 1, x0 + 1), Math.min(K - 1, y0 + 1));
  let s = 0, w = 0;
  if (!isNaN(a)) { s += a * (1 - tx) * (1 - ty); w += (1 - tx) * (1 - ty); }
  if (!isNaN(b)) { s += b * tx * (1 - ty); w += tx * (1 - ty); }
  if (!isNaN(c)) { s += c * (1 - tx) * ty; w += (1 - tx) * ty; }
  if (!isNaN(d)) { s += d * tx * ty; w += tx * ty; }
  return w > 0.5 ? s / w : NaN;
}

function r2At(r, old, dx, dy, sx, sy, flipX, flipY) {
  // transform: ponto de jogo (gx,gz) → u,v em [0,1] do retangulo do nav
  // dx,dy = centro do retangulo em coordenadas de jogo; sx,sy = razao tamanho_nav/tamanho_jogo
  const pts = [];
  for (let rr = 0; rr < old.M; rr += 2) for (let cc = 0; cc < old.M; cc += 2) {
    const gx = (cc + .5) / old.M * SPAN - HALF, gz = (rr + .5) / old.M * SPAN - HALF;
    let u = (gx - dx) / (SPAN * sx) + .5, v = (gz - dy) / (SPAN * sy) + .5;
    if (flipX) u = 1 - u;
    if (flipY) v = 1 - v;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const nz = sample(r, u, v);
    if (isNaN(nz)) continue;
    pts.push(nz, old.get(cc, rr));
  }
  const n = pts.length / 2;
  if (n < 1500) return { r2: -1, n };
  let sx_ = 0, sy_ = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < pts.length; i += 2) { sx_ += pts[i]; sy_ += pts[i + 1]; sxx += pts[i] * pts[i]; sxy += pts[i] * pts[i + 1]; }
  const a = (n * sxy - sx_ * sy_) / (n * sxx - sx_ * sx_ || 1e-9);
  const b = (sy_ - a * sx_) / n;
  let ssr = 0, sst = 0;
  const my = sy_ / n;
  for (let i = 0; i < pts.length; i += 2) { const f = a * pts[i] + b; ssr += (pts[i + 1] - f) ** 2; sst += (pts[i + 1] - my) ** 2; }
  return { r2: 1 - ssr / sst, a, b, n };
}

const result = {};
for (const mapName of ['dust2', 'mirage']) {
  const nav = parseNav(fs.readFileSync(path.join(__dirname, 'nav', `de_${mapName}.nav`)));
  const old = readOldTable(html, mapName);
  const r = rasterize(nav);
  console.log(`${mapName}: nav rasterizado (${(r.rast.filter ? '' : '')} ${nav.areas.length} areas)`);
  // busca grossa
  let best = { r2: -1 };
  for (const flipY of [false, true]) for (const flipX of [false, true]) {
    for (let dx = -12; dx <= 12; dx += 3) for (let dy = -12; dy <= 12; dy += 3) {
      for (let sxi = 0; sxi <= 6; sxi++) for (let syi = 0; syi <= 6; syi++) {
        const sx = 0.85 + sxi * 0.08, sy = 0.85 + syi * 0.08;
        const res = r2At(r, old, dx, dy, sx, sy, flipX, flipY);
        if (res.r2 > best.r2) best = { ...res, dx, dy, sx, sy, flipX, flipY };
      }
    }
  }
  // refinamento fino em torno do melhor (a funcao abaixo considera flips)
  console.log(`${mapName} grosso: R2=${best.r2.toFixed(4)} dx=${best.dx} dy=${best.dy} sx=${best.sx.toFixed(2)} sy=${best.sy.toFixed(2)} flipX=${best.flipX} flipY=${best.flipY}`);
  for (let it = 0; it < 3; it++) {
    const step = [1.5, .5, .15][it], st = [0.02, 0.005, 0.0015][it];
    for (let dx = best.dx - 2 * step; dx <= best.dx + 2 * step; dx += step) {
      for (let dy = best.dy - 2 * step; dy <= best.dy + 2 * step; dy += step) {
        for (let sx = best.sx - 2 * st; sx <= best.sx + 2 * st; sx += st) {
          for (let sy = best.sy - 2 * st; sy <= best.sy + 2 * st; sy += st) {
            const res = r2At(r, old, dx, dy, sx, sy, best.flipX, best.flipY);
            if (res.r2 > best.r2) best = { ...res, dx, dy, sx, sy };
          }
        }
      }
    }
  }
  console.log(`${mapName} final: R2=${best.r2.toFixed(4)} n=${best.n} escalaZ=${best.a.toFixed(5)} offsetZ=${best.b.toFixed(2)}`);
  result[mapName] = { dx: +best.dx.toFixed(3), dy: +best.dy.toFixed(3), sx: +best.sx.toFixed(4), sy: +best.sy.toFixed(4), flipX: best.flipX, flipY: best.flipY, escalaZ: +best.a.toFixed(6), offsetZ: +best.b.toFixed(3), R2: +best.r2.toFixed(4) };
  fs.writeFileSync(path.join(OUT, `fit-${mapName}.json`), JSON.stringify(result[mapName], null, 2));
}
fs.writeFileSync(path.join(OUT, 'fits.json'), JSON.stringify(result, null, 2));
console.log('salvo em tools/out/fits.json');
