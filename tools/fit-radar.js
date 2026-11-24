/* fit-radar.js — usa o retângulo OFICIAL do radar (overview pos_x/pos_y/scale)
   como mapeamento exato jogo→mundo e ancora o Z regredindo a tabela antiga
   contra os pisos exatos da malha. Grava fit-<mapa>.json no formato radar. */
'use strict';
const fs = require('fs');
const path = require('path');
const fitMeshSrc = fs.readFileSync(path.join(__dirname, 'fit-mesh.js'), 'utf8');
const lib = fitMeshSrc.slice(0, fitMeshSrc.indexOf('const OUT =')).replace(/'use strict';/, '');
const api = new Function('require', '__dirname', lib + '\n; return { parseMesh, rasterTop, rasterNavFloor, bil };')(require, __dirname);
const navApi = new Function('require', '__dirname', fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8').slice(0, fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8').indexOf('/* ---------- calibra')).replace(/'use strict';/, '') + '\n; return { parseNav };')(require, __dirname);

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const HALF = 76.8, SPAN = 153.6, K = 512;
const OUT = path.join(__dirname, 'out');
const RADAR = {
  dust2: { pos_x: -2476, pos_y: 3239, scale: 4.4 },
  mirage: { pos_x: -3230, pos_y: 1713, scale: 5.0 }
};

for (const mapName of ['dust2', 'mirage']) {
  const { pos_x, pos_y, scale } = RADAR[mapName];
  const W = 1024 * scale;
  const x0 = pos_x, x1 = pos_x + W, y0 = pos_y - W, y1 = pos_y;
  const nav = navApi.parseNav(fs.readFileSync(path.join(__dirname, 'nav', `de_${mapName}.nav`)));
  const mesh = api.parseMesh(fs.readFileSync(path.join(__dirname, 'mesh', `de_${mapName}.mesh`)));
  const rm = api.rasterTop(mesh, K, x0, x1, y0, y1);
  const rn = api.rasterNavFloor(nav, K, x0, x1, y0, y1);
  // amostra: casamento de paredes + âncora Z
  let mRows;
  if (mapName === 'mirage') mRows = /MIRAGE=\{\s*rows:\[([\s\S]*?)\]/.exec(html);
  else mRows = /const MAPROWS=IS_MIR\?MIRAGE\.rows:\[([\s\S]*?)\];/.exec(html);
  const rows = []; { const re = /"([^"]*)"|'([^']*)'/g; let mm; while ((mm = re.exec(mRows[1]))) rows.push(mm[1] !== undefined ? mm[1] : mm[2]); }
  const GR = rows.length;
  const wx = (gx) => x0 + (gx + HALF) / SPAN * W;
  const wy = (gz) => y1 - (gz + HALF) / SPAN * W;
  let wallOk = 0, wallN = 0, floorOk = 0, floorN = 0;
  for (let r = 0; r < GR; r += 2) for (let c = 0; c < GR; c += 2) {
    const gx = (c + .5) / GR * SPAN - HALF, gz = (r + .5) / GR * SPAN - HALF;
    const mz = api.bil(rm, (gx + HALF) / SPAN, (gz + HALF) / SPAN);
    const nz = api.bil(rn, (gx + HALF) / SPAN, (gz + HALF) / SPAN);
    if (rows[r][c] === '#') { wallN++; if (!isNaN(mz) && (isNaN(nz) || mz - nz > 25)) wallOk++; }
    else { floorN++; if (!isNaN(mz) && !isNaN(nz) && Math.abs(mz - nz) < 10) floorOk++; }
  }
  console.log(`${mapName}: paredes casadas=${(wallOk / wallN * 100).toFixed(1)}%  chao casado=${(floorOk / floorN * 100).toFixed(1)}%`);
  // tabela antiga
  let mOld;
  if (mapName === 'mirage') mOld = /ht:"([A-Za-z0-9+/=]+)",hmax:([\d.]+)/.exec(html);
  else mOld = /const B64=IS_MIR\?MIRAGE\.ht:'([A-Za-z0-9+/=]+)'.*?HMAX=IS_MIR\?MIRAGE\.hmax:([\d.]+)/s.exec(html);
  const binOld = Buffer.from(mOld[1], 'base64');
  const M = Math.sqrt(binOld.length) | 0;
  const hmaxOld = parseFloat(mOld[2]);
  // ancora Z por QUANTIS (robusto a caixas/miss locais): distribuição dos valores
  // antigos nas células cobertas vs distribuição dos pisos do nav; reta nos quantis.
  const oldVals = [], navVals = [];
  for (let rr = 0; rr < M; rr++) for (let cc = 0; cc < M; cc++) {
    const gx = (cc + .5) / M * SPAN - HALF, gz = (rr + .5) / M * SPAN - HALF;
    const nz = api.bil(rn, (gx + HALF) / SPAN, (gz + HALF) / SPAN);
    if (isNaN(nz)) continue;
    oldVals.push(binOld[rr * M + cc] / 255 * hmaxOld);
    navVals.push(nz);
  }
  oldVals.sort((x, y) => x - y); navVals.sort((x, y) => x - y);
  const Q = 21;
  let ax = 0, ay = 0, axx = 0, axy = 0, nq = 0;
  for (let i = 0; i < Q; i++) {
    const p = i / (Q - 1);
    const y = oldVals[Math.min(oldVals.length - 1, Math.round(p * (oldVals.length - 1)))];
    const x = navVals[Math.min(navVals.length - 1, Math.round(p * (navVals.length - 1)))];
    ax += x; ay += y; axx += x * x; axy += x * y; nq++;
  }
  const a = (nq * axy - ax * ay) / (nq * axx - ax * ax || 1e-9);
  const b = (ay - a * ax) / nq;
  console.log(`${mapName} Z (quantis): escala=${a.toFixed(6)} offset=${b.toFixed(3)}`);
  const fit = { modo: 'radar', pos_x, pos_y, scale, escalaZ: +a.toFixed(6), offsetZ: +b.toFixed(3), paredesCasadas: +((wallOk / wallN * 100).toFixed(1)) };
  fs.writeFileSync(path.join(OUT, `fit-${mapName}.json`), JSON.stringify(fit, null, 2));
}
console.log('fits radar gravados.');
