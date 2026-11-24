/* testa 8 interpretacoes do grid de paredes sob os dois fits conhecidos */
'use strict';
const fs = require('fs');
const path = require('path');
const fitMeshSrc = fs.readFileSync(path.join(__dirname, 'fit-mesh.js'), 'utf8');
const lib = fitMeshSrc.slice(0, fitMeshSrc.indexOf('const OUT =')).replace(/'use strict';/, '');
const api = new Function('require', '__dirname', lib + '\n; return { parseMesh, rasterTop, rasterNavFloor, bil };')(require, __dirname);
const navApi = new Function('require', '__dirname', fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8').slice(0, fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8').indexOf('/* ---------- calibra')).replace(/'use strict';/, '') + '\n; return { parseNav };')(require, __dirname);
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const HALF = 76.8, SPAN = 153.6, K = 512;

function readRows(mapName) {
  let m;
  if (mapName === 'mirage') m = /MIRAGE=\{\s*rows:\[([\s\S]*?)\]/.exec(html);
  else m = /const MAPROWS=IS_MIR\?MIRAGE\.rows:\[([\s\S]*?)\];/.exec(html);
  const rows = []; const re = /"([^"]*)"|'([^']*)'/g; let mm;
  while ((mm = re.exec(m[1]))) rows.push(mm[1] !== undefined ? mm[1] : mm[2]);
  return rows;
}

for (const mapName of ['dust2', 'mirage']) {
  const rows = readRows(mapName);
  const nav = navApi.parseNav(fs.readFileSync(path.join(__dirname, 'nav', `de_${mapName}.nav`)));
  const mesh = api.parseMesh(fs.readFileSync(path.join(__dirname, 'mesh', `de_${mapName}.mesh`)));
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let i = 0; i < mesh.nV * 3; i += 3) { const X = mesh.verts[i], Y = mesh.verts[i + 1]; if (X < minX) minX = X; if (X > maxX) maxX = X; if (Y < minY) minY = Y; if (Y > maxY) maxY = Y; }
  const rm = api.rasterTop(mesh, K, minX, maxX, minY, maxY);
  const rn = api.rasterNavFloor(nav, K, minX, maxX, minY, maxY);
  const GR = rows.length;
  const wall = (c, r) => rows[r][c] === '#';
  // celulas amostradas
  const cells = [];
  for (let r = 0; r < GR; r += 3) for (let c = 0; c < GR; c += 3) cells.push({ c, r, wall: wall(c, r) });
  const fits = {
    velho: mapName === 'dust2' ? { dx: -3, dy: 0, sx: .93, sy: .97, flipX: false, flipY: true } : { dx: 1.5, dy: 3, sx: 1.05, sy: .89, flipX: false, flipY: true },
    novo: JSON.parse(fs.readFileSync(path.join(__dirname, 'out', `fit-${mapName}.json`), 'utf8'))
  };
  const score = (fit, transpose, gxFlip, gzFlip) => {
    let good = 0, n = 0;
    for (const cell of cells) {
      // interpretacao do grid
      let cc = cell.c, rr = cell.r;
      if (gxFlip) cc = GR - 1 - cc;
      if (gzFlip) rr = GR - 1 - rr;
      const gx = ((transpose ? rr : cc) + .5) / GR * SPAN - HALF;
      const gz = ((transpose ? cc : rr) + .5) / GR * SPAN - HALF;
      let u = (gx - fit.dx) / (SPAN * fit.sx) + .5, v = (gz - fit.dy) / (SPAN * fit.sy) + .5;
      if (fit.flipX) u = 1 - u; if (fit.flipY) v = 1 - v;
      if (u < 0 || u > 1 || v < 0 || v > 1) return -1;
      const mz = api.bil(rm, u, v), nz = api.bil(rn, u, v);
      n++;
      if (cell.wall) { if (!isNaN(mz) && (isNaN(nz) || mz - nz > 25)) good++; }
      else { if (!isNaN(mz) && !isNaN(nz) && Math.abs(mz - nz) < 10) good++; }
    }
    return good / n;
  };
  console.log(`=== ${mapName} ===`);
  for (const fn of ['velho', 'novo']) {
    for (const tr of [false, true]) for (const gf of [false, true]) for (const zf of [false, true]) {
      const s = score(fits[fn], tr, gf, zf);
      if (s > 0) console.log(`${fn} transposto=${tr} flipGridX=${gf} flipGridZ=${zf}: ${(s * 100).toFixed(1)}%`);
    }
  }
}
