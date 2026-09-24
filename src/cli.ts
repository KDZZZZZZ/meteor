#!/usr/bin/env node
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { initProject } from './init.ts';
import { loadProject } from './project.ts';
import { listResearch } from '../templates/project/tools/meteor/research.ts';
import { loadSshProfile } from '../templates/project/tools/meteor/profiles.ts';
import { probeHardware } from './hardware.ts';

export async function main(args = process.argv.slice(2)) {
  const [command, directory = '.'] = args;
  if (!command || command === '--help' || command === '-h') {
    console.log('meteor init [directory]\nmeteor hardware [directory] [profile-ref]\nmeteor status [directory]\nmeteor config [directory]\nmeteor profile-check <profile-ref>\n\nResearch is started and managed by chief through the DSH meteor_start tool.');
    return;
  }
  let output: unknown;
  if (command === 'init') output = initProject(directory);
  else if (command === 'hardware') output = await probeHardware(directory, args[2]);
  else if (command === 'status') {
    const project = loadProject(directory);
    output = { root: project.root, backend: project.config.execution.backend, research: listResearch(project) };
  } else if (command === 'config') output = loadProject(directory).config;
  else if (command === 'profile-check') {
    if (!args[1]) throw new Error('profile-check requires a profile reference');
    const profile = loadSshProfile(args[1]);
    output = { profile_ref: args[1], configured: true, driver_configured: Boolean(profile.driver_path), connected: false };
  } else throw new Error('Unknown command; use meteor --help');
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
