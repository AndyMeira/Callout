/* fit-walls.js — o teste definitivo de alinhamento: o grid de paredes do jogo
   (MAPROWS/MIRAGE.rows, desenhado à mão) tem que casar com a geometria real.
   Parede do jogo ('#') → algo alto na malha; chão → piso da malha.
   Otimiza a transformação por ESSE objetivo e grava fit-<mapa>.json. */
'use strict';
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'fit-mesh.js'), 'utf8');
const lib = src.slice(0, src.indexOf('const OUT =')).replace(/'use strict';/, '');
const api = new Function('require', '__dirname', lib + '\n; return { parseMesh, parseNavX: null, rasterTop, rasterNavFloor, bil };')(require, __dirname);
const { parseMesh, rasterTop, rasterNavFloor, bil } = api;
const navApi = new Function('require', '__dirname', fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8').slice(0, fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8').indexOf('/* ---------- calibra')).replace(/'use strict';/, '') + '\n; return { parseNav };')(require, __dirname);

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const HALF = 76.8, SPAN = 153.6, K = 512;
const OUT = path.join(__dirname, 'out');

// extrai o grid de paredes do jogo (256×256)
function readRows(mapName) {
  let m;
  if (mapName === 'mirage') m = /MIRAGE=\{\s*rows:\[([\s\S]*?)\]/.exec(html);
  else m = /const MAPROWS=IS_MIR\?MIRAGE\.rows:\[([\s\S]*?)\];/.exec(html);
  const rows = [];
  const re = /"([^"]*)"|'([^']*)'/g;
  let mm;
  while ((mm = re.exec(m[1]))) rows.push(mm[1] !== undefined ? mm[1] : mm[2]);
  return rows;
}

const resultado = {};
for (const mapName of ['dust2', 'mirage']) {
  const rows = readRows(mapName);
  const GR = rows.length; // 256
  const nav = navApi.parseNav(fs.readFileSync(path.join(__dirname, 'nav', `de_${mapName}.nav`)));
  const mesh = parseMesh(fs.readFileSync(path.join(__dirname, 'mesh', `de_${mapName}.mesh`)));
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let i = 0; i < mesh.nV * 3; i += 3) { const X = mesh.verts[i], Y = mesh.verts[i + 1]; if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y; }
  const rm = rasterTop(mesh, K, minX, maxX, minY, maxY);
  const rn = rasterNavFloor(nav, K, minX, maxX, minY, maxY);
  // amostra do grid de paredes: subgrade 96×96 pra velocidade
  const cells = [];
  const step = 3;
  for (let r = 0; r < GR; r += step) for (let c = 0; c < GR; c += step) {
    const wall = rows[r][c] === '#';
    cells.push({ gx: (c + .5) / GR * SPAN - HALF, gz: (r + .5) / GR * SPAN - HALF, wall });
  }
  const score = (dx, dy, sx, sy, flipX, flipY) => {
    let good = 0, n = 0;
    for (const cell of cells) {
      let u = (cell.gx - dx) / (SPAN * sx) + .5, v = (cell.gz - dy) / (SPAN * sy) + .5;
      if (flipX) u = 1 - u; if (flipY) v = 1 - v;
      if (u < 0 || u > 1 || v < 0 || v > 1) return -1;
      const mz = bil(rm, u, v), nz = bil(rn, u, v);
      n++;
      if (cell.wall) {
        // parede: tem que ter algo alto na malha; sem malha (fora do mapa) = erro
        if (!isNaN(mz) && (isNaN(nz) || mz - nz > 25)) good++;
      } else {
        // chão: precisa de piso batendo; sem nav/malha = erro (mata o 'truque' de sair do mapa)
        if (!isNaN(mz) && !isNaN(nz) && Math.abs(mz - nz) < 10) good++;
      }
    }
    return n > 2000 ? good / n : -1;
  };
  let best = { s: -1 };
  for (const flipY of [false, true]) for (const flipX of [false, true])
    for (let dx = -10; dx <= 10; dx += 2) for (let dy = -10; dy <= 10; dy += 2)
      for (let sxi = 0; sxi <= 5; sxi++) for (let syi = 0; syi <= 5; syi++) {
        const sx = .88 + sxi * .09, sy = .88 + syi * .09;
        const s = score(dx, dy, sx, sy, flipX, flipY);
        if (s > best.s) best = { s, dx, dy, sx, sy, flipX, flipY };
      }
  console.log(`${mapName} grosso: casamento paredes=${(best.s * 100).toFixed(1)}% dx=${best.dx} dy=${best.dy} sx=${best.sx.toFixed(2)} sy=${best.sy.toFixed(2)} flipY=${best.flipY} flipX=${best.flipX}`);
  for (let it = 0; it < 3; it++) {
    const stp = [1.5, .5, .15][it], st = [.03, .008, .0025][it];
    for (let dx = best.dx - 2 * stp; dx <= best.dx + 2 * stp; dx += stp)
      for (let dy = best.dy - 2 * stp; dy <= best.dy + 2 * stp; dy += stp)
        for (let sx = best.sx - 2 * st; sx <= best.sx + 2 * st; sx += st)
          for (let sy = best.sy - 2 * st; sy <= best.sy + 2 * st; sy += st) {
            const s = score(dx, dy, sx, sy, best.flipX, best.flipY);
            if (s > best.s) best = { s, dx, dy, sx, sy, flipX: best.flipX, flipY: best.flipY };
          }
  }
  console.log(`${mapName} final: casamento paredes=${(best.s * 100).toFixed(1)}%`);
  // z ancorado pela tabela antiga nesse alinhamento
  let mOld;
  if (mapName === 'mirage') mOld = /ht:"([A-Za-z0-9+/=]+)",hmax:([\d.]+)/.exec(html);
  else mOld = /const B64=IS_MIR\?MIRAGE\.ht:'([A-Za-z0-9+/=]+)'.*?HMAX=IS_MIR\?MIRAGE\.hmax:([\d.]+)/s.exec(html);
  const binOld = Buffer.from(mOld[1], 'base64');
  const M = Math.sqrt(binOld.length) | 0;
  const hmaxOld = parseFloat(mOld[2]);
  const pts = [];
  for (let rr = 0; rr < M; rr++) for (let cc = 0; cc < M; cc++) {
    const gx = (cc + .5) / M * SPAN - HALF, gz = (rr + .5) / M * SPAN - HALF;
    let u = (gx - best.dx) / (SPAN * best.sx) + .5, v = (gz - best.dy) / (SPAN * best.sy) + .5;
    if (best.flipX) u = 1 - u; if (best.flipY) v = 1 - v;
    if (u < 0 || u > 1 || v < 0 || v > 1) continue;
    const mz = bil(rm, u, v), nz = bil(rn, u, v);
    if (isNaN(mz) || isNaN(nz) || Math.abs(mz - nz) > 10) continue;
    pts.push([mz, binOld[rr * M + cc] / 255 * hmaxOld]);
  }
  let ax = 0, ay = 0, axx = 0, axy = 0;
  for (const [x, y] of pts) { ax += x; ay += y; axx += x * x; axy += x * y; }
  const n = pts.length;
  const a = (n * axy - ax * ay) / (n * axx - ax * ax || 1e-9);
  const b = (ay - a * ax) / n;
  let ssr = 0, sst = 0; const my = ay / n;
  for (const [x, y] of pts) { const f = a * x + b; ssr += (y - f) ** 2; sst += (y - my) ** 2; }
  console.log(`${mapName} Z: escala=${a.toFixed(6)} offset=${b.toFixed(3)} R2=${(1 - ssr / sst).toFixed(4)} (n=${n})`);
  resultado[mapName] = { dx: +best.dx.toFixed(3), dy: +best.dy.toFixed(3), sx: +best.sx.toFixed(4), sy: +best.sy.toFixed(4), flipX: best.flipX, flipY: best.flipY, escalaZ: +a.toFixed(6), offsetZ: +b.toFixed(3), R2: +(1 - ssr / sst).toFixed(4), casamentoParedes: +best.s.toFixed(4) };
  fs.writeFileSync(path.join(OUT, `fit-${mapName}.json`), JSON.stringify(resultado[mapName], null, 2));
}
console.log('fits atualizados pelo teste de paredes.');
