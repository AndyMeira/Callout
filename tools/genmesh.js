/* genmesh.js — tabelas de altura 256×256 a partir da GEOMETRIA REAL do mapa
   (arquivos .mesh AWMH extraídos do CS2 pelo projeto awpy-data).
   Para cada célula do jogo, lança um raio vertical de cima pra baixo na malha
   real e pega a superfície: escadas, plataformas e rampas com altura EXATA.
   Correção de teto: onde a malha tem andar de cima sobre pisos (nav cobre e a
   malha acerta o teto em vez do chão), usa o piso do nav. Sem suavização —
   a malha é exata, só quantização. Calibração: transformação ajustada contra
   as coordenadas do jogo (tools/out/fit-<mapa>.json, mesmo espaço da malha).
   Uso: node tools/genmesh.js [--patch]                                        */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- .mesh AWMH ---------- */
function parseMesh(buf) {
  if (buf.readUInt32LE(0) !== 0x484D5741 /* 'AWMH' little-endian */) throw new Error('magico AWMH invalido');
  const version = buf.readUInt32LE(4);
  const nV = buf.readUInt32LE(8), nF = buf.readUInt32LE(12);
  const vOff = 16, fOff = vOff + nV * 12;
  const verts = new Float32Array(buf.buffer, buf.byteOffset + vOff, nV * 3);
  const faces = new Uint32Array(buf.buffer, buf.byteOffset + fOff, nF * 3);
  if (fOff + nF * 12 !== buf.length) throw new Error(`tamanho inesperado: corpo=${fOff + nF * 12} arquivo=${buf.length}`);
  return { version, nV, nF, verts, faces };
}

/* ---------- raio vertical: ponto (x,y) dentro do triângulo projetado → z ---------- */
function triZ(v, a, b, c, x, y) {
  const ax = v[a * 3], ay = v[a * 3 + 1];
  const bx = v[b * 3], by = v[b * 3 + 1];
  const cx = v[c * 3], cy = v[c * 3 + 1];
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
  if (Math.abs(d) < 1e-9) return null;
  const l1 = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d;
  const l2 = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d;
  const l3 = 1 - l1 - l2;
  if (l1 < -1e-6 || l2 < -1e-6 || l3 < -1e-6) return null;
  return l1 * v[a * 3 + 2] + l2 * v[b * 3 + 2] + l3 * v[c * 3 + 2];
}

/* ---------- bins espaciais dos triângulos ---------- */
function buildBins(mesh, minX, maxX, minY, maxY, K) {
  const bins = new Map();
  const { verts, faces } = mesh;
  for (let f = 0; f < faces.length; f += 3) {
    const a = faces[f], b = faces[f + 1], c = faces[f + 2];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const i of [a, b, c]) {
      const X = verts[i * 3], Y = verts[i * 3 + 1];
      if (X < x0) x0 = X; if (X > x1) x1 = X;
      if (Y < y0) y0 = Y; if (Y > y1) y1 = Y;
    }
    const bx0 = Math.max(0, Math.floor((x0 - minX) / (maxX - minX) * K));
    const bx1 = Math.min(K - 1, Math.floor((x1 - minX) / (maxX - minX) * K));
    const by0 = Math.max(0, Math.floor((y0 - minY) / (maxY - minY) * K));
    const by1 = Math.min(K - 1, Math.floor((y1 - minY) / (maxY - minY) * K));
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const k = by * K + bx;
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(f);
    }
  }
  return bins;
}

/* ---------- raster dos pisos do nav (para corrigir células sob teto) ---------- */
function navFloorRaster(navPath, K, minX, maxX, minY, maxY) {
  const src = fs.readFileSync(path.join(__dirname, 'gennav.js'), 'utf8');
  const cut = src.indexOf('/* ---------- principal ---------- */');
  const lib = src.slice(0, cut).replace(/'use strict';/, '');
  const api = new Function('require', lib + '\n; return { parseNav, containsXY, idwZ };')(require);
  const nav = api.parseNav(fs.readFileSync(navPath));
  const rast = new Float32Array(K * K).fill(NaN);
  const bins = new Map();
  for (let ai = 0; ai < nav.areas.length; ai++) {
    const a = nav.areas[ai];
    let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (const c of a.corners) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
    const bx0 = Math.max(0, Math.floor((x0 - minX) / (maxX - minX) * K)), bx1 = Math.min(K - 1, Math.floor((x1 - minX) / (maxX - minX) * K));
    const by0 = Math.max(0, Math.floor((y0 - minY) / (maxY - minY) * K)), by1 = Math.min(K - 1, Math.floor((y1 - minY) / (maxY - minY) * K));
    for (let by = by0; by <= by1; by++) for (let bx = bx0; bx <= bx1; bx++) {
      const k = by * K + bx;
      if (!bins.has(k)) bins.set(k, []);
      bins.get(k).push(ai);
    }
  }
  for (let by = 0; by < K; by++) for (let bx = 0; bx < K; bx++) {
    const x = minX + (bx + .5) / K * (maxX - minX), y = minY + (by + .5) / K * (maxY - minY);
    let zmin = Infinity;
    for (const ai of bins.get(by * K + bx) || []) {
      const a = nav.areas[ai];
      if (api.containsXY(a.corners, x, y)) { const z = api.idwZ(a.corners, x, y); if (z < zmin) zmin = z; }
    }
    if (zmin < Infinity) rast[by * K + bx] = zmin;
  }
  return { rast, K };
}

/* ---------- principal ---------- */
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const HALF = 76.8, SPAN = 153.6, N = 256, KB = 1024;

function readOldTable(html, mapName) {
  let m;
  if (mapName === 'mirage') m = /ht:"([A-Za-z0-9+/=]+)",hmax:([\d.]+)/.exec(html);
  else m = /const B64=IS_MIR\?MIRAGE\.ht:'([A-Za-z0-9+/=]+)'.*?HMAX=IS_MIR\?MIRAGE\.hmax:([\d.]+)/s.exec(html);
  if (!m) throw new Error('tabela antiga de ' + mapName + ' nao encontrada');
  const bin = Buffer.from(m[1], 'base64');
  const M = Math.sqrt(bin.length) | 0;
  return { M, hmax: parseFloat(m[2]), get: (c, r) => bin[r * M + c] / 255 * parseFloat(m[2]) };
}

const results = {};
for (const mapName of ['dust2', 'mirage']) {
  const fit = JSON.parse(fs.readFileSync(path.join(OUT, `fit-${mapName}.json`), 'utf8'));
  const mesh = parseMesh(fs.readFileSync(path.join(__dirname, 'mesh', `de_${mapName}.mesh`)));
  // limites do mesh
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (let i = 0; i < mesh.nV * 3; i += 3) {
    const X = mesh.verts[i], Y = mesh.verts[i + 1];
    if (X < minX) minX = X; if (X > maxX) maxX = X;
    if (Y < minY) minY = Y; if (Y > maxY) maxY = Y;
  }
  const bins = buildBins(mesh, minX, maxX, minY, maxY, KB);
  const nav = navFloorRaster(path.join(__dirname, 'nav', `de_${mapName}.nav`), KB, minX, maxX, minY, maxY);
  const old = readOldTable(html, mapName);
  const oldAt = (gx, gz) => {
    const fc = Math.max(0, Math.min(old.M - 1, (gx + HALF) / SPAN * old.M - .5));
    const fr = Math.max(0, Math.min(old.M - 1, (gz + HALF) / SPAN * old.M - .5));
    const c0 = Math.floor(fc), r0 = Math.floor(fr), tc = fc - c0, tr = fr - r0;
    const c1 = Math.min(old.M - 1, c0 + 1), r1 = Math.min(old.M - 1, r0 + 1);
    return old.get(c0, r0) * (1 - tc) * (1 - tr) + old.get(c1, r0) * tc * (1 - tr) + old.get(c0, r1) * (1 - tc) * tr + old.get(c1, r1) * tc * tr;
  };
  // mapeamento: modo radar (oficial) ou fit por otimização
  const isRadar = fit.modo === 'radar';
  const W = isRadar ? 1024 * fit.scale : 0;
  const rx0 = isRadar ? fit.pos_x : 0, ry1 = isRadar ? fit.pos_y : 0;
  const toWorld = (gx, gz) => {
    if (isRadar) {
      const u = (gx + HALF) / SPAN, v = (gz + HALF) / SPAN;
      return { x: rx0 + u * W, y: ry1 - v * W };
    }
    let u = (gx - fit.dx) / (SPAN * fit.sx) + .5, v = (gz - fit.dy) / (SPAN * fit.sy) + .5;
    if (fit.flipX) u = 1 - u; if (fit.flipY) v = 1 - v;
    if (u < 0 || u > 1 || v < 0 || v > 1) return null;
    return { x: minX + u * (maxX - minX), y: minY + v * (maxY - minY) };
  };
  // passada 1: altura absoluta de cada célula
  const hs = new Float32Array(N * N);
  let hits = 0, correcoesTeto = 0, hmax = 0;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const gx = (c + .5) / N * SPAN - HALF, gz = (r + .5) / N * SPAN - HALF;
    const w = toWorld(gx, gz);
    let h;
    if (!w) h = oldAt(gx, gz);
    else {
      const mx = w.x, my = w.y;
      const bkx = Math.min(KB - 1, Math.max(0, Math.floor((mx - minX) / (maxX - minX) * KB)));
      const bky = Math.min(KB - 1, Math.max(0, Math.floor((my - minY) / (maxY - minY) * KB)));
      const k = bky * KB + bkx;
      // raio vertical: maior z dos triângulos que cobrem o ponto
      let top = -Infinity;
      for (const f of bins.get(k) || []) {
        const z = triZ(mesh.verts, mesh.faces[f], mesh.faces[f + 1], mesh.faces[f + 2], mx, my);
        if (z !== null && z > top) top = z;
      }
      const navZ = nav.rast[k];
      if (!isNaN(navZ)) {
        // célula ANDÁVEL: piso exato da malha; se a malha acertou um teto
        // (andar de cima), cai para o piso do nav
        let z;
        if (top > -Infinity && (top - navZ) * fit.escalaZ <= 0.6) z = top;
        else { z = navZ; if (top > -Infinity) correcoesTeto++; }
        h = fit.escalaZ * z + fit.offsetZ;
        hits++;
      } else h = oldAt(gx, gz); // parede/vazio: mantém o valor antigo (BFS do jogo lixa o render)
    }
    hs[r * N + c] = h;
    if (h > hmax) hmax = h;
  }
  // passada 2: quantiza com âncora no relevo JOGÁVEL (hmax antigo + folga).
  // O topo da malha inclui prédios/telas altos fora da área jogável; esses
  // valores só afetam células de parede, que o jogo re-lixava via BFS de
  // qualquer forma. O clamp preserva a precisão do chão onde importa.
  const hmaxQ = old.hmax + .15;
  const out = Buffer.alloc(N * N);
  for (let i = 0; i < N * N; i++) out[i] = Math.max(0, Math.min(255, Math.round(hs[i] / hmaxQ * 255)));
  fs.writeFileSync(path.join(OUT, `hm-${mapName}.b64`), out.toString('base64'));
  results[mapName] = {
    nVerts: mesh.nV, nFaces: mesh.nF,
    coberturaMalha: +(hits / (N * N) * 100).toFixed(1) + '%',
    correcoesTeto,
    hmaxQuantizado: +hmaxQ.toFixed(4), hmaxBruto: +hmax.toFixed(2), hmaxAntigo: old.hmax,
    celulasAcimaDoRelevo: +(hs.filter(h => h > hmaxQ).length)
  };
}
console.log(JSON.stringify(results, null, 2));
fs.writeFileSync(path.join(OUT, 'meshstats.json'), JSON.stringify(results, null, 2));

/* ---------- injeção no index.html (--patch) ---------- */
if (process.argv.includes('--patch')) {
  let out = html;
  for (const mapName of ['dust2', 'mirage']) {
    const b64 = fs.readFileSync(path.join(OUT, `hm-${mapName}.b64`), 'utf8');
    const hmax = results[mapName].hmaxQuantizado.toFixed(4);
    if (mapName === 'dust2') {
      out = out.replace(/const B64=IS_MIR\?MIRAGE\.ht:'[A-Za-z0-9+/=]+'/, `const B64=IS_MIR?MIRAGE.ht:'${b64}'`);
      out = out.replace(/HMAX=IS_MIR\?MIRAGE\.hmax:[\d.]+/, `HMAX=IS_MIR?MIRAGE.hmax:${hmax}`);
    } else {
      out = out.replace(/ht:"[A-Za-z0-9+/=]+",hmax:[\d.]+/, `ht:"${b64}",hmax:${hmax}`);
    }
  }
  const loaderAntigo = /const bin=atob\(B64\),M=128,q=new Float32Array\(M\*M\);[\s\S]*?\}\)\(\);/;
  const loaderNovo = `const bin=atob(B64);\n  for(let i=0;i<N*N;i++)HT[i]=bin.charCodeAt(i)/255*HMAX;\n})();`;
  if (!loaderAntigo.test(out)) throw new Error('loader do HT nao encontrado para substituir');
  out = out.replace(loaderAntigo, loaderNovo);
  fs.writeFileSync(path.join(ROOT, 'index.html'), out);
  console.log('index.html atualizado: alturas da GEOMETRIA REAL do CS2 (malha AWMH).');
}
