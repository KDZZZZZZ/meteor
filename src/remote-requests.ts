import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { ActiveResearch } from './host.ts';
import { assert, hashObject, readJson, safeId, writeImmutable } from '../templates/project/tools/meteor/util.ts';
import { remoteIdempotency } from '../templates/project/tools/meteor/runners/ssh.ts';

/** Dispatch identities, not credentials, callbacks, or a replacement experiment queue. */
export function recordRemoteRequest(state: ActiveResearch, runRoot: string, operation: string, requestId: string): string {
  const remoteId = remoteIdempotency(state.project, operation, requestId);
  writeImmutable(join(runRoot, 'remote-requests', safeId(requestId) + '.json'), {
    schema_version: 1, research_id: state.id, chief_id: state.chief.id, agent_session_id: state.sessionId,
    target: state.project.scope, request_id: requestId, remote_request_id: remoteId, operation,
    created_at: new Date().toISOString(),
  });
  return remoteId;
}

export function readRemoteRequests(runRoot: string, manifest: any): any[] {
  const root = join(runRoot, 'remote-requests');
  if (!existsSync(root)) return [];
  return readdirSync(root).filter(name => name.endsWith('.json')).sort().map(name => {
    const record = readJson(join(root, name));
    assert(record.schema_version === 1 && ['build', 'test', 'profile'].includes(record.operation)
      && safeId(record.request_id) + '.json' === name && typeof record.remote_request_id === 'string'
      && record.remote_request_id.length > 0
      && ['research_id', 'chief_id', 'agent_session_id'].every(key => record[key] === manifest[key])
      && hashObject(record.target ?? null) === hashObject(manifest.target ?? null), 'Remote request identity does not match its research manifest');
    return record;
  });
}
