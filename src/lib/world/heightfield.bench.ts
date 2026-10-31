/**
 * One-off measurement for blueprint §P1.3: decoding a 2048² heightfield must
 * take ≤ 300 ms on the laptop. Not part of `npm test` (only *.test.ts runs);
 * run by hand with `npx vitest bench --run src/lib/world/heightfield.bench.ts`.
 * The recorded result lives in docs/worlds/WORLD-FORMAT.md ("Decode cost").
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { bench, describe } from 'vitest';
import { Heightfield, decodeHeightDeltas, encodeHeightDeltas } from './heightfield';

const N = 2048;
const q = new Uint16Array(N * N);
for (let r = 0; r < N; r++) {
  for (let c = 0; c < N; c++) {
    // Rolling hills plus fine noise: about as compressible as real terrain.
    const h = 400 + 120 * Math.sin(c / 97) * Math.cos(r / 131) + 30 * Math.sin((c + 3 * r) / 17) + ((c * 7 + r * 13) % 5);
    q[r * N + c] = Math.round(h * 64);
  }
}
const content = encodeHeightDeltas(q, N, N);
const stored = new Uint8Array(gzipSync(content, { level: 9 }));
const contentSha = createHash('sha256').update(content).digest('hex');

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

describe(`heightfield ${N}² decode`, () => {
  bench('u16-delta → Heightfield', () => {
    const data = decodeHeightDeltas(content, N, N);
    new Heightfield({ cols: N, rows: N, cellSize: 10, xMin: 0, yMax: 0, heightOffset: 0, heightScale: 1 / 64 }, data);
  });

  bench('gunzip only (DecompressionStream)', async () => {
    await gunzip(stored);
  });

  bench('SHA-256 only (crypto.subtle)', async () => {
    await crypto.subtle.digest('SHA-256', content as BufferSource);
  });

  bench('full loader path: gunzip + SHA-256 + decode', async () => {
    const raw = await gunzip(stored);
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', raw as BufferSource));
    if (Buffer.from(digest).toString('hex') !== contentSha) throw new Error('hash mismatch');
    const data = decodeHeightDeltas(raw, N, N);
    new Heightfield({ cols: N, rows: N, cellSize: 10, xMin: 0, yMax: 0, heightOffset: 0, heightScale: 1 / 64 }, data);
  });
});
