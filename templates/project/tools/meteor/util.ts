import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter(key => (value as Record<string, unknown>)[key] !== undefined).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}';
}
export function sha256(value: string | Uint8Array): string { return createHash('sha256').update(value).digest('hex'); }
export function hashObject(value: unknown): string { return sha256(canonical(value)); }
export function readJson<T = any>(path: string): T { return JSON.parse(readFileSync(path, 'utf8')); }
export function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = path + '.' + randomUUID() + '.tmp';
  writeFileSync(temp, JSON.stringify(value, null, 2) + '\n');
  renameSync(temp, path);
}
export function writeImmutable(path: string, value: unknown): void {
  if (existsSync(path)) {
    if (hashObject(readJson(path)) !== hashObject(value)) throw new Error('Immutable record conflict: ' + path);
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}
export function safeId(value: string): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$/.test(value) || value.includes('..')) throw new Error('Invalid identifier');
  return value;
}
export function inside(root: string, path: string): string {
  const resolved = resolve(root, path);
  const part = relative(resolve(root), resolved);
  if (part === '..' || part.startsWith('..' + sep) || isAbsolute(part)) throw new Error('Artifact path escapes project');
  return resolved;
}
export function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
