# DSH integration

The implemented host targets **`@deepseek-ai/dsh 0.1.7-alpha.2`** and Node.js 24. The user explicitly selected this alpha release after asking to upgrade the previously installed **0.1.0-rc.6** and account for the intervening interface changes. The official alpha.2 tag is commit [`00102833dfaee1da9f48a3a8eae9d34005a75218`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.2), released on 2026-09-22.

Contracts were checked against the installed alpha.2 JavaScript and `.d.ts` files and the corresponding upstream source. Meteor has no runtime dependency on another copy of Cordis or DSH: its exported `apply(ctx)` registers plain `ToolDefinition` objects into the existing host. Keep the CLI and its official profile bundles on the same release.

## Runtime contracts

| Surface | Installed alpha.2 contract used here |
| --- | --- |
| `dsh-tools/lib/index.js` | `ctx.tools.register({ name, description, parameters, output, execute })`; parameters are JSON Schema; execute returns a canonical JSON value. `output.render` turns that value into model text. |
| `dsh-jobs/lib/types/types.d.ts` | `jobs.start({ kind, label, owner: chief.id, run })`; **owner is a SessionId**. The synchronous producer returns `{ cancel, done }`. The terminal string is `JobOutcome.result`; `JobSpec.output` instead describes pull sources. Native collection uses `jobs.read(id, chief.id)` and `jobs.wait(id, timeoutMs, chief.id, signal)`. |
| `dsh-jobs-local/lib/index.js` | A job controller must serve the owner before admission. The standard `tool-jobs` plugin supplies UI/model collection and cancellation. Kinds are opaque nonempty names. |
| `dsh-subagent-in-process-driver/lib/index.js` | `subagents.start('spawn', request)` creates one one-shot run whose single turn may contain many tool/model steps. `run.id` is its session ID; `run.localAgent` is its live Agent; always await `run.dispose()`. |
| `dsh-subagent-in-process-driver/lib/index.js` | An object-rooted `outputSchema` installs a child-scoped **`structured_output`** tool. Plain final prose does not satisfy the schema. Meteor requires `prepared_submission_id` produced by this same session, a completed stop reason, and the matching `result.structured` value. |
| `dsh-agent/lib/types/runtime-types.d.ts` | `agent/pre-step` is an awaited waterfall with `{ agent, messages, signal }`; Meteor uses it for initial binding and cooperative pause. `tools/pre-execute` is the second pause boundary. |
| `dsh-compaction-basic/lib/index.js` | The mounted compaction provider already calls `compactIfNeeded(agent, 'pressure', signal)` at pre-step. Meteor preserves this service and session, and does not call idle-only `compactNow` on a running Agent. |
| `dsh-agent-preset-registry/lib/index.js` | This replaces the old `dsh-agent-presets` package. The service remains `agentPresets`, with `mount`, `composeFrom` and `serviceFor`. Web presets mount compaction in an isolated realm: resolve it with `ctx.get('agentPresets')?.serviceFor(agent, 'compaction')`, rather than requiring root compaction injection. Use `Context.get()` for optional service access, including `agent.ctx.get('skills')`. |
| `dsh-skill/lib/types/index.d.ts` | The two snapshot skill bodies are registered on the child's scoped `skills` service. Native `skill` loads them into that same conversation. |
| Meteor `meteor-skills` providers | A global provider exposes packaged defaults at rank 600. Native `agent/created` registers a chief-scoped provider, skipping `origin=subagent`, so current-cwd skills at rank 99 beat the parent Git project's rank 100 in the same scope. The child's frozen runtime skill registrations remain authoritative. |

The jobs migration is a real interface change: `owner: Agent` became `owner: SessionId`, final `output` became `result`, and `updateDetail` became `updateProgress` in [upstream commit `07941fe5e2a18abd89faa1a09f395dad164a8b66`](https://github.com/deepseek-ai/deepseek-harness/commit/07941fe5e2a18abd89faa1a09f395dad164a8b66). The alpha.2 tool cookbook still shows the former owner shape; the [versioned jobs types](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/jobs/jobs/src/types.ts#L16-L157) and installed runtime are the compatibility authority. Canonical tool outputs and `tools.guard()` already existed in rc.6 and are not claimed as new alpha.2 features.

Native structured output accepts a supported JSON Schema subset, not arbitrary JSON Schema keywords. In particular, `minLength` is rejected. Meteor's final schema uses `type`, `properties`, `required` and `additionalProperties`; its prepared-reference guard enforces a valid, nonempty identifier owned by the current research. See the [schema validator](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/core/tools/src/json-schema.ts) and [subagent request/result contract](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/subagent/subagent/src/types.ts#L145-L333).

Presets are declared through plugin bundles; the registry retains a revision while a live Agent or child uses it. `composeFrom` joins a child to its parent's exact revision. This host lifecycle complements Meteor's own frozen research snapshot; it does not replace it. See the [preset migration](https://github.com/deepseek-ai/deepseek-harness/commit/d1e22a7e247060496e1acdba9ef3be1700e23ec7), [service lookup](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/preset/agent-preset-registry/src/index.ts#L243-L284) and [scoped skill registration](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/skill/skill/src/index.ts#L345-L459).

Chief receives `meteor_init`, `meteor_start`, `meteor_status`, `meteor_control` and `meteor_evidence`. Its normal tools remain available for a small amount of relevant internal evidence analysis and official vendor web research. One start creates one research and one continuous native Agent. Under an authorized sustained goal, chief can issue later starts within its budgets and device capacity; the plugin and research child do not recursively spawn the next research.

`meteor_start.initial_context` lets chief configure random sampling for this research or specify exact kernel and knowledge references. The default is random sampling. `meteor_start.hypothesis` optionally pins the hypothesis to investigate with either material mode. These assignments are copied into the research manifest and passed to the same continuous child. Initial materials remain inspiration: the child can read other kernels and knowledge. When a supplied hypothesis is revised, the original must remain in the hypothesis history and its own assessment determines whether the assigned goal is complete.

The child receives unrestricted-path reading, research-local writing, native read/search/skill tools where available, and six experiment/submission tools. Native shell, recursive subagent/workflow management and shared-file writing are outside its permitted tool set. The allowlist limits capabilities, not which materials may inspire the work. Native `structured_output` is a child-scoped tool and remains available under the DSH tool-filter contract.

An inherited `toolFilter` alone is insufficient: DSH can register a native `subagent` tool on the child's own layer after applying that filter. Meteor also installs a final monotonic `tools.guard()` that denies any tool outside its research/read/skill/final-output set for a bound research session. This prevents recursive delegation even when a child-local registration remains visible. It preserves the original research Agent and its context. See [the native guard contract](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/docs/subsystems/tools.md#L540-L550).

The spawn driver can start the child's first step before `subagents.start()` resolves. Meteor therefore recognizes and binds the pending research at `agent/pre-step`, as well as checking the returned `run.localAgent`; it does not wait until after the first request to install its scoped state. [Native startup ordering](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/subagent/subagent-in-process-driver/src/index.ts#L178-L207).

The initial prompt points to the exact persona, module/submission contracts, case suite and run manifest. The run manifest supplies the bound `agent_session_id`. `meteor_kernel_build` binds `research_id` automatically. Module `device_file` and `host_file` paths are relative to the project; writable draft paths are relative to the research directory.

## Skill discovery and chief workflow

Native project skill discovery uses the nearest `.git` root. In an experiment project nested below a parent repository, that can omit the experiment cwd's `.dsh/skills` entirely. The filesystem provider is itself registered in chief's scope, so a global provider's rank cannot override it. Meteor keeps bundled defaults in a global `meteor-skills` provider at rank 600 and registers an additional provider on native `agent/created` in chief's own scope, skipping `origin=subagent`. There, current-cwd project files at rank 99 can override parent Git discovery at rank 100. The global fallback makes the entry skill available before initialization; it tells chief to call `meteor_init`, read the merged configuration and operator contract, and start when ready.

An initialized project's files take precedence over packaged defaults within chief's provider setup. The research child's own runtime skill layer contains the bodies copied into its frozen snapshot and keeps precedence over inherited discovery. Chief may use completed reports to improve the project persona or either skill for future research. Running snapshots and original evidence remain intact; no mid-run hints, rewritten submissions or manual result repairs are part of this workflow.

The existing chief skill carries these operating instructions so a UI request can consist of a short goal. For sustained authorization, chief first completes one research to verify reliable calls, tool use, reporting and automatic integration. It then chooses concurrency within the overall budget, per-research budgets and device limits, tracks progress with native jobs and available durable goal facilities, and decides on subsequent research after the relevant receipts settle. One research's terminal status does not imply the overall goal is complete. Unknown remote requests are queried or collected before retrying their work; new research IDs cannot bypass budgets.

## Finalization and recovery

`meteor_prepare_submission` returns validation issues to the existing Agent. Preparation never commits or integrates. Further writes or experiments invalidate the in-memory final reference, so the Agent must prepare again. The guard on `structured_output` rejects an unknown or superseded reference before it can end the native run.

After native completion, the host records the accepted final reference, commits it with the original session ID, and immediately returns the research report and next-step suggestions to chief through its job output. It starts deterministic integration automatically as a separate `meteor-integration` job, with no additional Agent. Chief receives the integration receipt when that job settles. If the native job quota is occupied, the host still runs and owns the deterministic work, with its receipt available through `meteor_status`.

Pause first reports `pause_requested`. `PAUSED` means the original run reached a supported boundary; an in-flight model request or experiment is not interrupted by a pause. Resume releases the same waiting run. Cancellation aborts the original run and propagates to cooperative experiment requests. These are host controls; there is no invented native `pause()` API.

An ended or lost one-shot Agent is never respawned. Interrupted and failed runs keep a host report, evidence and memory. An accepted final submission may be replayed after restart from its pinned runtime/config/suite snapshot; a merely prepared submission is not treated as a final delivery. Read access to old project records is available to later chief sessions. Active cancellation and pause remain owned by the chief that started the run.

## Loading the plugin

Build with `npm run build` before package installation. The dependency-free build emits JavaScript; Node's native TypeScript stripping cannot run raw package TypeScript inside `node_modules`. The project templates retain a readable `contracts.md` alongside executable JavaScript.

For a development run, create an external temporary patch with an absolute file URL:

```yaml
- insert:
    - id: meteor
      name: file:///absolute/path/to/meteor/dist/src/index.js
```

Start DSH from the experiment project directory:

```text
dsh --profile headless --patch /absolute/path/to/meteor-test.patch.yml "Investigate qmq kernel performance within the configured research budget."
```

The shipped headless/base composition includes jobs, `tool-jobs`, spawn, skill and automatic compaction. Headless exits when its chief finishes, so chief must collect relevant jobs using `job_output({ job_id, wait: true, timeout_ms: 60000 })` until terminal before its final response. Web mode keeps the native jobs UI and chief conversation available.

The patch only selects the Meteor plugin for that invocation. Existing DSH model/credential settings are reused. It contains no API key, SSH key, password or connection secret. SSH execution remains disabled until a configured backend is provided; mock evidence stays explicitly simulated.

## Web UI and centralized credentials

For remote Web UI access, bind DSH to loopback and place Tailscale Serve in front of it. Add the exact external `host:port` with `--trusted-host`, and use `--no-open` for a supervised launch. For example:

```text
dsh --profile web --patch /absolute/path/to/meteor-test.patch.yml --host 127.0.0.1 --port 13880 --no-open --trusted-host your-device.your-tailnet.ts.net:8443
```

The proxy must preserve Host, Origin and cookies, and forward WebSocket upgrades, including alpha.2's `/api/remote.mux`. `--trusted-host` admits the external authority through the Host/Origin fence; it does not authenticate the browser. The Tailscale access policy and DSH browser authentication both apply. Every Host API method, including settings and credential operations, and every WebSocket stream requires an authenticated browser session. See the [alpha.2 connection contract](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/client/connection/README.md#L32-L45).

Each DSH process prints a root URL containing a fresh launch token. A browser visits `/?token=<launch-token>` once, receives an authority-bound signed cookie, and follows a `303` redirect to the clean URL. Cookie authority includes hostname and port, so local and Tailscale addresses each require their own initial exchange. Cookie lifetime defaults to 30 days. The signing record is stored centrally by DSH in `$DSH_HOME/.credentials.yaml`; existing cookies can survive a normal restart even though the launch token changes. There is no fixed launch-token configuration. [Authentication implementation](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/client/connection/src/browser-auth.ts#L161-L297).

The launcher keeps login-token handling separate from published clean URLs and redacts tokenized URLs from diagnostic output. Do not copy API keys, SSH keys, DSH credential files or launch-token files into the project, snapshots or reports. Model configuration names an `apiKeyEnv` reference; SSH configuration names a centralized profile and system SSH alias. Use the installed browse directory picker pair in place of `directory-picker-auto` when the browser runs on another device; a native Windows picker opens on the host desktop.

On the first applicable upgrade, DSH renames `settings.yaml` to `settings.yaml.imported` and attempts to import its sections into the current Profile's plugin configuration. It does not expand `apiKeyEnv` or copy the credentials store. It also does not extract inline secrets from arbitrary old plugin settings: any such accepted field can remain in both the renamed input and the Profile. Keep credentials referenced through their existing central store or launch environment. [Settings migration](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/settings/settings/src/index.ts#L238-L259).

## Verification

`tests/dsh.test.ts` checks continuous session binding, chief-assigned materials and hypotheses, validation errors returning to the same Agent, final-reference ownership, report delivery, pause/resume/cancel and write boundaries with a fake host. Its compatibility test uses the **installed real Cordis and DSH ToolRuntime** to register all 13 tools and exercise native execution. Set `METEOR_DSH_MODULE_ROOT` to that installation's `node_modules` directory to run it; without the variable, that optional compatibility test is skipped. On 2026-09-23 the suite passed **12/12** with alpha.2 and the native compatibility case enabled; this does not mean all twelve tests use a full native host. The complete project suite passed **96/96** with no skipped tests.

`scripts/verify-dsh-web.mjs` also passed against alpha.2 on 2026-09-23. It boots the complete official Web profile in an isolated temporary `DSH_HOME`, using the built Meteor plugin, and prevents every model request at the native pre-step boundary. It verified:

- The standard preset and Meteor tools load in the real Web composition.
- The research manifest and native child retain the same session ID.
- Chief-specified initial materials and a supplied hypothesis reach that child, which can read the selected source file.
- The child resolves its frozen skill body and native compaction service.
- Native `structured_output` is present; recursive delegation is denied; shell tools cannot bypass experiment tools.
- Cancellation settles the native job, and its report reaches the native result/completion-notice path.

Run it after `npm run build` with `node scripts/verify-dsh-web.mjs /absolute/path/to/dsh/node_modules`. No user credential file is copied into its temporary home. The full-profile smoke approach was informed by [`PerryLink/dsh-auto-review@7aa0569b39b3586ece543c6411e9c0604f630c0f:.github/workflows/compat.yml:L85-L131`](https://github.com/PerryLink/dsh-auto-review/blob/7aa0569b39b3586ece543c6411e9c0604f630c0f/.github/workflows/compat.yml#L85-L131); Meteor's test implementation is independent.

These checks prove service composition and lifecycle behavior without an LLM. Resolving the compaction service does **not** prove that an actual compaction occurred. The live Web UI model run has started, but a completed real model-authored hardware operator run is not established by this compatibility evidence. Ascend correctness, actual full-size kernel measurements and an actual compaction require separate recorded results. The default experiment backend is mock; it cannot establish a hardware hypothesis or demonstrate NPU speedup.

A subsequent real Web composition check reproduced a failure to find the two project skills in a nested experiment cwd. A stronger regression also failed with a global rank-99 provider because chief's scoped filesystem provider took precedence. After the chief-scoped correction, the expanded real Web-profile smoke passed with `model_requests=0`. It verified bundled skill loading and `meteor_init` guidance before initialization, same-scope current-cwd priority over the parent Git project's skills, discovery refresh after `meteor_init`, and unchanged frozen child skill bodies after a project update. The complete project suite passed 96/96 and TypeScript checking passed. Model/API stability and an unattended research loop still require their own execution evidence.
