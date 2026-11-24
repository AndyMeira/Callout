/* debug-cal.js — procura a melhor calibracao para um mapa testando
   orientacoes (flip x/y, troca de eixos) e recortes dos limites do nav */
'use strict';
const fs = require('fs');
const path = require('path');
const gennav = { R: null };
// reutiliza as funcoes do gennav.js sem executar o main: le o arquivo e remove a parte main
const src = fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8');
const cut = src.indexOf('/* ---------- principal ---------- */');
const lib = src.slice(0, cut).replace(/'use strict';/, '');
const api = new Function('require', lib + '\n; return { parseNav, containsXY, idwZ, readOldTable };')(require);
const { parseNav, containsXY, idwZ, readOldTable } = api;

const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const mapName = process.argv[2] || 'mirage';
const nav = parseNav(fs.readFileSync(path.join(__dirname, 'nav', `de_${mapName}.nav`)));
const old = readOldTable(html, mapName);

// limites com recorte percentual
function bounds(areas, trim) {
  const xs = [], ys = [];
  for (const a of areas) for (const c of a.corners) { xs.push(c[0]); ys.push(c[1]); }
  xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
  const q = (arr, p) => arr[Math.floor(p * (arr.length - 1))];
  return { minX: q(xs, trim), maxX: q(xs, 1 - trim), minY: q(ys, trim), maxY: q(ys, 1 - trim) };
}

const HALF = 76.8, SPAN = 153.6;
const rows = [];
for (const trim of [0, 0.002, 0.005, 0.01, 0.02]) {
  const B = bounds(nav.areas, trim);
  for (const swap of [false, true]) for (const flipX of [false, true]) for (const flipY of [false, true]) {
    const pts = [];
    for (let r = 0; r < old.M; r += 1) for (let c = 0; c < old.M; c += 1) {
      const gx = (c + .5) / old.M * SPAN - HALF;
      const gz = (r + .5) / old.M * SPAN - HALF;
      const u = (gx + HALF) / SPAN, v = (gz + HALF) / SPAN;
      let nx, ny;
      if (swap) { nx = flipX ? B.maxY - v * (B.maxY - B.minY) : B.minY + v * (B.maxY - B.minY); ny = flipX ? B.maxX - u * (B.maxX - B.minX) : B.minX + u * (B.maxX - B.minX); }
      else { nx = flipX ? B.maxX - u * (B.maxX - B.minX) : B.minX + u * (B.maxX - B.minX); ny = flipY ? B.maxY - v * (B.maxY - B.minY) : B.minY + v * (B.maxY - B.minY); }
      let hits = [];
      for (const a of nav.areas) if (containsXY(a.corners, nx, ny)) hits.push(idwZ(a.corners, nx, ny));
      if (!hits.length) continue;
      pts.push({ old: old.get(c, r), nz: Math.min(...hits) });
    }
    if (pts.length < 2000) continue;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = pts.length;
    for (const p of pts) { sx += p.nz; sy += p.old; sxx += p.nz * p.nz; sxy += p.nz * p.old; }
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1e-9);
    const b = (sy - a * sx) / n;
    let ssr = 0, sst = 0;
    for (const p of pts) { const f = a * p.nz + b; ssr += (p.old - f) ** 2; sst += (p.old - sy / n) ** 2; }
    rows.push({ trim, swap, flipX, flipY, R2: +(1 - ssr / sst).toFixed(4), n, a: +a.toFixed(4), b: +b.toFixed(1) });
  }
}
rows.sort((x, y) => y.R2 - x.R2);
console.table(rows.slice(0, 12));
