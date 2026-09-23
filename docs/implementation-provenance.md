# Implementation Provenance

This document separates human design requirements, Agent implementation choices, and external/reference material used while building meteor.

## Human Design

- Plugin name: `meteor`.
- Target host: DeepSeek Harness.
- After requesting an upgrade and interface verification against current official documentation, the user explicitly selected **DSH 0.1.7-alpha.2**. The earlier installed 0.1.0-rc.6 is the previous compatibility target.
- Chief manages user interaction, configuration, repository maintenance, and how many research tasks to start.
- The user requested that a short UI goal be enough: existing skills carry chief's routine initialization, configuration, startup and result-collection duties. Chief initializes a missing project itself, starts promptly when configuration is sufficient, and may use a small set of internal evidence and official vendor web sources to formulate a hypothesis.
- For an explicitly authorized sustained goal, chief first verifies a stable complete research round, then chooses concurrency within overall and per-research budgets and device capacity. It may start the next distinct research after collecting reports and automatic integration receipts; one completed research is not completion of the overall goal. Unknown remote work is collected or queried before retrying it.
- Chief may improve the existing project persona and two skills from completed reports. Changes affect future snapshots; a running snapshot, its evidence and submitted result must not be rewritten or supplemented with hints to manufacture success.
- The user explicitly added chief control over initial context: configure random distribution for a research, or specify kernels and knowledge. Random sampling keeps the existing freshness policy by default; specified materials are not mixed with random draws, and per-research sampling settings do not change project defaults.
- Chief can assign a hypothesis with either context mode. The child tests that target and fills in its experimental definition; it proposes a hypothesis only when chief supplies none. Any revision preserves the original wording and status, and a supported revision cannot be reported as proof of the original hypothesis.
- Each research's manifest and seed record chief's inputs and the actual material distribution.
- Each research task uses one continuous subagent session. Test and performance analysis are skills in that same session, not separate Agents.
- The research Agent tests a supplied or self-proposed falsifiable kernel-performance hypothesis within its original continuous session.
- The Agent may submit zero, one, or many kernels.
- Every submitted kernel must already have exact-revision full-size single-kernel test evidence before final submission.
- Chief does not manually test submitted kernels and does not manually integrate versions.
- Valid final submission triggers automatic case-shape routing and version assembly.
- Hypothesis verdict, kernel performance, and integration selection are separate records.
- Mock evidence cannot prove a real hardware hypothesis.
- SSH configuration is centralized by profile reference; credentials must not be copied into prompts, logs, snapshots, reports, or repository files.
- Randomly distributed and explicitly selected kernels and knowledge are only inspiration. The Agent is encouraged to read other kernels and knowledge, and is not required to modify a supplied kernel.
- Structured knowledge must be more than one flat file.
- When a live DSH Agent behaves poorly, fix the relevant skill prompts and rerun. Do not feed hints to the running Agent, write its final answer for it, or manually repair its research result.
- Repository governance also lives in the existing chief entry skill: feature branches use `<type>/<kebab>`, `main` and `dev` accept PR merges with no other-person approval required, and creating a PR still requires the user's explicit permission. Research authorization is not PR authorization; change descriptions distinguish human design, Agent decisions and mature implementation references.

## Agent Decisions

- Initially inspected the installed DSH 0.1.0-rc.6 API, then adapted the host to the user-selected 0.1.7-alpha.2. The release choice is human design; the compatibility implementation and verification approach are Agent decisions.
- Migrated native jobs to a SessionId owner and `JobOutcome.result`, resolved optional services through `Context.get()` and preset-scoped compaction through `agentPresets.serviceFor()`, and retained the original research session and frozen snapshots.
- Kept native final-output JSON Schema within DSH's supported subset, which excludes `minLength`; a monotonic tool guard validates the prepared reference and limits research tools even when DSH registers a native subagent tool on the child's own scope after applying the inherited filter.
- Added a full official Web-profile compatibility smoke in an isolated temporary `DSH_HOME` with model steps rejected, supplementing fake-host and real ToolRuntime tests.
- Added native `meteor-skills` discovery after finding that project lookup stops at the nearest `.git` root and can miss a nested experiment project's skills. A stronger Web smoke established that chief's scoped filesystem provider also overrides a global provider regardless of rank. The correction keeps packaged defaults in a global provider at rank 600 and registers a chief-scoped provider at native `agent/created`, skipping `origin=subagent`. Current-cwd project skills use rank 99 ahead of the parent Git project's rank 100 in that same scope. The child's own frozen runtime skill layer remains authoritative.
- Kept chief's startup, bounded source research, authorized continuation and future-snapshot prompt maintenance in the existing two skills. No additional persona or chief prompt file was introduced.
- After a live chief repeatedly inspected shell/SSH setup without starting a research, refined the entry skill to start the first configured research immediately after reading configuration. The research's experiment tools verify the real SSH execution path. Later source research and prompt improvement remain chief responsibilities; the running Agent received no corrective message or kernel implementation.
- Used loopback DSH behind Tailscale Serve with an exact trusted authority and DSH's native per-authority browser-token exchange. Published access addresses stay clean, login tokens are redacted from diagnostics, and user keys/credential files are not copied into the project or smoke environment.
- Implemented the project template with Node 24 native TypeScript and Python 3.12 standard-library SQLite, with no npm runtime dependencies.
- Used one SQLite catalog per backend under `reports/meteor/<backend>/knowledge/catalog.sqlite`.
- Made JSON files projections and evidence artifacts; SQLite is authoritative for commits, novelty, and integration outbox state.
- Added `meteor_prepare_submission` validation before native structured output, with structured validation issues for repair by the original session.
- Made mock official verdicts remain `INCONCLUSIVE`; `simulated_verdict` is separate.
- Used a channel key of `backend|operator_abi|suite|environment|protocol` to serialize automatic integration.
- Added SQLite lease token and expiry for integration event claiming and token-CAS completion.
- Used content hashes for novelty idempotence so duplicate claims or kernel evidence do not refresh material freshness.
- Used `related_material_ids` to refresh existing material when a new claim provides evidence-backed progress about it.
- Made sampling read SQLite materials directly, with configured epsilon, seeded randomness, recent selection penalties over the freshness window, and active-research inflight penalties.
- Expressed chief's requested controls through optional `initial_context` and `hypothesis` inputs to `meteor_start`. Material references accept library IDs, `sqlite://kind/id`, and file/module paths. These inputs use the existing persona and two skills.
- Rendered assembled versions through the local `renderVersion` API and marked integration artifacts as `integration_validation=NOT_RUN`.
- Published remote driver bundle files atomically after writing them completely, so parallel research starts cannot read partially deployed files. The deployment phase holds no lock during kernel execution.
- Restricted integration event selection and claims to the backend, operator ABI, case suite, environment and measurement protocol of the processing project; another channel's event remains available for its original research snapshot.
- Bound final kernel evidence to the submitting research and tool-owned receipt paths, checked the linked build and current module identity, and recomputed measurement hashes. Reading other research remains available for inspiration and background evidence.

## Mature Implementation References

- **DSH 0.1.7-alpha.2**, official tag commit [`00102833dfaee1da9f48a3a8eae9d34005a75218`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.7-alpha.2), together with its installed JavaScript and declarations, defines the integration contract. This commit must not be labeled rc.6. Specific references are [jobs types](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/jobs/jobs/src/types.ts#L16-L157), [preset service lookup](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/preset/agent-preset-registry/src/index.ts#L243-L284), [spawn lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/subagent/subagent-in-process-driver/src/index.ts#L178-L207), [scoped skills](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/skill/skill/src/index.ts#L345-L459), and [browser authentication](https://github.com/deepseek-ai/deepseek-harness/blob/00102833dfaee1da9f48a3a8eae9d34005a75218/packages/client/connection/README.md#L36-L45). These are API and behavior references, not copied implementation code.
- DSH's [jobs refactor `07941fe5e2a18abd89faa1a09f395dad164a8b66`](https://github.com/deepseek-ai/deepseek-harness/commit/07941fe5e2a18abd89faa1a09f395dad164a8b66) and [declarative preset change `d1e22a7e247060496e1acdba9ef3be1700e23ec7`](https://github.com/deepseek-ai/deepseek-harness/commit/d1e22a7e247060496e1acdba9ef3be1700e23ec7) explain the migration. The preset package is now `dsh-agent-preset-registry`; its `agentPresets` service and `serviceFor` method remain available. Where a cookbook example disagrees with the installed version's types and implementation, the latter were used.
- [`PerryLink/dsh-auto-review@7aa0569b39b3586ece543c6411e9c0604f630c0f:.github/workflows/compat.yml:L85-L131`](https://github.com/PerryLink/dsh-auto-review/blob/7aa0569b39b3586ece543c6411e9c0604f630c0f/.github/workflows/compat.yml#L85-L131) informed the full-profile smoke strategy: pin CLI and bundles to the same release, boot an isolated real profile, and distinguish loading success from model execution. Its repository was updated on 2026-09-23. Meteor independently implemented its own Web-profile checks; no community-plugin implementation was copied.
- AlphaEvolve paper `2506.13131` informed the high-level idea of diverse candidate exploration and evidence-based iterative improvement. meteor does not claim to implement AlphaEvolve.
- The remote NPU harness adaptation is based on the user’s existing workspace tools under `tools/remote_npu`, including environment bootstrap, sequence execution, batch running, and evidence collection patterns. These are treated as user workspace infrastructure, not vendor source code.

## Verification and Limits

- On 2026-09-23, the complete test suite passed **96/96** with no skipped tests. `tests/dsh.test.ts` passed **12/12** with the installed alpha.2 compatibility case enabled. It includes fake-host lifecycle and chief-assignment tests and a real Cordis/ToolRuntime registration/execution test.
- On 2026-09-23, `scripts/verify-dsh-web.mjs` passed using the full official alpha.2 Web profile and an isolated temporary `DSH_HOME`, with **zero model requests**. It checked chief-assigned context and hypothesis, scoped snapshot skills, the presence of native compaction, the same native child session ID, native structured output, denial of recursive delegation, job cancellation and native report delivery. This is actual native composition evidence, not a fake-host result.
- Later native Web reproductions failed when discovery used a parent Git root instead of the nested cwd, and again when a global rank-99 provider could not override chief's scoped filesystem provider. After the chief-scoped correction, the expanded real Web-profile smoke passed with `model_requests=0`: packaged skills and `meteor_init` guidance were available before initialization, current-cwd skills took priority over the parent Git project's skills, `meteor_init` refreshed discovery, and frozen child skill bodies stayed independent of project edits. The 96/96 suite and TypeScript checking also passed after this correction.
- Model/API stability and a completed research round must be verified separately before sustained autonomous operation. A smoke that blocks model requests cannot establish either.
- The smoke resolves the compaction service but does not execute a real compaction. The live UI model test has started; a completed model-authored Ascend operator and its hardware performance evidence are not claimed here.
- No vendor kernel implementation is claimed as copied into meteor.
- Mock demo success does not prove hardware performance or a real optimization hypothesis.
