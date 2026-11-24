/* gennav.js — regenera as tabelas de altura do jogo (HT 256×256) a partir dos
   .nav oficiais do CS2 (build atual, via awpy-data). Pipeline:
     1. parser do formato nav v30–36 (Source 2, com pulo dos blocos KV3)
     2. calibração automática: ajusta transform nav→jogo contra a tabela antiga
        de 128 (R² medido; prova que as coordenadas do jogo ficam intactas)
     3. amostragem 256×256 com interpolacao IDW dentro de cada polígono;
        células sem cobertura do nav herdam o valor antigo (bilinear)
     4. emite B64 + HMAX calibrado em tools/out/ e (com --patch) injeta no index.html
   Uso: node tools/gennav.js [--patch]                                    */
'use strict';
const fs = require('fs');
const path = require('path');

/* ---------- leitor little-endian ---------- */
class R {
  constructor(buf) { this.b = buf; this.p = 0; }
  take(n) { if (this.p + n > this.b.length) throw new Error('fim de dados inesperado @' + this.p); const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
  u8() { return this.take(1)[0]; }
  u32() { return this.take(4).readUInt32LE(0); }
  i32() { return this.take(4).readInt32LE(0); }
  i64() { return this.take(8).readBigInt64LE(0); }
  f32() { return this.take(4).readFloatLE(0); }
  vec3() { return [this.f32(), this.f32(), this.f32()]; }
  skip(n) { this.take(n); }
  align8() { this.skip((8 - this.p % 8) % 8); }
  cstring() { while (this.u8() !== 0) {} }
}

/* ---------- pulo do bloco KV3 (nav v36) — segue o layout do awpy ---------- */
function skipKV3(r) {
  r.align8();
  const magic = r.u32();
  if (magic === 0x03564B56) throw new Error('KV3 v0 nao suportado');
  const ver = magic & 0xFF;
  if ((magic & 0xFFFFFF00) !== 0x4B563300 || ver < 1 || ver > 5) throw new Error('KV3 magico desconhecido: 0x' + magic.toString(16));
  if (ver === 1) throw new Error('KV3 v1 nao suportado');
  r.skip(16);                       // GUID de formato
  const method = r.u32();           // 0=sem compressao
  r.skip(2 + 2);                    // dic. compressao + tamanho de quadro
  r.skip(4 * 4);                    // countBytes1/4/8 + countTypes
  r.skip(2 + 2);                    // countObjects + countArrays
  const sizeUnc = r.i32(), sizeCmp = r.i32(), nBlocks = r.i32(), nBlobs = r.i32();
  if (method > 2) throw new Error('compressao KV3 ' + method);
  if (nBlocks || nBlobs) throw new Error('KV3 com blocks/blobs nao suportado');
  let sizeBlockCmp = 0;
  if (ver >= 4) { r.skip(4); sizeBlockCmp = r.i32(); }
  let unc1, cmp1, unc2, cmp2;
  if (ver >= 5) { unc1 = r.i32(); cmp1 = r.i32(); unc2 = r.i32(); cmp2 = r.i32(); r.skip(32); }
  else { unc1 = sizeUnc; cmp1 = sizeCmp; unc2 = 0; cmp2 = 0; }
  const od = (u, c) => (method === 0 ? u : c);
  r.skip(od(unc1, cmp1) + od(unc2, cmp2) + sizeBlockCmp);
}

/* ---------- parser do nav ---------- */
function parseNav(buf) {
  const r = new R(buf);
  if (r.u32() !== 0xFEEDFACE) throw new Error('magico invalido');
  const version = r.u32();
  if (version < 30 || version > 36) throw new Error('versao nav nao suportada: ' + version);
  const subVersion = r.u32();
  const unk1 = r.u32();
  if (version >= 36) skipKV3(r);
  let polygons = null;
  if (version >= 31) {
    const nCorners = r.u32();
    const corners = [];
    for (let i = 0; i < nCorners; i++) corners.push(r.vec3());
    const nPolys = r.u32();
    polygons = [];
    for (let i = 0; i < nPolys; i++) {
      const n = r.u8();
      const poly = [];
      for (let k = 0; k < n; k++) {
        const ci = r.u32();
        if (ci >= corners.length) throw new Error('indice de canto fora do range');
        poly.push(corners[ci]);
      }
      if (version >= 35) r.skip(4);
      polygons.push(poly);
    }
  }
  if (version >= 32) r.skip(4);
  if (version >= 35) {
    const count = r.u32();
    for (let i = 0; i < count; i++) { r.cstring(); r.skip(48); }
  }
  if (version >= 36) skipKV3(r);
  const areaCount = r.u32();
  const areas = [];
  for (let i = 0; i < areaCount; i++) {
    const id = r.u32();
    r.i64();                       // flags dinamicas
    r.u8();                        // hull
    let corners;
    if (version >= 31) {
      const pi = r.u32();
      if (!polygons || pi >= polygons.length) throw new Error('indice de poligono fora do range');
      corners = polygons[pi];
    } else {
      const n = r.u32();
      corners = [];
      for (let k = 0; k < n; k++) corners.push(r.vec3());
    }
    r.skip(4);
    for (let e = 0; e < corners.length; e++) {
      const n = r.u32();
      for (let k = 0; k < n; k++) { r.u32(); r.u32(); }
    }
    r.skip(5);
    for (const q of [0, 0]) { const n = r.u32(); for (let k = 0; k < n; k++) r.u32(); } // escadas acima/abaixo
    areas.push({ id, corners });
  }
  return { version, subVersion, analyzed: !!(unk1 & 1), areas, bytes: r.p };
}

/* ---------- geometria ---------- */
function containsXY(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
    if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function idwZ(poly, x, y) { // altura no ponto via ponderacao inversa a distancia dos cantos
  let s = 0, w = 0;
  for (const c of poly) {
    const d2 = (c[0] - x) * (c[0] - x) + (c[1] - y) * (c[1] - y) + 1e-6;
    const wi = 1 / (d2 * d2);
    s += wi * c[2]; w += wi;
  }
  return s / w;
}

/* ---------- tabela antiga (calibração) ---------- */
function readOldTable(html, mapName) {
  let m;
  if (mapName === 'mirage') m = /ht:"([A-Za-z0-9+/=]+)",hmax:([\d.]+)/.exec(html);
  else m = /const B64=IS_MIR\?MIRAGE\.ht:'([A-Za-z0-9+/=]+)'.*?HMAX=IS_MIR\?MIRAGE\.hmax:([\d.]+)/s.exec(html);
  if (!m) throw new Error('tabela antiga de ' + mapName + ' nao encontrada no index.html');
  const bin = Buffer.from(m[1], 'base64');
  const M = Math.sqrt(bin.length) | 0;
  return { M, hmax: parseFloat(m[2]), get: (c, r) => bin[r * M + c] / 255 * parseFloat(m[2]) };
}

/* ---------- calibração: tenta orientações e escolhe a de melhor R² ---------- */
function calibrate(areas, old) {
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const a of areas) for (const c of a.corners) {
    if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
  }
  const HALF = 76.8, SPAN = 153.6;
  let best = null;
  for (const flipX of [false, true]) for (const flipY of [false, true]) {
    // amostra na grade antiga (128), comparando onde o nav cobre
    const pts = [];
    for (let r = 0; r < old.M; r++) for (let c = 0; c < old.M; c++) {
      const gx = (c + .5) / old.M * SPAN - HALF;
      const gz = (r + .5) / old.M * SPAN - HALF;
      const u = (gx + HALF) / SPAN, v = (gz + HALF) / SPAN;
      const nx = flipX ? maxX - u * (maxX - minX) : minX + u * (maxX - minX);
      const ny = flipY ? maxY - v * (maxY - minY) : minY + v * (maxY - minY);
      let hits = [];
      for (const a of areas) if (containsXY(a.corners, nx, ny)) hits.push(idwZ(a.corners, nx, ny));
      if (!hits.length) continue;
      const nz = Math.min(...hits); // piso
      pts.push({ old: old.get(c, r), nz });
    }
    if (pts.length < 2000) continue;
    // regressão linear z_jogo = a * z_nav + b
    let sx = 0, sy = 0, sxx = 0, sxy = 0, n = pts.length;
    for (const p of pts) { sx += p.nz; sy += p.old; sxx += p.nz * p.nz; sxy += p.nz * p.old; }
    const a = (n * sxy - sx * sy) / (n * sxx - sx * sx || 1e-9);
    const b = (sy - a * sx) / n;
    let ssr = 0, sst = 0;
    for (const p of pts) { const f = a * p.nz + b; ssr += (p.old - f) ** 2; sst += (p.old - sy / n) ** 2; }
    const r2 = 1 - ssr / sst;
    if (!best || r2 > best.r2) best = { flipX, flipY, a, b, r2, n, minX, maxX, minY, maxY };
  }
  return best;
}

/* ---------- transformação calibrada (tools/out/fit-<mapa>.json do fit-opt.js) ---------- */
function loadFit(mapName) {
  const f = JSON.parse(fs.readFileSync(path.join(__dirname, 'out', `fit-${mapName}.json`), 'utf8'));
  return {
    ...f,
    toNav(gx, gz) {
      let u = (gx - f.dx) / (153.6 * f.sx) + .5, v = (gz - f.dy) / (153.6 * f.sy) + .5;
      if (f.flipX) u = 1 - u;
      if (f.flipY) v = 1 - v;
      return { u, v };
    }
  };
}

/* ---------- geração 256×256 ---------- */
function build(areas, navBounds, cal, old) {
  const N = 256, HALF = 76.8, SPAN = 153.6;
  const oldAt = (gx, gz) => {
    const fc = Math.max(0, Math.min(old.M - 1, (gx + HALF) / SPAN * old.M - .5));
    const fr = Math.max(0, Math.min(old.M - 1, (gz + HALF) / SPAN * old.M - .5));
    const c0 = Math.floor(fc), r0 = Math.floor(fr), tc = fc - c0, tr = fr - r0;
    const c1 = Math.min(old.M - 1, c0 + 1), r1 = Math.min(old.M - 1, r0 + 1);
    return old.get(c0, r0) * (1 - tc) * (1 - tr) + old.get(c1, r0) * tc * (1 - tr) + old.get(c0, r1) * (1 - tc) * tr + old.get(c1, r1) * tc * tr;
  };
  const out = Buffer.alloc(N * N);
  let hmax = 0, covered = 0;
  const B = navBounds;
  for (let r = 0; r < N; r++) for (let c = 0; c < N; c++) {
    const gx = (c + .5) / N * SPAN - HALF, gz = (r + .5) / N * SPAN - HALF;
    const { u, v } = cal.toNav(gx, gz);
    let h;
    if (u < 0 || u > 1 || v < 0 || v > 1) h = oldAt(gx, gz);
    else {
      const nx = B.minX + u * (B.maxX - B.minX), ny = B.minY + v * (B.maxY - B.minY);
      let hits = [];
      for (const a of areas) if (containsXY(a.corners, nx, ny)) hits.push(cal.escalaZ * idwZ(a.corners, nx, ny) + cal.offsetZ);
      if (hits.length) {
        covered++;
        const ref = oldAt(gx, gz);
        h = hits.reduce((p, q) => Math.abs(q - ref) < Math.abs(p - ref) ? q : p, hits[0]);
      } else h = oldAt(gx, gz);
    }
    if (h > hmax) hmax = h;
    out[r * N + c] = Math.max(0, Math.min(255, Math.round(h / hmax * 255)));
  }
  return { bytes: out, hmax, covered: covered / (N * N) };
}

/* ---------- principal ---------- */
const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const OUT = path.join(__dirname, 'out');
fs.mkdirSync(OUT, { recursive: true });
const results = {};
for (const mapName of ['dust2', 'mirage']) {
  const nav = parseNav(fs.readFileSync(path.join(__dirname, 'nav', `de_${mapName}.nav`)));
  const old = readOldTable(html, mapName);
  const cal = loadFit(mapName);
  let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9;
  for (const a of nav.areas) for (const c of a.corners) {
    if (c[0] < minX) minX = c[0]; if (c[0] > maxX) maxX = c[0];
    if (c[1] < minY) minY = c[1]; if (c[1] > maxY) maxY = c[1];
  }
  const { bytes, hmax, covered } = build(nav.areas, { minX, maxX, minY, maxY }, cal, old);
  fs.writeFileSync(path.join(OUT, `ht-${mapName}.b64`), bytes.toString('base64'));
  results[mapName] = {
    navVersion: nav.version, areas: nav.areas.length,
    calibracao: { R2: cal.R2, flipX: cal.flipX, flipY: cal.flipY, dx: cal.dx, dy: cal.dy, sx: cal.sx, sy: cal.sy, escalaZ: cal.escalaZ, offsetZ: cal.offsetZ },
    hmaxNovo: +hmax.toFixed(4), hmaxAntigo: old.hmax, coberturaNav: +(covered * 100).toFixed(1) + '%'
  };
}
fs.writeFileSync(path.join(OUT, 'resumo.json'), JSON.stringify(results, null, 2));
console.log(JSON.stringify(results, null, 2));

/* ---------- injeção no index.html (--patch) ---------- */
if (process.argv.includes('--patch')) {
  let out = html;
  for (const mapName of ['dust2', 'mirage']) {
    const b64 = fs.readFileSync(path.join(OUT, `ht-${mapName}.b64`), 'utf8');
    const hmax = results[mapName].hmaxNovo.toFixed(4);
    if (mapName === 'dust2') {
      out = out.replace(/const B64=IS_MIR\?MIRAGE\.ht:'[A-Za-z0-9+/=]+'/, `const B64=IS_MIR?MIRAGE.ht:'${b64}'`);
      out = out.replace(/HMAX=IS_MIR\?MIRAGE\.hmax:[\d.]+/, `HMAX=IS_MIR?MIRAGE.hmax:${hmax}`);
    } else {
      out = out.replace(/ht:"[A-Za-z0-9+/=]+",hmax:[\d.]+/, `ht:"${b64}",hmax:${hmax}`);
    }
  }
  // loader: tabela agora é nativa 256×256 — preenchimento direto, sem upsample bilinear
  const loaderAntigo = /const bin=atob\(B64\),M=128,q=new Float32Array\(M\*M\);[\s\S]*?\}\)\(\);/;
  const loaderNovo = `const bin=atob(B64);\n  for(let i=0;i<N*N;i++)HT[i]=bin.charCodeAt(i)/255*HMAX;\n})();`;
  if (!loaderAntigo.test(out)) throw new Error('loader do HT nao encontrado para substituir');
  out = out.replace(loaderAntigo, loaderNovo);
  fs.writeFileSync(path.join(ROOT, 'index.html'), out);
  console.log('index.html atualizado com as tabelas nativas 256x256.');
}
