import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { assert, readJson } from './util.ts';

export interface SshProfile { ssh_alias: string; remote_root: string; driver_path?: string; device_id?: string; connect_timeout_seconds?: number; env_script?: string; npu_arch?: string }
export function profileStorePath() { return process.env.METEOR_PROFILES_PATH ?? join(homedir(), '.config', 'meteor', 'profiles.json'); }
export function listSshProfiles(): string[] {
  const path = profileStorePath();
  if (!existsSync(path)) return [];
  const data = readJson(path);
  assert(data.schema_version === 1 && data.profiles && typeof data.profiles === 'object', 'Invalid profile store');
  return Object.keys(data.profiles);
}
export function loadSshProfile(ref: string, options: { profilesPath?: string } = {}): SshProfile {
  const path = options.profilesPath ?? profileStorePath();
  assert(existsSync(path), 'SSH profiles missing; configure the central profile store first');
  const data = readJson(path);
  assert(data.schema_version === 1 && data.profiles && typeof data.profiles === 'object', 'Invalid profile store');
  const profile = data.profiles[ref];
  assert(profile && typeof profile === 'object', 'Unknown SSH profile reference');
  const allowed = ['ssh_alias','remote_root','driver_path','device_id','connect_timeout_seconds','env_script','npu_arch'];
  assert(Object.keys(profile).every(key => allowed.includes(key)), 'Profiles accept SSH alias and execution settings only; credentials belong in system SSH configuration');
  assert(typeof profile.ssh_alias === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(profile.ssh_alias), 'Invalid SSH alias');
  assert(typeof profile.remote_root === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(profile.remote_root) && !profile.remote_root.split('/').includes('..'), 'remote_root must be an absolute POSIX directory');
  if (profile.driver_path !== undefined) assert(typeof profile.driver_path === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(profile.driver_path) && !profile.driver_path.split('/').includes('..'), 'driver_path must be an absolute POSIX path');
  if (profile.env_script !== undefined) assert(typeof profile.env_script === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(profile.env_script) && !profile.env_script.split('/').includes('..'), 'env_script must be an absolute POSIX path');
  if (profile.device_id !== undefined) assert(typeof profile.device_id === 'string' && /^\d+$/.test(profile.device_id), 'device_id must be a logical device index');
  if (profile.npu_arch !== undefined) assert(typeof profile.npu_arch === 'string' && /^dav-[a-zA-Z0-9-]+$/.test(profile.npu_arch), 'Invalid NPU architecture');
  if (profile.connect_timeout_seconds !== undefined) assert(Number.isInteger(profile.connect_timeout_seconds) && profile.connect_timeout_seconds >= 1 && profile.connect_timeout_seconds <= 120, 'Invalid connection timeout');
  return profile as SshProfile;
}
