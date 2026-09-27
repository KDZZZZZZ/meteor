# meteor

DeepSeek Harness plugin for hypothesis-driven Ascend C kernel research.

meteor lets a chief agent initialize a local research workspace, derive a hardware execution model from official sources and device diagnostics, select assembly templates per op/dtype, start one continuous research subagent per `research_id`, validate full-size single-kernel evidence, and automatically store knowledge and assemble routed versions after valid submissions. Mock execution is reserved for explicitly selected protocol tests.

## Requirements

- Node.js 24 or newer.
- Python 3.12 or newer.
- No npm runtime dependencies.

The project uses Node 24 native TypeScript execution in tests and the Python standard-library `sqlite3` module for the structured knowledge store. Full remote-driver/oracle tests also require NumPy; CI uses Python 3.12 with NumPy 1.26.4. The Python executable must be available as `python`, or selected with the `PYTHON` environment variable.

## Quick Start

```bash
npm run build
node dist/src/cli.js init
node dist/src/cli.js hardware . my-central-profile
```

`init` writes the project template with backend `unconfigured`. Replace `my-central-profile` with a configured central SSH profile reference. A successful device probe is the first preparation step. In DSH, Chief loads `meteor-hardware-prepare`, searches version-matched official sources, runs bounded `meteor_hardware_experiment` diagnostics, publishes `meteor_hardware_model`, and explicitly chooses each target's template with `meteor_configure_assembly_template`. New SSH research is gated until all three are ready: device report, execution model and target template. Initialization never invents hardware primitives or silently selects the bundled example.

For a local protocol demonstration only, run `npm run demo`. It exercises the annotation/design gate, two independent full-size mock tests, activity comparisons, submission and automatic routing. It does not require SSH, CANN or an NPU; its placeholder implementations and simulated measurements establish no hardware result.

### Workspace Layout

Initialization creates schema 2: one hardware binding per repository, with shared tools, persona, skills and knowledge catalog. Operator/dtype targets are registered in `meteor.config.json`; artifacts use `<kind>/<op_id>/<dtype_id>/...`:

The Chief prepares the device, environment and evidence-backed hardware primitives once for the workspace. All research subagents reuse those assets; each subagent composes its own kernel intermediate expressions from the shared primitives. Starting another research freezes references and copies, without repeating device setup or defining a new primitive vocabulary. Assembly templates are reused within their op/dtype target.

```text
hardware/target.json                    # unconfigured until the real probe succeeds
hardware/reports/                       # device and toolchain evidence
hardware/sources/                       # Chief's versioned documentary excerpts
hardware/experiments/                   # diagnostic requests/results and frozen runtime
hardware/execution-models/<id>/<hash>.json # immutable model + source evidence
contracts/qmq-v1/int8/                  # formula and execution adapter
cases/qmq-v1/int8/default/suite.json     # fixed case suite
templates/<op>/<dtype>/assembly/        # Chief-selected frozen version templates
kernels/<op>/<dtype>/                   # exact kernel revisions
ir/<op>/<dtype>/                        # design/expected/freeze/comparison records
reports/<op>/<dtype>/                   # research and integration reports
versions/<op>/<dtype>/                  # route specs and assembled source
experiments/, builds/, measurements/, comparisons/, research/ # also op/dtype
knowledge/catalog.sqlite               # shared structured catalog; keys include target
knowledge/claim_<hash>.json             # HW-global claims
knowledge/<op>/claim_<hash>.json        # operator-wide claims
knowledge/<op>/<dtype>/claim_<hash>.json # dtype-shared claims / integration scope
knowledge/<op>/<dtype>/<shape_id>/claim_<hash>.json # declared inclusive size intervals
predictors/manifest.json                # shared rules registry, initially empty
.meteor/state/                         # host bookkeeping
.meteor/mock/                          # explicit mock artifacts and separate catalog
```

Shapes remain case metadata and version routing inputs. `meteor_start` accepts `target: {op_id, dtype_id}`; selection is required when more than one target is registered. The first executable adapter is `qmq-v1/int8`; adding arbitrary folders does not provide another operator implementation. Chief probes shared hardware once, then each target uses its own contract, suite and templates. Repeated initialization preserves edited files and reports template differences.

Existing schema 1 instances require `meteor migrate <directory>` for read-only inspection, followed by `--apply` once no research or integration is active. Migration preserves legacy source/receipt locations, writes backups and an evidence inventory, and publishes the new configuration last. `init` will not mix a new runtime into a legacy instance. See the [implementation record](docs/plans/2026-09-26-workspace-implementation.md).

## DSH Desktop / Web Loading

Run `npm run build`, then install this repository's absolute directory through DSH's **Plugins** page. The package declares `dsh.bundle.patch`, so the standard plugin manager can discover and activate it in the selected Desktop or Web profile. Keep research workspaces in separate directories and let Chief initialize them through `meteor_init`.

After rebuilding JavaScript for an already loaded local plugin, finish or cancel its active research jobs through Chief, then restart that DSH Desktop/Web host before validating the update. On Desktop 0.1.7-rc.2, disabling and enabling the bundle remounts it but can retain the previous JavaScript module cache. Existing research keeps its frozen snapshot; validate changed initialization templates in a fresh workspace instead of patching a running experiment.

The native contract tests previously ran against DSH **0.1.7-alpha.2**. Desktop **0.1.7-rc.2** installation and conversational research validation are being checked separately; a successful package installation alone does not establish a successful hardware research run. The registered chief tools are:

- `meteor_init`
- `meteor_hardware_probe`
- `meteor_hardware_experiment`
- `meteor_hardware_model`
- `meteor_configure_assembly_template`
- `meteor_start`
- `meteor_status`
- `meteor_control`
- `meteor_evidence`

The native run starts one spawned research Agent, keeps one session for the whole research loop, registers the two meteor skills into that child session, and accepts only a prepared submission from that same session.

The UI user can give a short goal. `meteor-kernel-test` handles dispatch and continuation; the Chief-only `meteor-hardware-prepare` skill handles device/model/template preparation. Diagnostic sources and commands are written before dispatch, use the same FIFO and retain original request IDs for poll/collect/cancel. Setup diagnostics never become an author's kernel full receipt. The skill provider exposes all three skills to Chief; research children retain their two frozen research skills.

### Starting A Research Task

Chief's primary responsibility is to start and manage research subagents once the project and device are ready. The child owns implementation, debugging, experiments and full testing. A goal is sufficient to start; Chief may also choose a budget, materials or a hypothesis. The following are chief tool inputs; users do not need to repeat these operating steps in each UI request. Omitting `initial_context` uses the project's freshness-based random sampling:

```json
{
  "goal": "Investigate a falsifiable hypothesis about qmq kernel performance"
}
```

Random sampling can be configured for this research without changing the project defaults:

```json
{
  "goal": "Investigate data reuse in qmq kernels",
  "initial_context": {
    "mode": "random",
    "sampling": {
      "count": 3,
      "seed": 42,
      "epsilon": 0.1,
      "lambda": 2,
      "tau_hours": 72
    }
  }
}
```

Use `specified` to distribute selected kernels and knowledge without adding random materials. References accept library material IDs, `sqlite://kind/id`, or file/module paths. Raw `.asc` and C/C++ sources are read-only inspiration, not validated kernel modules; logs and reports belong in `knowledge_refs`. Omit sampling in this mode; supplied valid sampling options are ignored, with `ignored_initial_context_fields` in the start result. The result and manifest expose the normalized selection. Replace the example references below with actual readable materials:

```json
{
  "goal": "Test whether tiling reduces total latency for the measured shapes",
  "initial_context": {
    "mode": "specified",
    "kernel_refs": ["k_tiled@r1", "kernels/reference/r1"],
    "knowledge_refs": ["sqlite://observation/tile-reuse", "notes/tiling.md"]
  },
  "hypothesis": {
    "statement": "Increasing tile reuse lowers total kernel latency on the fixed case suite",
    "scope": "The configured hardware, inputs, and measurement protocol",
    "predictions": ["Total latency decreases against a matched control"],
    "refutation_criteria": ["Valid matched measurements contradict the latency prediction"]
  }
}
```

`hypothesis` works with either context mode. It requires `statement` and optionally accepts `scope`, `mechanism`, `intervention`, `controls`, `predictions`, `support_criteria`, `refutation_criteria`, `confounders`, and `measurement_plan`. The child completes the experimental definition and tests the assigned hypothesis; it proposes its own hypothesis only when none was supplied. Revisions preserve the original wording and status, and support for a revised claim cannot establish the original claim.

Distributed kernels and knowledge are inspiration. The child can read other materials, choose different implementations, and need not modify a supplied kernel. Each research's `manifest.json` and `seed.json` preserve chief's inputs and the actual distribution. `research_id` and `budget` remain optional; case suite and backend/profile come from project configuration.

### Sustained Research

Users can simply ask **“持续研究当前算子的性能”** or **“继续研究”**. The existing Chief skill handles native goal setup/reuse, project and device preparation, subagent dispatch, report collection and follow-up selection. `meteor_start.goal` can focus on the research question; the persona, skills, configuration and startup packet carry the operating rules. Native goal rounds follow the host's configured limit. `meteor_init` also returns `template_root` so Chief can locate upgrade sources without asking for installation paths; existing customizations and frozen research remain preserved.

Chief may inspect a small set of relevant internal files and library evidence, and use available web tools to consult official vendor material before assigning a hypothesis. Once the hardware report is current and ready and the research objective is sufficient, it starts promptly instead of exhaustively reading source code or old logs.

For an authorized sustained goal, chief first completes one research to check reliable calls, tool execution, reporting and automatic integration. After that succeeds, it chooses concurrency within the overall budget, each research's budget, and device capacity. It collects the research and integration receipts, evaluates progress toward the overall goal, and starts another distinct research when work and budget remain. Native jobs and available durable goal facilities track this work. Completing one research does not complete the overall goal, and starting another research does not reset its budget. Unknown remote requests must be queried or collected before retrying their work.

Chief can use `meteor_control` with `action: "requests"` and `research_id` to list persisted SSH request identities, then `poll_request`, `collect_request`, or `cancel_request` with a returned `request_id` or `remote_request_id`. This remains available after the original child ends or the host restarts. It uses the research's frozen target, runtime and profile; it does not replay experiments, change the research's terminal state/budget, or turn raw remote evidence into an author submission. A changed central profile is rejected. Older research without the request journal remains unconfirmed through this entry; local build/run IDs are not remote request IDs.

Chief decides each start. The plugin creates one child per `meteor_start` and does not recursively create more research Agents. Credentials stay in centralized configuration and are excluded from prompts, task inputs and reports.

While a research job runs, Chief can review completed evidence or prepare the next hypothesis. When progress requires that job, it uses native `job_output` with `wait:true` and a bounded timeout instead of shell sleeps or rapid polling. In alpha.2 an armed goal continues independently of background-job state, so ending repeated empty turns is not a passive wait. The existing skill covers this distinction and completion notifications.

## Execution Backends

meteor starts unconfigured:

```json
{
  "execution": {
    "backend": "unconfigured",
    "profile_ref": ""
  }
}
```

Chief connects a centralized SSH profile through `meteor_hardware_probe`; the report establishes actual setup state. Do not fill device identity, memory, core counts or compiler architecture with example values. The project stores only a profile reference. Private keys, passwords, and tokens must stay in the user’s SSH agent, host config, or external credential provider.

The initial prototype used default mock execution. The user's 2026-09-24 requirement supersedes that behavior: mock is an explicit protocol-test option, never a fallback for unavailable hardware. Existing historical receipts remain unchanged and do not gain device-execution proof retroactively.

### Hardware Evidence And Measurement

A real `PASS` requires correct output and evidence that the target kernel executed on the requested AI Core/Vector device. SSH success, `simulated:false`, nonzero event time, or an unrelated device task is insufficient. Host CPU/NEON substitution and placeholder device kernels are not accepted. The authoring subagent remains responsible for each delivered revision's full-size test; chief's setup probe is separate.

Use `hardware.supported_metrics` and each tool's schema to select measurements. `kernel_time_us` is the runner's declared ACL event interval, not a hardware counter. `device_task_time_us` must not be requested or claimed unless the implemented capability is advertised in that report. Benchmark timing and profiler observations have different scopes and are kept separate. Official CLI examples in the [Ascend measurement guide](docs/ascend-measurement-guide.md) are manual diagnostic references to check against the installed version; they do not imply that every profiler feature is implemented by Meteor's tool interface.

### Automatic Remote Queue

Parallel research Agents can author and analyze independently. Their SSH builds,
single-kernel tests, profiles and hardware probes automatically share **one FIFO
execution slot per host/SSH account**, including across project roots and device
indices. The authoring Agent's tool call waits and returns its original result;
chief does not schedule individual tests. Full-suite timing and profiler capture
stay within the same slot. Polling exposes the queue position; raw receipts
retain wait duration separately from kernel samples.

The default Linux queue directory is `/tmp/meteor-execution-<uid>`. A centralized
SSH profile can set `queue_root` when accounts must share a permissioned local
directory; leave it unset for the normal single-account setup. Waiting consumes
research wall time but not the device command timeout. Cancellation removes a
waiting request or stops its executing command before release. OS-held tickets
prevent dead processes from blocking others, and keep a surviving command's
slot after its driver dies. Unknown remote outcomes remain unknown and are not
automatically rerun. See the [queue design and validation](docs/2026-09-24-remote-execution-queue.md).

## Research Shape

### Default Full-Size Suite

New projects use **192 fixed qmq-v1 shapes**, with an envelope of **M=1–8192, N=1–32769, K=1–8192**. The matrix retains the four previous smoke cases and adds alignment and routing boundaries, zero-input cases, and representative large matrices including 4096³. This is a finite selection, not the Cartesian product or a kernel support guarantee. See the [coverage policy](templates/project/cases/qmq-v1/int8/default/full-size-policy.md) and [existing-kernel audit](docs/2026-09-24-full-size-coverage.md).

Preparing inputs and CPU goldens requires about **201.5 MiB** of pinned binary data. Preparation is asynchronous and cancellable. Every delivered revision still needs its author's full single-kernel test, with unsupported cases counted separately from passes. Existing fixed suites and receipts are preserved; extending an old project requires selecting a new suite file before the next research.

Each research task uses:

- one base persona in `prompts/meteor.md`;
- two skills under `.dsh/skills/`;
- single-kernel build/test/profile tools;
- `meteor_prepare_submission` before final structured output;
- SQLite-backed knowledge and evidence records;
- automatic post-submission version assembly.

The research Agent tests chief's supplied hypothesis, or proposes a falsifiable hypothesis when none was supplied. Kernel performance, hypothesis verdict, and integration routing are recorded separately. Mock evidence can exercise protocol paths, but it cannot prove a real hardware hypothesis.

### Kernel Authoring

The same Agent writes expected hardware activities as source comments, implements them, observes test/profile evidence, and compares the evidence with its original expectations. `meteor_design` provides `open`, `check`, `freeze`, and `compare`; it does not launch another Agent. Both the primitive computation graph and execution IR live in one `meteor-ir:v1` source comment. `check` saves an immutable expectation before implementation, and `freeze` binds the exact candidate used for the next build.

The replaceable strategy registry defaults to `layered-ir@1`. The 28 computation-graph primitives describe hardware-independent semantics. Execution activity IDs/resources come exclusively from the frozen hardware model; no activity vocabulary is built into the parser. Shared checks enforce graph types/references, model membership, coverage, expected-before-code order and evidence identity. Model evidence uses documented/measured/hypothesis/unknown distinctions. Models and diagnostic sources bind the exact hardware report hash as well as device/environment identity; re-probing requires renewed preparation even when an unobserved runtime change leaves the stable environment ID unchanged. Existing research keeps its snapshot. Publishing validates provenance and structure, not the scientific interpretation of a source or universal hardware behavior. Read the [authoring guide](templates/project/tools/meteor/design/guide.md).

## Knowledge And Versioning

The initialized project contains `knowledge/catalog.sqlite` plus immutable claim JSON files in the four scope levels shown above. `scope_level` is hardware/op/dtype/shape; shape knowledge supplies `shape_range: {shape_id, dimensions: {axis: {min, max}}}` with inclusive positive bounds. Category is an independent tag. Automatic selection inherits HW → same op → same dtype → matching shape range; pass `initial_context.shape` to match intervals. Without shape context, shape claims are not automatically inherited. Explicit foreign-scope references remain readable as `inspiration_only`. Scope declarations are not proofs that a claim holds throughout a range.

SQLite indexes research, evidence, claims, novelty, commits, reports and integration events. Schema 3 maps legacy hardware applicability to hardware scope and other old claims to dtype scope, preserving original submissions/novelty. Historical claim files are not fabricated during migration. New commits write the four-level immutable claim files before the catalog transaction commits; a file conflict/failure rolls back catalog, commit and integration-event publication. Any already-written unindexed immutable files remain reusable on retry. Replaying the same commit does not refresh novelty. Explicit mock artifacts/catalogs stay under `.meteor/mock/`. Research snapshots carry knowledge code, never a live catalog.

After a valid final submission, meteor consumes the target's SQLite outbox. Within exactly the same workspace/op/dtype, it filters compatible full-size author receipts to recommended PASS cases, chooses the smallest measured median for each shape, then renders through the Chief-selected frozen template. Exactly equal medians retain historical priority; no near-tie threshold selects a slower kernel. The old `min_relative_improvement` config field is accepted for compatibility but no longer controls selection. The plugin emits source slots, implementation/bucket macro data and an exact-shape route body; the template defines its outer ABI and launcher call. See [assembly contract](templates/project/tools/meteor/assembly-guide.md). Unmeasured shapes are not inferred from a bucket. The integration result is an assembly artifact only:

- `integration_validation=NOT_RUN`
- no integrated-version benchmark is claimed
- no missing kernel tests are filled in by chief or integration

## Testing Rule For Live DSH Runs

Chief may use completed reports and reproducible behavior gaps to improve the project persona or relevant skills, then start future research with the updated snapshot. Keep current research snapshots and original evidence intact. Do not feed hints to the running Agent, write its final answer for it, or repair its research result manually. The project has one research persona, two research skills and one Chief hardware-preparation skill.

## Validation Commands

Run these commands from the repository root. With Python 3.12, install the same oracle dependency used in CI:

```bash
python -m pip install numpy==1.26.4
npm run check
npm test
npm run build
npm run demo
```

`check` verifies JavaScript/TypeScript syntax and source whitespace. `test` runs the local contract and evidence tests; a native DSH compatibility case is skipped unless `METEOR_DSH_MODULE_ROOT` is set. `demo` exercises mock research, evidence, submission and automatic version assembly. None of these commands proves hardware kernel performance.

For strict TypeScript checking, install development-only compiler and Node declarations locally without changing the package manifest or creating a lockfile, then use the project's `tsconfig.json`:

```bash
npm install --no-save --package-lock=false typescript@5.9.3 @types/node@24
npx --no-install tsc --project tsconfig.json
```

### Native DSH Web Compatibility

Install the exact supported DSH release separately from Meteor's runtime, then build and run the full-profile smoke:

```bash
npm install --prefix ../meteor-dsh-test @deepseek-ai/dsh@0.1.7-alpha.2
npm run build
node scripts/verify-dsh-web.mjs ../meteor-dsh-test/node_modules
```

To include the native Cordis/ToolRuntime case in `tests/dsh.test.ts`, point `METEOR_DSH_MODULE_ROOT` at that installation's `node_modules` directory:

```bash
METEOR_DSH_MODULE_ROOT=../meteor-dsh-test/node_modules node --test tests/dsh.test.ts
```

In PowerShell, set the variable before invoking the test:

```powershell
$env:METEOR_DSH_MODULE_ROOT = (Resolve-Path ../meteor-dsh-test/node_modules).Path
node --test tests/dsh.test.ts
```

The full Web-profile smoke passed against alpha.2 on 2026-09-23. It starts the official Web composition in an isolated temporary `DSH_HOME`, loads Meteor, creates a native chief and research child, and verifies the same child session ID, frozen scoped skills, native structured output, recursive-delegation denial, job cancellation and report delivery. It also checks that the native compaction service is available. The script blocks all model steps and makes zero model requests; it does not perform an actual compaction or run an Ascend operator. User credential files are not copied into the temporary home.

A subsequent native check reproduced missing project skills when the experiment directory was nested beneath another Git root. A stronger check then showed that global provider rank alone cannot override chief's scoped filesystem provider. The correction registers current-project discovery in chief's own scope. The expanded real Web-profile smoke passed with zero model requests: bundled skills load before initialization, current-cwd skills override the parent Git project's skills, `meteor_init` refreshes discovery, and the child's frozen skill bodies remain independent. The project suite passed 96/96 and TypeScript checking passed. These checks do not establish API stability or sustained research performance.

A completed real model-authored operator run is not claimed by these checks. See [DSH compatibility](docs/dsh-compatibility.md) for exact API contracts and verification limits, and [implementation provenance](docs/implementation-provenance.md) for design sources.
