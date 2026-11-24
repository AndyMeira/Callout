/* packmesh.js — empacota a malha AWMH oficial para o jogo:
   quantiza vértices em int16 + faces u32 + header com os limites,
   comprime com deflate-raw (o jogo descomprime com DecompressionStream).
   Saída: geo-<mapa>.bin na raiz do projeto (servido junto com o jogo). */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const RADAR = {
  dust2: { pos_x: -2476, pos_y: 3239, scale: 4.4 },
  mirage: { pos_x: -3230, pos_y: 1713, scale: 5.0 }
};
for (const mapName of ['dust2', 'mirage']) {
  const buf = fs.readFileSync(path.join(__dirname, 'mesh', `de_${mapName}.mesh`));
  const nV = buf.readUInt32LE(8), nF = buf.readUInt32LE(12);
  const verts = new Float32Array(buf.buffer, buf.byteOffset + 16, nV * 3);
  const faces = new Uint32Array(buf.buffer, buf.byteOffset + 16 + nV * 12, nF * 3);
  // limites reais do mesh (pra quantizar int16)
  let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, z0 = 1e9, z1 = -1e9;
  for (let i = 0; i < nV * 3; i += 3) {
    const X = verts[i], Y = verts[i + 1], Z = verts[i + 2];
    if (X < x0) x0 = X; if (X > x1) x1 = X; if (Y < y0) y0 = Y; if (Y > y1) y1 = Y; if (Z < z0) z0 = Z; if (Z > z1) z1 = Z;
  }
  // margem de segurança nos limites
  const pad = 16;
  x0 -= pad; x1 += pad; y0 -= pad; y1 += pad; z0 -= pad; z1 += pad;
  const sc = [(x1 - x0) / 65535, (y1 - y0) / 65535, (z1 - z0) / 65535];
  const q = new Int16Array(nV * 3);
  for (let i = 0; i < nV * 3; i += 3) {
    q[i] = Math.round((verts[i] - x0) / sc[0]);
    q[i + 1] = Math.round((verts[i + 1] - y0) / sc[1]);
    q[i + 2] = Math.round((verts[i + 2] - z0) / sc[2]);
  }
  // header: magic AWGQ + nV + nF + 6 doubles de limites
  const head = Buffer.alloc(60);
  head.write('AWGQ', 0, 'ascii');
  head.writeUInt32LE(nV, 4);
  head.writeUInt32LE(nF, 8);
  const dv = new DataView(head.buffer);
  [x0, x1, y0, y1, z0, z1].forEach((v, i) => dv.setFloat64(12 + i * 8, v, true));
  // alinhamento: faces (u32) comecam em multiplo de 4 apos os vertices (i16)
  const padAl = (4 - (nV * 6) % 4) % 4;
  const corpo = Buffer.concat([Buffer.from(q.buffer, q.byteOffset, q.byteLength), Buffer.alloc(padAl), Buffer.from(faces.buffer, faces.byteOffset, faces.byteLength)]);
  const comp = zlib.deflateRawSync(corpo, { level: 9 });
  const out = Buffer.concat([head, comp]);
  const dest = path.join(__dirname, '..', `geo-${mapName}.bin`);
  fs.writeFileSync(dest, out);
  console.log(`${mapName}: verts=${nV} faces=${nF} bruto=${(corpo.length / 1048576).toFixed(2)}MB comprimido=${(out.length / 1048576).toFixed(2)}MB -> ${dest}`);
}
