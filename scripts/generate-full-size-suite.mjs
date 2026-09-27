// Rebuild the shipped, finite shape matrix from the user's existing v235 case catalog.
// This imports shapes, not candidate code or claims of prior correctness.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';

const source = process.argv[2];
if (!source) throw new Error('Usage: node scripts/generate-full-size-suite.mjs <v235_exact.json> [output.json]');
const sourceBytes = readFileSync(source);
const historical = JSON.parse(sourceBytes).cases.map(item => item.shape);
const selected = new Map();
const add = (shape, group, mode = 'random') => {
  const key = shape.join('x');
  if (!selected.has(key)) selected.set(key, { shape, group, mode });
};

// Preserve the four smoke shapes so the new suite contains the old measured points.
for (const shape of [[16, 32, 64], [32, 32, 64], [64, 64, 128], [128, 64, 256]]) add(shape, 'smoke');
for (const shape of [[1, 1, 1], [1, 7, 31], [2, 2, 2], [3, 5, 7], [15, 17, 33], [17, 15, 63]]) {
  add(shape, 'tiny', shape.join() === '2,2,2' ? 'zero-row' : shape.join() === '3,5,7' ? 'all-zero' : 'random');
}
for (const m of [15, 16, 17, 31, 32, 33, 63, 64, 65, 79, 80, 81, 127, 128, 129, 255, 256, 257, 511, 512, 513, 1023, 1024, 1025, 4095, 4096, 4097, 8191, 8192]) add([m, 64, 64], 'm-boundary');
for (const n of [15, 16, 17, 31, 32, 33, 63, 64, 65, 127, 128, 129, 255, 256, 257, 511, 512, 513, 1023, 1024, 1025, 2047, 2048, 2049, 4095, 4096, 4097, 8191, 8192, 8193, 16383, 16384, 16385, 32767, 32768, 32769]) add([16, n, 128], 'n-boundary');
for (const k of [15, 16, 17, 31, 32, 33, 63, 64, 65, 95, 96, 97, 127, 128, 129, 255, 256, 257, 511, 512, 513, 1023, 1024, 1025, 2047, 2048, 2049, 4095, 4096, 4097, 8191, 8192]) add([16, 128, k], 'k-boundary');
for (const shape of [
  [16,128,32], [32,64,32], [128,16,32], [128,128,128], [128,129,128],
  [256,16,64], [1280,2048,128], [4096,2048,64], [80,1024,512],
  [4096,512,160], [4096,2048,256], [64,4096,1024], [256,33,63],
  [511,47,65], [1537,57,97], [4095,61,127], [16,32769,129],
  [8192,17,1024], [4096,1536,1024], [2048,2048,2048], [4096,4096,4096],
  [128,128,8192], [1,4096,4096], [32,16384,256], [256,4096,128],
]) add(shape, 'representative');

// Add diverse existing dimension pairs, preferring inexpensive points on ties.
const bytes = ([m,n,k]) => m*k + n*k + m*n + 8*m + 4*n;
const features = ([m,n,k]) => [`m:${m}`, `n:${n}`, `k:${k}`, `mn:${m}:${n}`, `mk:${m}:${k}`, `nk:${n}:${k}`];
const seen = new Set([...selected.values()].flatMap(item => features(item.shape)));
const candidates = historical.filter(shape => !selected.has(shape.join('x')));
while (selected.size < 192 && candidates.length) {
  candidates.sort((a,b) => {
    const score = shape => features(shape).reduce((sum, feature) => sum + (seen.has(feature) ? 0 : 1), 0);
    return score(b)-score(a) || bytes(a)-bytes(b) || a[0]-b[0] || a[1]-b[1] || a[2]-b[2];
  });
  const shape = candidates.shift();
  add(shape, 'historical');
  for (const feature of features(shape)) seen.add(feature);
}
if (selected.size !== 192) throw new Error('Expected 192 unique shapes');
const totalBytes = [...selected.values()].reduce((sum, item) => sum + bytes(item.shape), 0);
if (totalBytes > 256 * 2**20) throw new Error('Suite exceeds the 256 MiB pinned binary budget');
const suite = {
  revision: 'draft-qmq-v1-wide-0001', operator_abi: 'qmq-v1',
  coverage: {
    kind: 'finite-stratified-shapes', policy_ref: 'asc/full-size-policy.md',
    bounds: { m: [1,8192], n: [1,32769], k: [1,8192] },
    source_catalog: 'v235_exact.json', source_sha256: createHash('sha256').update(sourceBytes).digest('hex'),
    source_case_count: historical.length, pinned_binary_bytes: totalBytes,
    note: 'Coverage bounds are an envelope, not an exhaustive Cartesian product or kernel support claim. The historical catalog supplies part of the selection; long-K and large-matrix points are also added.',
  },
  cases: [...selected.values()].map(({shape:[m,n,k],group,mode}) => {
    const id = `qmq_i8_${String(m).padStart(3,'0')}x${String(n).padStart(3,'0')}x${String(k).padStart(3,'0')}`;
    return { case_id: id, shape: {m,n,k}, dtype: 'int8', layout: 'qmq-v1',
      input_hash: `pending-input-${id}`, oracle_hash: `pending-oracle-${id}`,
      coverage_group: group, generation: {seed:42,mode} };
  }),
};
const target = resolve(process.argv[3] ?? 'templates/project/asc/case-suite.json');
writeFileSync(target, JSON.stringify(suite,null,2)+'\n');
console.log(JSON.stringify({target,case_count:suite.cases.length,pinned_binary_bytes:totalBytes,
  groups:Object.fromEntries([...new Set(suite.cases.map(c=>c.coverage_group))].map(g=>[g,suite.cases.filter(c=>c.coverage_group===g).length]))}));
