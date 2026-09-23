# meteor

DeepSeek Harness plugin for hypothesis-driven Ascend C kernel research.

meteor lets a chief agent initialize a local research workspace, start one continuous research subagent per `research_id`, run mock or configured SSH-backed kernel experiments, validate full-size single-kernel evidence, store structured knowledge in SQLite, and automatically assemble a routed version after a valid final submission.

## Requirements

- Node.js 24 or newer.
- Python 3.12 or newer.
- No npm runtime dependencies.

The project uses Node 24 native TypeScript execution in tests and the Python standard-library `sqlite3` module for the structured knowledge store. Full remote-driver/oracle tests also require NumPy; CI uses Python 3.12 with NumPy 1.26.4. The Python executable must be available as `python`, or selected with the `PYTHON` environment variable.

## Quick Start

```bash
npm run build
node dist/src/cli.js init
npm run demo
```

`init` writes the project template into the current directory. The default backend is mock, so the demo does not require SSH, CANN, or NPU access.

## DSH Web Loading

meteor targets DSH **0.1.7-alpha.2**. In DSH Web, load the plugin from this repository build output, then use the registered chief tools:

- `meteor_init`
- `meteor_start`
- `meteor_status`
- `meteor_control`
- `meteor_evidence`

The native run starts one spawned research Agent, keeps one session for the whole research loop, registers the two meteor skills into that child session, and accepts only a prepared submission from that same session.

### Starting A Research Task

Chief chooses the goal, budget, initial materials, and optionally a hypothesis to test. Pass an object to `meteor_start`. Omitting `initial_context` uses the project's freshness-based random sampling:

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

Use `specified` to distribute selected kernels and knowledge without adding random materials. References accept library material IDs, `sqlite://kind/id`, or file/module paths. Replace the example references below with materials present in your project:

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

## Execution Backends

meteor starts in mock mode:

```json
{
  "execution": {
    "backend": "mock",
    "profile_ref": "mock-qmq-v1"
  }
}
```

SSH is enabled by changing the backend/profile configuration and providing a centralized SSH profile. The project stores only a profile reference. Private keys, passwords, and tokens must stay in the user’s SSH agent, host config, or external credential provider.

## Research Shape

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

When a live DSH research Agent behaves poorly, improve the relevant meteor skill prompts and rerun the test. Do not feed hints to the running Agent, write its final answer for it, or repair its research result manually.

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

A completed real model-authored operator run is not claimed by these checks. See [DSH compatibility](docs/dsh-compatibility.md) for exact API contracts and verification limits, and [implementation provenance](docs/implementation-provenance.md) for design sources.
