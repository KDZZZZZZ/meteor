# Meteor Remote QMQ Driver

The TypeScript SSH transport deploys this directory as an immutable bundle to:

```text
<remote_root>/drivers/<bundle_hash>/
```

`bundle_hash` covers the bundled filenames, contents and per-file hashes. Existing files must match the supplied content; a changed bundle is deployed under a new hash. By default, after sourcing the profile's CANN environment script, the transport runs:

```bash
python3 <remote_root>/drivers/<bundle_hash>/driver.py < request.json
```

A centralized profile can explicitly override `driver_path`. SSH authentication remains in the system SSH configuration or agent; no SSH key is deployed with the bundle. The remote environment needs Python 3 with NumPy, CMake, the configured CANN compiler/runtime, `msprof` and a usable Ascend device.

Projects start with `execution.backend: "unconfigured"`. Chief calls `meteor_hardware_probe(profile_ref?)` after initialization, reads its hardware report, resolves setup diagnostics and probes again when needed. The CLI equivalent is `meteor hardware [directory] [profile-ref]`. A central profile supplies connection and environment configuration; measured device facts come from the probe. Real research, build, test and profile operations require a valid READY report bound to the current profile and environment. A changed profile or failed re-probe invalidates the previous readiness.

The driver reads one JSON object from stdin and writes one JSON response to stdout:

```json
{"ok": true, "action": "build", "request_id": "req-1", "result": { "...": "..." }}
```

Errors are reported as:

```json
{"ok": false, "error": "message"}
```

## Request API

Common fields:

- `action`: `hardware`, `build`, `test`, `profile`, `poll`, `collect`, or `cancel`
- `request_id`: stable idempotency key
- `remote_root`: absolute POSIX directory

### Hardware request

- Common fields above.
- Optional `device_id`: logical device selected by the central profile. Without it, discovery selects a runtime-visible device with a reported SoC and NPU architecture.

The driver builds and runs `hardware_probe.cpp` to query runtime device count, logical IDs, SoC, `GetCurNpuArch()`, Cube core count and HBM memory. `npu-smi info` and `info -m` supplement physical card/chip mapping; memory and health commands, compiler versions and `msprof --help` are preserved in command logs. Structured health comes from the selected card/chip's health output. Unavailable fields, including runtime version, remain null with diagnostics; inspect the raw logs instead of inventing values.

The discovered architecture then compiles `hardware_add_host.asc` / `hardware_add.asc`. Under the device lock, this minimal Ascend C add uses aligned GM/UB copies with explicit pipeline dependencies, verifies its output and produces an `msprof` task matching `meteor_hardware_add_kernel` on the selected logical device. Architecture is not inferred from a product name or defaulted to `dav-2201`. Compilation or correctness failure leaves profiler status `NOT_RUN`; that is distinct from an actual collection failure or an unmatched collected task.

Important result fields:

- `status`: operation completion; `COMPLETED` alone does not imply hardware readiness.
- `readiness`: `READY` or `BLOCKED`; the host also verifies `simulated: false`, selected device/SoC/architecture, `validation.compile`, `validation.launch`, `validation.correctness` and confirmed device execution.
- `selected_device`, `devices`, `device_count`: discovered inventory and selected execution target.
- `validation.runtime_discovery`: results of the host-side ACL/platform query; `validation.device_execution`: the minimal add's device-task evidence.
- `supported_metrics`, `cann`, `tools`, `probe`, `logs`: implemented metric names, tool discovery and original evidence.

Chief's tool saves immutable JSON and readable Markdown reports under `reports/meteor/ssh/hardware/`, returns `hardware_report_ref`, `hardware_report_path`, `hardware_ready`, `state` and `case_setup`, and configures measured environment fields only after validation. A hardware-ready result can still need case-suite setup before `state: "ready_ssh"`. This add probe establishes environment readiness; each candidate kernel needs its own correctness and device-execution evidence.

### Build request

- `source_base64`: rendered single-kernel ASC source
- `rendered_source_hash`: sha256 of decoded source
- `build_id`: immutable build identity
- `npu_arch`: nonempty architecture from the verified hardware report/profile, passed to CANN as `--npu-arch`; actual compiler support is established by the build, with no fixed `dav-2201` assumption

### Test request

- `build_id`
- `artifact_hash`: exact executable/source identity returned by the build
- `rendered_source_hash`: source identity returned by the build
- `device_id`
- `kernel_name`: the candidate module's `symbol_prefix`, supplied by the SSH adapter; the driver also accepts a `kernel_names` list
- `warmup`: expected `3`
- `repetitions`: expected `5`
- `cases`: explicit case objects with `case_id`, `shape`, `input_hash`, `oracle_hash`, and `files`
- `supported_case_ids`
- `case_suite_revision`, `environment_ref`, `measurement_protocol_ref`

Each case file record is:

```json
{"base64": "...", "sha256": "..."}
```

and paths are the oracle harness paths, such as `input/x1.bin` and `golden/y.bin`.

The SSH adapter binds the module/revision and source to the build receipt. The driver rechecks the executable/source/architecture artifact identity before execution, and the adapter checks returned identities and case input/oracle hashes. For a real case to be `PASS`, its output verification and timing samples must also be accompanied by `device_execution.status: "CONFIRMED"` for the candidate symbol prefix and selected logical device. ACL event samples alone cannot establish device execution.

After normal timing, a separate `msprof` run collects `op_summary` files. The driver matches the supplied kernel name within the reported operation name and accepts AI Core, AI Vector or MIX AIC task types on the requested device. Unrelated tasks, AI CPU tasks and copies cannot satisfy that witness. Results retain `profile_dir`, `op_summary_refs`, `matched_task_count`, `task_types` and up to 20 `matched_tasks` including device/name/type and available task, stream, duration and block fields. Missing profiler output or no matching task changes an otherwise passing real case to `RUN_FAILED`; it does not by itself prove that the implementation ran on CPU. Researchers must still inspect the launch/dataflow and reject CPU fallback implementations: a matching task proves that task executed, not that every output was computed by it.

### Profile request

- The same build identity, case files, device and measurement fields as a test request.
- `metrics`: select from the hardware report's `supported_metrics`; the current driver implements `kernel_time_us` and `device_task_time_us`.

The driver reruns the requested supported cases under the device lock, verifies their outputs and requires the same candidate device witness. Individual event samples and case outcomes remain in `raw_profiles`; cases outside `supported_case_ids` are recorded as `UNSUPPORTED` and produce no metric observation.

| Metric | Measurement kind | Meaning |
| --- | --- | --- |
| `kernel_time_us` | `acl_event_interval` | Median of normal-run ACL event intervals around `run_kernel`. |
| `device_task_time_us` | `msprof_task_duration` | Median of numeric `task_duration_us` values in the retained matching device tasks from the separate profiler run. No observation is emitted when those fields are absent. |

The task-duration aggregation currently includes the retained matching launches, which can include warmup; it is not aligned one-for-one with the five normal timing samples. Neither metric is a PMU counter. The witness command requests `PipeUtilization`, but the driver does not expose cache, bandwidth, occupancy or utilization counter mappings. `instrumented: true` means the request included `device_task_time_us`; event-only requests report false even though a separate device witness is still required. The top-level `measurement_kind` is `acl_event_interval` for an event-only request and `mixed` otherwise; each observation carries its own kind.

Any other requested metric fails closed with `status=FAILED`, `instrumented=false` and an `unsupported_metrics` list. Capability advertisement does not guarantee that a particular capture yields an observation; inspect `raw_profiles` and command logs when capture fails. Keep profiler timing separate from normal benchmark latency. See the [Ascend measurement reference](../../../../.dsh/skills/meteor-kernel-test/references/ascend-measurement.md) for version-specific diagnostics and measurement guidance.

Polling and cancellation:

- `poll` returns finished result, running state, or not found.
- `collect` returns the durable result when available.
- `cancel` writes a cancellation marker consumed at execution boundaries and reports `remote_released:false`. Use `poll`/`collect` to establish the eventual outcome; requesting cancellation alone does not prove the remote process stopped.

## Durable Layout

```text
<remote_root>/
  drivers/<bundle_hash>/
    driver.py
    CMakeLists.txt
    main.asc
    hardware_probe.cpp
    hardware_add.asc
    hardware_add_host.asc
    gen_case.py
    verify_case.py
  builds/<build_id>/
    kernel.asc
    CMakeLists.txt
    main.asc
    gen_case.py
    verify_case.py
    build-result.json
    cmake-build/qmq_remote_main
  runs/<request_id>/<case_id>/
  profiles/<request_id>/<case_id>/
  hardware-probes/<request_id>/
    cmake-build/meteor_hardware_probe
    cmake-build/meteor_hardware_add
  hardware-probe-runs/<request_id>/msprof/
  requests/<request_id>/
    payload.json
    payload_hash.txt
    status.json
    result.json
    cancel.json
    operation.lock
  .device-<device_id>.lock
```

For hardware, build, test and profile actions, repeating the same `request_id` with the same payload returns the previous result when finished, or its running/unknown state while work remains active. Repeating it with a different payload fails. The SSH transport assigns a new request ID to a new measurement unless the caller supplies an idempotency key; replaying an existing request does not produce another independent measurement.

## Timing Contract

`main.asc` allocates and copies inputs before timing, performs warmup calls with stream synchronization, then records start/stop ACL events on the same stream around `run_kernel`. It synchronizes the stop event before reading elapsed milliseconds and converting to microseconds. Output copies and verification occur after the timed interval. An event interval can include submission/scheduling gaps and is not a pure instruction-cycle measurement.
It prints machine-readable markers:

```text
QMQ_TIMING_US sample=0 value=123.456
```

The driver reports these marker values as `samples_us` and derives `median_us` from the measured repetitions. Profile observations expose that median as `kernel_time_us`. Process duration is not used as kernel latency.

## Local Tests

Tests may set `METEOR_REMOTE_DRIVER_FAKE_BUILD=1`. This creates a fake local executable for metadata, idempotency, and receipt tests only. Its hardware action always reports `readiness: "BLOCKED"` with simulated evidence. Real SSH/CANN execution must not set this environment variable.

From the Meteor repository root, `node --test tests/remote-driver.test.ts` runs the driver contract tests. NumPy must be installed for the bundled oracle checks. A passing fake-executable test does not establish a successful real operator build, NPU execution or hardware-performance result.
