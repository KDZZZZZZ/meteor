# meteor

DeepSeek Harness plugin for hypothesis-driven Ascend C kernel research.

meteor lets a chief agent initialize a local research workspace, prepare a real SSH device and hardware report, start one continuous research subagent per `research_id`, validate full-size single-kernel evidence, store structured knowledge in SQLite, and automatically assemble a routed version after a valid final submission. Mock execution is reserved for explicitly selected protocol tests.

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

`init` writes the project template into the current directory with backend `unconfigured`. Replace `my-central-profile` with a configured central SSH profile reference. The CLI form is `meteor hardware [directory] [profile-ref]`; when the profile reference is omitted, it uses the project's configured reference. Inspect the returned hardware report, supported capabilities and setup status before starting research. Missing configuration or a failed device probe leaves the project unready.

For a local protocol demonstration only, run `npm run demo`. It explicitly selects mock fixtures and does not require SSH, CANN or an NPU; it does not establish device readiness or hardware performance.

## DSH Web Loading

meteor targets DSH **0.1.7-alpha.2**. In DSH Web, load the plugin from this repository build output, then use the registered chief tools:

- `meteor_init`
- `meteor_hardware_probe`
- `meteor_start`
- `meteor_status`
- `meteor_control`
- `meteor_evidence`

The native run starts one spawned research Agent, keeps one session for the whole research loop, registers the two meteor skills into that child session, and accepts only a prepared submission from that same session.

The UI user can give a short goal, such as “Investigate qmq kernel performance within the configured budget.” The existing `meteor-kernel-test` skill contains chief's initialization, device preparation, startup, waiting and continuation duties. Chief calls `meteor_init` for a missing project, then `meteor_hardware_probe` with an optional `profile_ref`, reads the report and resolves setup failures before research. A successful probe records actual device/toolchain identity and capability; it does not replace the child's tests of its own kernels. The native `meteor-skills` integration uses a global provider for bundled defaults and a provider registered in chief's scope when that Agent is created, so current-project skills can take precedence over a parent Git repository's skills. Research children keep their frozen skill layer.

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

## Research Shape

### Default Full-Size Suite

New projects use **192 fixed qmq-v1 shapes**, with an envelope of **M=1–8192, N=1–32769, K=1–8192**. The matrix retains the four previous smoke cases and adds alignment and routing boundaries, zero-input cases, and representative large matrices including 4096³. This is a finite selection, not the Cartesian product or a kernel support guarantee. See the [coverage policy](templates/project/asc/full-size-policy.md) and [existing-kernel audit](docs/2026-09-24-full-size-coverage.md).

Preparing inputs and CPU goldens requires about **201.5 MiB** of pinned binary data. Preparation is asynchronous and cancellable. Every delivered revision still needs its author's full single-kernel test, with unsupported cases counted separately from passes. Existing fixed suites and receipts are preserved; extending an old project requires selecting a new suite file before the next research.

Each research task uses:

- one base persona in `prompts/meteor.md`;
- two skills under `.dsh/skills/`;
- single-kernel build/test/profile tools;
- `meteor_prepare_submission` before final structured output;
- SQLite-backed knowledge and evidence records;
- automatic post-submission version assembly.

The research Agent tests chief's supplied hypothesis, or proposes a falsifiable hypothesis when none was supplied. Kernel performance, hypothesis verdict, and integration routing are recorded separately. Mock evidence can exercise protocol paths, but it cannot prove a real hardware hypothesis.

## Knowledge And Versioning

The initialized project contains a structured SQLite library under `reports/meteor/<backend>/knowledge/catalog.sqlite`, with normalized tables for research runs, hypotheses, experiments, kernel submissions, measurements, knowledge claims, novelty events, commits, reports, and integration events.

After a valid final submission, meteor automatically consumes the SQLite outbox, selects compatible full-size single-kernel measurements by exact case, and renders a routed version through `asc/version.asc.tmpl`. The integration result is an assembly artifact only:

- `integration_validation=NOT_RUN`
- no integrated-version benchmark is claimed
- no missing kernel tests are filled in by chief or integration

## Testing Rule For Live DSH Runs

Chief may use completed reports and reproducible behavior gaps to improve the existing project persona or either skill, then start future research with the updated snapshot. Keep the current research's snapshot and original evidence intact. Do not feed hints to the running Agent, write its final answer for it, or repair its research result manually. The project retains one persona and two skills.

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
