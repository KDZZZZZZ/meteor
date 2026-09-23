# Meteor Remote QMQ Driver

The TypeScript SSH transport deploys this directory as an immutable bundle to:

```text
<remote_root>/drivers/<bundle_hash>/
```

`bundle_hash` covers the bundled filenames, contents and per-file hashes. Existing files must match the supplied content; a changed bundle is deployed under a new hash. By default, after sourcing the profile's CANN environment script, the transport runs:

```bash
python3 <remote_root>/drivers/<bundle_hash>/driver.py < request.json
```

A centralized profile can explicitly override `driver_path`. SSH authentication remains in the system SSH configuration or agent; no SSH key is deployed with the bundle. The remote environment needs Python 3 with NumPy, CMake, the configured CANN compiler/runtime and a usable Ascend device.

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

- `action`: `build`, `test`, `profile`, `poll`, `collect`, or `cancel`
- `request_id`: stable idempotency key
- `remote_root`: absolute POSIX directory

Build request:

- `source_base64`: rendered single-kernel ASC source
- `rendered_source_hash`: sha256 of decoded source
- `build_id`: immutable build identity
- `npu_arch`: currently only `dav-2201`

Test request:

- `build_id`
- `artifact_hash`: exact executable/source identity returned by the build
- `device_id`
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

Profile request:

- The same build identity, case files, device and measurement fields as a test request.
- `metrics`: currently use `["kernel_time_us"]`.

The only implemented profile metric is `kernel_time_us`, measured with ACL events around `run_kernel`. The driver reruns the requested supported cases under the device lock, verifies their outputs, and emits one median-latency observation for each passing case. Individual samples and case outcomes remain in `raw_profiles`; cases outside `supported_case_ids` are recorded as `UNSUPPORTED` and produce no metric observation.

Any other requested metric fails closed with `status=FAILED`, `instrumented=false` and an `unsupported_metrics` list. No msprof hardware-counter mapping is implemented, and ACL elapsed time must not be presented as cache, bandwidth, occupancy or utilization counters.

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
  requests/<request_id>/
    payload.json
    payload_hash.txt
    status.json
    result.json
    cancel.json
    operation.lock
  .device-<device_id>.lock
```

For build, test and profile actions, repeating the same `request_id` with the same payload returns the previous result when finished, or its running/unknown state while work remains active. Repeating it with a different payload fails. The SSH transport assigns a new request ID to a new measurement unless the caller supplies an idempotency key; replaying an existing request does not produce another independent measurement.

## Timing Contract

`main.asc` performs warmup calls, then measures only `run_kernel` with ACL events.
It prints machine-readable markers:

```text
QMQ_TIMING_US sample=0 value=123.456
```

The driver reports these marker values as `samples_us` and derives `median_us` from the measured repetitions. Profile observations expose that median as `kernel_time_us`. Process duration is not used as kernel latency.

## Local Tests

Tests may set `METEOR_REMOTE_DRIVER_FAKE_BUILD=1`. This creates a fake local executable for metadata, idempotency, and receipt tests only. Real SSH/CANN execution must not set this environment variable.

From the Meteor repository root, `node --test tests/remote-driver.test.ts` runs the driver contract tests. NumPy must be installed for the bundled oracle checks. A passing fake-executable test does not establish a successful real operator build, NPU execution or hardware-performance result.
