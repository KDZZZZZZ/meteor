#!/usr/bin/env python3
"""Meteor remote QMQ driver.

The TS SSH transport deploys this directory to
``remote_root/drivers/<bundle_hash>`` and sends one JSON request on stdin. The
driver is intentionally stdlib-only; oracle helpers are bundled beside it.
"""

from __future__ import annotations

import base64
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import stat
import subprocess
import sys
import time
from typing import Any


DRIVER_DIR = Path(__file__).resolve().parent
TIMING_PREFIX = "QMQ_TIMING_US "


def canonical(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def hash_object(value: Any) -> str:
    return sha256_text(canonical(value))


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def sha256_text(text: str) -> str:
    return sha256_bytes(text.encode("utf-8"))


def load_stdin() -> dict[str, Any]:
    try:
        data = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        raise ValueError(f"invalid JSON stdin: {exc}") from exc
    if not isinstance(data, dict):
        raise ValueError("request must be a JSON object")
    return data


def b64decode_checked(text: str, expected_sha: str | None = None) -> bytes:
    if not isinstance(text, str):
        raise ValueError("base64 value must be a string")
    try:
        data = base64.b64decode(text.encode("ascii"), validate=True)
    except Exception as exc:
        raise ValueError("invalid base64 payload") from exc
    if expected_sha is not None and sha256_bytes(data) != expected_sha:
        raise ValueError(f"sha256 mismatch: expected {expected_sha}, got {sha256_bytes(data)}")
    return data


def require_id(value: Any, name: str) -> str:
    if not isinstance(value, str) or not value or len(value) > 120:
        raise ValueError(f"{name} must be a nonempty string up to 120 chars")
    allowed = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_.-")
    if value[0] in ".-" or any(ch not in allowed for ch in value) or ".." in value:
        raise ValueError(f"invalid {name}")
    return value


def require_remote_root(value: Any) -> Path:
    if os.environ.get("METEOR_REMOTE_DRIVER_ALLOW_NON_POSIX_ROOT") == "1":
        if not isinstance(value, str):
            raise ValueError("remote_root must be a path string")
        path = Path(value)
        if not path.is_absolute() or ".." in path.parts:
            raise ValueError("test remote_root must be an absolute local path without '..'")
        return path
    if not isinstance(value, str) or not value.startswith("/"):
        raise ValueError("remote_root must be an absolute POSIX path")
    parts = Path(value).parts
    if ".." in parts:
        raise ValueError("remote_root cannot contain '..'")
    return Path(value)


def inside(root: Path, *parts: str) -> Path:
    path = (root.joinpath(*parts)).resolve()
    resolved = root.resolve()
    try:
        path.relative_to(resolved)
    except ValueError as exc:
        raise ValueError(f"path escapes root: {path}") from exc
    return path


def write_json(path: Path, value: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(value, indent=2, sort_keys=True, ensure_ascii=True) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def setup_request(request: dict[str, Any]) -> tuple[Path, Path, str]:
    remote_root = require_remote_root(request.get("remote_root"))
    request_id = require_id(request.get("request_id"), "request_id")
    request_dir = inside(remote_root, "requests", request_id)
    request_dir.mkdir(parents=True, exist_ok=True)
    payload_hash = sha256_text(canonical(request))
    payload_path = request_dir / "payload_hash.txt"
    if payload_path.exists():
        prior = payload_path.read_text(encoding="utf-8").strip()
        if prior != payload_hash:
            raise ValueError("request_id already used for a different payload")
    else:
        payload_path.write_text(payload_hash + "\n", encoding="utf-8")
        write_json(request_dir / "payload.json", request)
    return remote_root, request_dir, payload_hash


def request_paths(request: dict[str, Any]) -> tuple[Path, Path, str]:
    remote_root = require_remote_root(request.get("remote_root"))
    request_id = require_id(request.get("request_id"), "request_id")
    request_dir = inside(remote_root, "requests", request_id)
    return remote_root, request_dir, sha256_text(canonical(request))


class OperationLock:
    def __init__(self, request_dir: Path):
        self.path = request_dir / "operation.lock"
        self.acquired = False

    def __enter__(self):
        try:
            os.mkdir(self.path)
            self.acquired = True
        except FileExistsError:
            self.acquired = False
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.acquired:
            try:
                os.rmdir(self.path)
            except FileNotFoundError:
                pass


def finish(request_dir: Path, result: dict[str, Any]) -> dict[str, Any]:
    result = {**result, "finished_at": time.time()}
    write_json(request_dir / "result.json", result)
    write_json(request_dir / "status.json", {"state": "finished", "status": result.get("status"), "finished_at": result["finished_at"]})
    return result


def mark_running(request_dir: Path, action: str) -> None:
    write_json(request_dir / "status.json", {"state": "running", "action": action, "pid": os.getpid(), "started_at": time.time()})


def maybe_existing_result(request_dir: Path) -> dict[str, Any] | None:
    result_path = request_dir / "result.json"
    if result_path.exists():
        return read_json(result_path)
    return None


def pid_is_alive(pid: Any) -> bool | None:
    if not isinstance(pid, int):
        return None
    if os.name == "posix":
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False
    return True


def running_or_unknown(request_dir: Path, simulated: bool) -> dict[str, Any]:
    status_path = request_dir / "status.json"
    if not status_path.exists():
        return {"status": "RUNNING", "simulated": simulated, "reason": "request operation lock is held"}
    status = read_json(status_path)
    alive = pid_is_alive(status.get("pid"))
    if alive is True:
        return {"status": "RUNNING", "simulated": simulated, "state": status}
    return {"status": "UNKNOWN_REMOTE", "simulated": simulated, "state": status, "reason": "previous request did not finish and no live pid was confirmed"}


def guard_before_execution(request_dir: Path, simulated: bool) -> dict[str, Any] | None:
    existing = maybe_existing_result(request_dir)
    if existing is not None:
        return existing
    status_path = request_dir / "status.json"
    if not status_path.exists():
        return None
    status = read_json(status_path)
    if status.get("state") != "running":
        return None
    alive = pid_is_alive(status.get("pid"))
    if alive is True:
        return {"status": "RUNNING", "simulated": simulated, "state": status}
    return {"status": "UNKNOWN_REMOTE", "simulated": simulated, "state": status, "reason": "previous request stopped before completion"}


class DeviceLock:
    def __init__(self, remote_root: Path, device_id: int):
        self.path = inside(remote_root, f".device-{device_id}.lock")
        self.file = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.file = open(self.path, "a+", encoding="utf-8")
        if os.name == "posix":
            import fcntl
            fcntl.flock(self.file.fileno(), fcntl.LOCK_EX)
        else:
            import msvcrt
            msvcrt.locking(self.file.fileno(), msvcrt.LK_LOCK, 1)
        self.file.seek(0)
        self.file.truncate()
        self.file.write(json.dumps({"pid": os.getpid(), "locked_at": time.time()}) + "\n")
        self.file.flush()
        return self

    def __exit__(self, exc_type, exc, tb):
        if self.file is None:
            return
        try:
            self.file.seek(0)
            self.file.truncate()
            self.file.flush()
        finally:
            if os.name == "posix":
                import fcntl
                fcntl.flock(self.file.fileno(), fcntl.LOCK_UN)
            else:
                import msvcrt
                self.file.seek(0)
                msvcrt.locking(self.file.fileno(), msvcrt.LK_UNLCK, 1)
            self.file.close()


def run_command(command: list[str], cwd: Path, timeout: int = 900) -> dict[str, Any]:
    started = time.time()
    proc = subprocess.run(command, cwd=str(cwd), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=timeout)
    return {
        "command": command,
        "returncode": proc.returncode,
        "stdout": proc.stdout[-20000:],
        "stderr": proc.stderr[-20000:],
        "duration_seconds": time.time() - started,
    }


def install_harness(build_dir: Path) -> None:
    for name in ("CMakeLists.txt", "main.asc", "gen_case.py", "verify_case.py"):
        shutil.copy2(DRIVER_DIR / name, build_dir / name)


def make_fake_executable(path: Path) -> None:
    path.write_text(
        "#!/usr/bin/env python3\n"
        "from pathlib import Path\n"
        "import shutil, sys\n"
        "m,n,k=sys.argv[1:4]\n"
        "Path('output').mkdir(exist_ok=True)\n"
        "shutil.copyfile('golden/y.bin','output/y.bin')\n"
        "shutil.copyfile('golden/yScale.bin','output/yScale.bin')\n"
        "reps=int(sys.argv[6]) if len(sys.argv)>6 else 5\n"
        "for i in range(reps): print(f'QMQ_TIMING_US sample={i} value={10.0+i:.3f}')\n"
        "print(f'QMQ_FAKE_RUN M={m} N={n} K={k}', file=sys.stderr)\n",
        encoding="utf-8",
    )
    path.chmod(path.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    py_path = path.with_name(path.name + ".py")
    py_path.write_text(path.read_text(encoding="utf-8"), encoding="utf-8")


def action_build(request: dict[str, Any], remote_root: Path, request_dir: Path) -> dict[str, Any]:
    simulated = os.environ.get("METEOR_REMOTE_DRIVER_FAKE_BUILD") == "1"
    guarded = guard_before_execution(request_dir, simulated)
    if guarded is not None:
        return guarded
    mark_running(request_dir, "build")
    build_id = require_id(request.get("build_id"), "build_id")
    npu_arch = request.get("npu_arch") or "dav-2201"
    if npu_arch != "dav-2201":
        raise ValueError("only npu_arch=dav-2201 is supported by this driver")
    source = b64decode_checked(request.get("source_base64"), request.get("rendered_source_hash"))
    build_dir = inside(remote_root, "builds", build_id)
    build_dir.mkdir(parents=True, exist_ok=True)
    kernel_path = build_dir / "kernel.asc"
    if kernel_path.exists() and sha256_bytes(kernel_path.read_bytes()) != request.get("rendered_source_hash"):
        raise ValueError("build_id already contains a different kernel.asc")
    kernel_path.write_bytes(source)
    install_harness(build_dir)
    logs: list[dict[str, Any]] = []
    if simulated:
        exe = build_dir / "qmq_remote_main"
        make_fake_executable(exe)
        logs.append({"command": ["fake-build"], "returncode": 0, "stdout": "", "stderr": ""})
    else:
        cmake_dir = build_dir / "cmake-build"
        cmake_dir.mkdir(exist_ok=True)
        logs.append(run_command(["cmake", "-S", str(build_dir), "-B", str(cmake_dir), f"-DNPU_ARCH={npu_arch}", f"-DQMQ_KERNEL_PATH={kernel_path}"], build_dir))
        if logs[-1]["returncode"] == 0:
            logs.append(run_command(["cmake", "--build", str(cmake_dir), "--target", "qmq_remote_main", "-j2"], build_dir))
        exe = cmake_dir / "qmq_remote_main"
    status = "COMPLETED" if logs and all(item["returncode"] == 0 for item in logs) and exe.exists() else "FAILED"
    result = {
        "status": status,
        "backend": "ssh",
        "simulated": simulated,
        "remote_build_id": build_id,
        "artifact_hash": sha256_text(canonical({
            "kernel": request.get("rendered_source_hash"),
            "executable": sha256_bytes(exe.read_bytes()) if exe.exists() else None,
            "npu_arch": npu_arch,
        })),
        "logs": logs,
        "executable": str(exe),
        "rendered_source_hash": request.get("rendered_source_hash"),
    }
    write_json(build_dir / "build-result.json", result)
    return finish(request_dir, result)


def verifier_sha256() -> str:
    return sha256_bytes((DRIVER_DIR / "verify_case.py").read_bytes())


def validate_case_hashes(case: dict[str, Any], files: dict[str, dict[str, Any]]) -> tuple[str | None, str | None]:
    input_map = {path: record["sha256"] for path, record in files.items() if path.startswith("input/")}
    golden_map = {path: record["sha256"] for path, record in files.items() if path.startswith("golden/")}
    input_hash = hash_object(input_map) if input_map else None
    oracle_hash = hash_object({"verifier_sha256": verifier_sha256(), "golden": golden_map}) if golden_map else None
    requested_input = case.get("input_hash")
    requested_oracle = case.get("oracle_hash")
    if requested_input is not None and requested_input != input_hash:
        raise ValueError(f"input_hash mismatch for case {case.get('case_id')}: expected {requested_input}, got {input_hash}")
    if requested_oracle is not None and requested_oracle != oracle_hash:
        raise ValueError(f"oracle_hash mismatch for case {case.get('case_id')}: expected {requested_oracle}, got {oracle_hash}")
    return input_hash, oracle_hash


def write_case_files(case_dir: Path, case: dict[str, Any]) -> tuple[str | None, str | None]:
    files = case.get("files")
    if not isinstance(files, dict):
        raise ValueError("case files must be an object")
    metadata_files: dict[str, dict[str, Any]] = {}
    supplied_case_json: dict[str, Any] | None = None
    for rel, record in files.items():
        if not isinstance(record, dict):
            raise ValueError("case file record must be an object")
        if rel.startswith("/") or ".." in Path(rel).parts:
            raise ValueError(f"invalid case file path: {rel}")
        data = b64decode_checked(record.get("base64"), record.get("sha256"))
        out = case_dir / rel
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(data)
        if rel == "case.json":
            supplied_case_json = json.loads(data.decode("utf-8"))
            continue
        metadata_files[rel] = {"bytes": len(data), "sha256": sha256_bytes(data)}
    computed = validate_case_hashes(case, metadata_files)
    if supplied_case_json is not None:
        return computed
    shape = case.get("shape") or {}
    metadata = {
        "format_version": 1,
        "m": shape.get("m"),
        "n": shape.get("n"),
        "k": shape.get("k"),
        "seed": 0,
        "mode": "provided",
        "files": metadata_files,
    }
    (case_dir / "case.json").write_text(json.dumps(metadata, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return computed


def parse_timings(stdout: str) -> list[float]:
    values: list[float] = []
    for line in stdout.splitlines():
        if not line.startswith(TIMING_PREFIX):
            continue
        fields = dict(part.split("=", 1) for part in line[len(TIMING_PREFIX):].split() if "=" in part)
        if "value" in fields:
            values.append(float(fields["value"]))
    return values


def median(values: list[float]) -> float | None:
    if not values:
        return None
    ordered = sorted(values)
    return ordered[len(ordered) // 2]


def load_build_executable(remote_root: Path, build_id: str) -> Path:
    build_dir = inside(remote_root, "builds", build_id)
    fake_py = build_dir / "qmq_remote_main.py"
    if fake_py.exists():
        return fake_py
    fake = build_dir / "qmq_remote_main"
    real = build_dir / "cmake-build" / "qmq_remote_main"
    if fake.exists():
        return fake
    if real.exists():
        return real
    raise ValueError(f"build executable missing for {build_id}")


def build_metadata(remote_root: Path, build_id: str) -> dict[str, Any]:
    path = inside(remote_root, "builds", build_id, "build-result.json")
    if not path.exists():
        raise ValueError(f"build metadata missing for {build_id}")
    return read_json(path)


def validate_artifact(request: dict[str, Any], remote_root: Path, build_id: str, executable: Path) -> dict[str, Any]:
    metadata = build_metadata(remote_root, build_id)
    expected = request.get("artifact_hash")
    actual = sha256_text(canonical({
        "kernel": metadata.get("rendered_source_hash"),
        "executable": sha256_bytes(executable.read_bytes()),
        "npu_arch": request.get("npu_arch") or "dav-2201",
    }))
    if metadata.get("artifact_hash") != actual:
        raise ValueError(f"stored artifact_hash no longer matches executable for {build_id}")
    if expected is not None and expected != actual:
        raise ValueError(f"artifact_hash mismatch for {build_id}: expected {expected}, got {actual}")
    return metadata


def execute_case(request: dict[str, Any], remote_root: Path, executable: Path, case: dict[str, Any],
                 device_id: int, warmup: int, repetitions: int, work_root: Path) -> dict[str, Any]:
    case_id = require_id(case.get("case_id"), "case_id")
    shape = case.get("shape") or {}
    case_dir = work_root / case_id
    if case_dir.exists():
        shutil.rmtree(case_dir)
    case_dir.mkdir(parents=True)
    input_hash, oracle_hash = write_case_files(case_dir, case)
    if executable.suffix == ".py":
        command = [sys.executable, str(executable), str(shape["m"]), str(shape["n"]), str(shape["k"]), str(device_id), str(warmup), str(repetitions)]
    else:
        command = [str(executable), str(shape["m"]), str(shape["n"]), str(shape["k"]), str(device_id), str(warmup), str(repetitions)]
    run = run_command(command, case_dir, timeout=900)
    verify = run_command([sys.executable, str(DRIVER_DIR / "verify_case.py"), str(case_dir), "--report", str(case_dir / "verify.json")], case_dir, timeout=300)
    timings = parse_timings(run["stdout"])
    passed = verify["returncode"] == 0
    if run["returncode"] != 0:
        status = "RUN_FAILED"
        reason = "binary returned nonzero"
    elif not passed:
        status = "INCORRECT"
        reason = "verify_case failed"
    elif len(timings) != repetitions:
        status = "RUN_FAILED"
        reason = "timing sample count mismatch"
    else:
        status = "PASS"
        reason = None
    return {
        "case_id": case_id,
        "status": status,
        "samples_us": timings,
        "median_us": median(timings),
        "reason": reason,
        "run": run,
        "verify": verify,
        "input_hash": input_hash,
        "oracle_hash": oracle_hash,
    }


def action_test(request: dict[str, Any], remote_root: Path, request_dir: Path) -> dict[str, Any]:
    simulated = os.environ.get("METEOR_REMOTE_DRIVER_FAKE_BUILD") == "1"
    guarded = guard_before_execution(request_dir, simulated)
    if guarded is not None:
        return guarded
    mark_running(request_dir, "test")
    build_id = require_id(request.get("build_id"), "build_id")
    device_id = int(request.get("device_id", 0))
    repetitions = int(request.get("repetitions", 5))
    warmup = int(request.get("warmup", 3))
    executable = load_build_executable(remote_root, build_id)
    build_info = validate_artifact(request, remote_root, build_id, executable)
    simulated = bool(build_info.get("simulated"))
    supported = set(request.get("supported_case_ids") or [])
    rows = []
    work_root = inside(remote_root, "runs", require_id(request.get("request_id"), "request_id"))
    work_root.mkdir(parents=True, exist_ok=True)
    cancelled = False
    with DeviceLock(remote_root, device_id):
        for case in request.get("cases") or []:
            case_id = require_id(case.get("case_id"), "case_id")
            shape = case.get("shape") or {}
            if (request_dir / "cancel.json").exists():
                cancelled = True
                rows.append({"case_id": case_id, "status": "NOT_RUN", "samples_us": [], "reason": "cancel requested"})
                continue
            if case_id not in supported:
                rows.append({"case_id": case_id, "status": "UNSUPPORTED", "samples_us": [], "reason": "case not in supported_case_ids"})
                continue
            rows.append(execute_case(request, remote_root, executable, case, device_id, warmup, repetitions, work_root))
    result = {
        "status": "CANCELLED" if cancelled else "COMPLETED",
        "backend": "ssh",
        "simulated": simulated,
        "build_id": build_id,
        "artifact_hash": build_info.get("artifact_hash"),
        "rendered_source_hash": build_info.get("rendered_source_hash"),
        "case_suite_revision": request.get("case_suite_revision"),
        "environment_ref": request.get("environment_ref"),
        "measurement_protocol_ref": request.get("measurement_protocol_ref"),
        "rows": rows,
        "data_hash": sha256_text(canonical(rows)),
    }
    return finish(request_dir, result)


def action_profile(request: dict[str, Any], remote_root: Path, request_dir: Path) -> dict[str, Any]:
    simulated = os.environ.get("METEOR_REMOTE_DRIVER_FAKE_BUILD") == "1"
    guarded = guard_before_execution(request_dir, simulated)
    if guarded is not None:
        return guarded
    mark_running(request_dir, "profile")
    metrics = request.get("metrics") or []
    unsupported = [metric for metric in metrics if metric != "kernel_time_us"]
    if unsupported:
        result = {
            "status": "FAILED",
            "backend": "ssh",
            "simulated": simulated,
            "reason": "unsupported profile metrics requested",
            "unsupported_metrics": unsupported,
            "instrumented": False,
        }
        return finish(request_dir, result)
    build_id = require_id(request.get("build_id"), "build_id")
    device_id = int(request.get("device_id", 0))
    repetitions = int(request.get("repetitions", 5))
    warmup = int(request.get("warmup", 3))
    executable = load_build_executable(remote_root, build_id)
    build_info = validate_artifact(request, remote_root, build_id, executable)
    simulated = bool(build_info.get("simulated"))
    supported = set(request.get("supported_case_ids") or [])
    work_root = inside(remote_root, "profiles", require_id(request.get("request_id"), "request_id"))
    observations = []
    raw = []
    with DeviceLock(remote_root, device_id):
        for case in request.get("cases") or []:
            case_id = require_id(case.get("case_id"), "case_id")
            if case_id not in supported:
                raw.append({"case_id": case_id, "status": "UNSUPPORTED", "samples_us": [], "reason": "case not in supported_case_ids"})
                continue
            row = execute_case(request, remote_root, executable, case, device_id, warmup, repetitions, work_root)
            raw.append(row)
            if row["status"] == "PASS" and row["median_us"] is not None:
                observations.append({"case_id": case_id, "metric": "kernel_time_us", "value": row["median_us"], "unit": "us"})
    result = {
        "status": "COMPLETED",
        "backend": "ssh",
        "simulated": simulated,
        "build_id": build_id,
        "artifact_hash": build_info.get("artifact_hash"),
        "rendered_source_hash": build_info.get("rendered_source_hash"),
        "instrumented": True,
        "observations": observations,
        "raw_profiles": raw,
    }
    return finish(request_dir, result)


def action_poll(request: dict[str, Any], remote_root: Path) -> dict[str, Any]:
    request_id = require_id(request.get("request_id"), "request_id")
    request_dir = inside(remote_root, "requests", request_id)
    result = request_dir / "result.json"
    if result.exists():
        return {"status": "FINISHED", "result": read_json(result)}
    status_path = request_dir / "status.json"
    if not status_path.exists():
        return {"status": "NOT_FOUND"}
    status = read_json(status_path)
    pid = status.get("pid")
    running = False
    if isinstance(pid, int) and os.name == "posix":
        try:
            os.kill(pid, 0)
            running = True
        except OSError:
            running = False
    elif isinstance(pid, int):
        running = True
    return {"status": "RUNNING" if running else "UNKNOWN_REMOTE", "state": status}


def action_collect(request: dict[str, Any], remote_root: Path) -> dict[str, Any]:
    polled = action_poll(request, remote_root)
    if polled.get("status") == "FINISHED":
        return polled["result"]
    return polled


def action_cancel(request: dict[str, Any], remote_root: Path) -> dict[str, Any]:
    request_id = require_id(request.get("request_id"), "request_id")
    request_dir = inside(remote_root, "requests", request_id)
    request_dir.mkdir(parents=True, exist_ok=True)
    write_json(request_dir / "cancel.json", {"requested_at": time.time()})
    status = action_poll(request, remote_root)
    return {"status": "CANCEL_REQUESTED", "state": status, "remote_released": False}


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    if action not in {"build", "test", "profile", "poll", "collect", "cancel"}:
        raise ValueError("action must be build, test, profile, poll, collect, or cancel")
    remote_root = require_remote_root(request.get("remote_root"))
    if action in {"poll", "collect", "cancel"}:
        if action == "poll":
            return action_poll(request, remote_root)
        if action == "collect":
            return action_collect(request, remote_root)
        return action_cancel(request, remote_root)
    remote_root, request_dir, payload_hash = request_paths(request)
    request_dir.mkdir(parents=True, exist_ok=True)
    with OperationLock(request_dir) as lock:
        if not lock.acquired:
            payload_path = request_dir / "payload_hash.txt"
            if payload_path.exists():
                prior = payload_path.read_text(encoding="utf-8").strip()
                if prior != payload_hash:
                    raise ValueError("request_id already used for a different payload")
            return running_or_unknown(request_dir, os.environ.get("METEOR_REMOTE_DRIVER_FAKE_BUILD") == "1")
        remote_root, request_dir, _payload_hash = setup_request(request)
        if action == "build":
            return action_build(request, remote_root, request_dir)
        if action == "test":
            return action_test(request, remote_root, request_dir)
        return action_profile(request, remote_root, request_dir)


def main() -> int:
    try:
        request = load_stdin()
        result = dispatch(request)
        response = {"ok": True, "action": request.get("action"), "request_id": request.get("request_id"), "result": result}
        print(json.dumps(response, sort_keys=True, ensure_ascii=True))
        return 0
    except Exception as exc:
        response = {"ok": False, "error": str(exc)}
        print(json.dumps(response, sort_keys=True, ensure_ascii=True))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
