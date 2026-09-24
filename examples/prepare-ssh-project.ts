import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { initProject } from '../src/init.ts';
import { probeHardware } from '../src/hardware.ts';
import { readJson, writeJson, sha256, hashObject } from '../templates/project/tools/meteor/util.ts';
import type { CaseSuite, MeteorConfig } from '../templates/project/tools/meteor/contracts.ts';

const root = resolve(process.argv[2] ?? 'reports/e2e/ssh-project');
const profileRef = process.argv[3] ?? process.env.METEOR_SSH_PROFILE;
if (!profileRef) throw new Error('Pass the central SSH profile name as the second argument, or set METEOR_SSH_PROFILE');
initProject(root, { git: false });
const driverRoot = join(root, 'tools/meteor/runners/remote');
const verifierHash = sha256(readFileSync(join(driverRoot, 'verify_case.py')));
const shapes = [[1,32,64],[4,32,64],[16,32,64],[32,64,128]];
const suite: CaseSuite = { revision: 'qmq-real-4-shapes-seed42-v1', operator_abi: 'qmq-v1', cases: [] };
for (const [m,n,k] of shapes) {
  const caseId = `qmq-${m}-${n}-${k}`, dataRef = `cases/${caseId}`;
  const path = join(root, dataRef);
  if (!existsSync(join(path, 'case.json'))) {
    const run = spawnSync(process.env.METEOR_PYTHON ?? 'python', [join(driverRoot, 'gen_case.py'), '--m', String(m), '--n', String(n), '--k', String(k), '--seed', '42', '--output', path], { encoding: 'utf8', windowsHide: true });
    if (run.status !== 0) throw new Error(run.stderr || run.stdout);
  }
  const metadata = readJson(join(path, 'case.json'));
  const inputs: Record<string,string> = {}, golden: Record<string,string> = {};
  for (const [name, entry] of Object.entries(metadata.files)) (name.startsWith('input/') ? inputs : golden)[name] = (entry as any).sha256;
  suite.cases.push({ case_id: caseId, shape: {m,n,k}, dtype: 'int8', layout: 'qmq-v1', input_hash: hashObject(inputs), oracle_hash: hashObject({ verifier_sha256: verifierHash, golden }), data_ref: dataRef });
}
writeJson(join(root, 'asc/case-suite.json'), suite);
const config = readJson<MeteorConfig>(join(root, 'meteor.config.json'));
config.budget = { max_experiments: 12, max_wall_time_seconds: 3600 };
writeJson(join(root, 'meteor.config.json'), config);
const hardware = await probeHardware(root, profileRef);
mkdirSync(join(root, 'reports/live-dsh'), { recursive: true });
console.log(JSON.stringify({ root, suite: suite.revision, case_count: suite.cases.length, hardware }, null, 2));
