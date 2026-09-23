import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Agent, DshContext } from './host.ts';

const NAMES = ['meteor-kernel-test', 'meteor-performance-analysis'];
const PROVIDER = 'meteor-skills';
const bundledRoot = fileURLToPath(new URL('../templates/project/.dsh/skills/', import.meta.url));
type Lookup = { cwd?: string; signal?: AbortSignal };
type Registry = { registerProvider(create: (control: { invalidate(): void }) => any): () => void };

function definition(name: string, path: string, source: string) {
  const raw = readFileSync(path, 'utf8');
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/.exec(raw);
  return {
    name, path, source, provider: PROVIDER,
    description: /^description:\s*(.+)$/m.exec(frontmatter?.[1] ?? '')?.[1] ?? name,
    content: frontmatter ? raw.slice(frontmatter[0].length) : raw,
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: dirname(path) },
  };
}

/** Native discovery uses the Git root, which can be above the Meteor project. */
export function registerChiefSkills(ctx: DshContext) {
  const invalidators = new Set<() => void>();
  const scoped = new Map<Agent, () => void>();
  function mount(skills: Registry) {
    let invalidate = () => {};
    const dispose = skills.registerProvider(control => {
      invalidate = () => control.invalidate();
      invalidators.add(invalidate);
      return {
        name: PROVIDER,
        async list(options: Lookup) {
          options.signal?.throwIfAborted();
          return NAMES.map(name => {
            const local = options.cwd && join(resolve(options.cwd), '.dsh/skills', name, 'SKILL.md');
            const project = local && existsSync(local);
            const path = project ? local : join(bundledRoot, name, 'SKILL.md');
            const { content: _content, ...summary } = definition(name, path, project ? 'meteor-project' : 'bundled');
            // Explicit cwd-local files beat a parent Git root's project rank (100).
            // Packaged defaults use DSH's standard bundled rank (600).
            return { ...summary, rank: project ? 99 : 600, locator: path };
          });
        },
        async get(candidate: { name: string; locator: string; source: string }, options: Lookup) {
          options.signal?.throwIfAborted();
          return existsSync(candidate.locator) ? definition(candidate.name, candidate.locator, candidate.source) : undefined;
        },
      };
    });
    return () => { invalidators.delete(invalidate); dispose(); };
  }
  const disposeGlobal = mount((ctx.get?.('skills') ?? ctx.skills) as Registry);
  // Web filesystem skills live in the chief's scope; global rank cannot override
  // that nearer layer. Mount before its first catalog lookup, never on children.
  const disposeCreated = ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
    if (agent.session.header.origin === 'subagent' || scoped.has(agent)) return;
    const registry = agent.ctx?.get?.('skills') ?? agent.ctx?.skills;
    if (registry?.registerProvider) scoped.set(agent, mount(registry));
  });
  const disposeRemoved = ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
    scoped.get(agent)?.(); scoped.delete(agent);
  });
  const invalidate = () => { for (const refresh of invalidators) refresh(); };
  const disposeObserver = ctx.on('fs/observed', (target: { displayPath?: string }, _observation: unknown, actor?: { name?: string }) => {
    if (actor?.name !== 'edit' && actor?.name !== 'write') return;
    if (target.displayPath && /[/\\]\.dsh[/\\]skills[/\\]meteor-(kernel-test|performance-analysis)[/\\]SKILL\.md$/.test(target.displayPath)) invalidate();
  });
  return { invalidate, dispose: () => {
    disposeObserver(); disposeCreated(); disposeRemoved();
    for (const dispose of scoped.values()) dispose();
    scoped.clear(); disposeGlobal();
  } };
}
