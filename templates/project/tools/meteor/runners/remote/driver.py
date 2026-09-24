#!/usr/bin/env python3
"""Meteor remote QMQ driver.

The TS SSH transport deploys this directory to
``remote_root/drivers/<bundle_hash>`` and sends one JSON request on stdin. The
driver is intentionally stdlib-only; oracle helpers are bundled beside it.
"""

from __future__ import annotations

import base64
import csv
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

from execution_queue import ExecutionQueue, FileLock, QueueCancelled


DRIVER_DIR = Path(__file__).resolve().parent
TIMING_PREFIX = "QMQ_TIMING_US "
SUPPORTED_PROFILE_METRICS = ["kernel_time_us", "device_task_time_us"]
DEVICE_TASK_TYPES = {"AI_CORE", "AICORE", "AI_VECTOR_CORE", "AI_VECTOR", "AIV", "MIX_AIC", "MIX_AICORE", "MIX_AIV"}
ACTIVE_QUEUE: ExecutionQueue | None = None


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
    write_json(request_dir / "status.json", {"state": "finished", "status": result.get("status"), "finished_at": result["finished_at"], "queue": result.get("queue")})
    return result


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
        return {"status": "RUNNING", "simulated": simulated, "state": status, "queue": status.get("queue")}
    return {"status": "UNKNOWN_REMOTE", "simulated": simulated, "state": status, "reason": "previous request did not finish and no live pid was confirmed"}


def guard_before_execution(request_dir: Path, simulated: bool) -> dict[str, Any] | None:
    existing = maybe_existing_result(request_dir)
    if existing is not None:
        return existing
    status_path = request_dir / "status.json"
    if not status_path.exists():
        return None
    status = read_json(status_path)
    if status.get("state") not in {"queued", "running"}:
        return None
    alive = pid_is_alive(status.get("pid"))
    if alive is True:
        return {"status": "RUNNING", "simulated": simulated, "state": status, "queue": status.get("queue")}
    return {"status": "UNKNOWN_REMOTE", "simulated": simulated, "state": status, "reason": "previous request stopped before completion"}


class DeviceLock:
    """Retain the old per-root device lock for compatibility with older drivers."""
    def __init__(self, remote_root: Path, device_id: int):
        self.path = inside(remote_root, f".device-{device_id}.lock")
        self.lock = None

    def __enter__(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.lock = FileLock(self.path)
        try:
            while not self.lock.acquire(blocking=False):
                if ACTIVE_QUEUE:
                    ACTIVE_QUEUE.check_cancelled()
                time.sleep(0.2)
            return self
        except BaseException:
            self.lock.close()
            raise

    def __exit__(self, exc_type, exc, tb):
        if self.lock:
            self.lock.close()


def run_command(command: list[str], cwd: Path, timeout: int = 900) -> dict[str, Any]:
    started = time.time()
    deadline = time.monotonic() + timeout
    if ACTIVE_QUEUE:
        ACTIVE_QUEUE.check_cancelled()
    options = {"start_new_session": True, "pass_fds": ACTIVE_QUEUE.pass_fds if ACTIVE_QUEUE else ()} if os.name == "posix" else {}
    proc = subprocess.Popen(command, cwd=str(cwd), text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE, **options)
    try:
        while True:
            if ACTIVE_QUEUE:
                ACTIVE_QUEUE.check_cancelled()
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise subprocess.TimeoutExpired(command, timeout)
            try:
                stdout, stderr = proc.communicate(timeout=min(0.2, remaining))
                break
            except subprocess.TimeoutExpired:
                continue
    except BaseException:
        if os.name == "posix":
            # Compiler/profiler children belong to this command's process group.
            # Terminate them before relinquishing the queue's execution slot.
            try:
                os.killpg(proc.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        else:
            proc.kill()
        proc.communicate()
        raise
    return {
        "command": command,
        "returncode": proc.returncode,
        "stdout": stdout[-20000:],
        "stderr": stderr[-20000:],
        "duration_seconds": time.time() - started,
    }


def run_optional_command(command: list[str], cwd: Path, timeout: int = 60) -> dict[str, Any]:
    executable = command[0]
    resolved = shutil.which(executable) if not Path(executable).is_absolute() else executable
    if resolved is None:
        return {
            "command": command,
            "returncode": None,
            "stdout": "",
            "stderr": "",
            "duration_seconds": 0,
            "unavailable_reason": f"{executable} not found",
        }
    return run_command(command, cwd, timeout=timeout)


def require_int(value: Any, name: str) -> int:
    if isinstance(value, bool):
        raise ValueError(f"{name} must be an integer")
    if isinstance(value, int):
        return value
    if isinstance(value, str) and value.isdecimal():
        return int(value)
    raise ValueError(f"{name} must be provided by the verified profile or hardware report")


def require_npu_arch(request: dict[str, Any]) -> str:
    value = request.get("npu_arch")
    if not isinstance(value, str) or not value.strip():
        raise ValueError("npu_arch must be provided by the verified profile or hardware report")
    if not all(ch.isalnum() or ch in "._-" for ch in value):
        raise ValueError("invalid npu_arch")
    return value


def fake_enabled() -> bool:
    return os.environ.get("METEOR_REMOTE_DRIVER_FAKE_BUILD") == "1"


def install_harness(build_dir: Path) -> None:
    for name in ("CMakeLists.txt", "main.asc", "hardware_probe.cpp", "hardware_add.asc", "hardware_add_host.asc", "gen_case.py", "verify_case.py"):
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
    simulated = fake_enabled()
    build_id = require_id(request.get("build_id"), "build_id")
    npu_arch = request.get("npu_arch") if simulated else require_npu_arch(request)
    if not isinstance(npu_arch, str) or not npu_arch:
        npu_arch = "fake-npu"
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
    return result


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
    npu_arch = metadata.get("npu_arch") or request.get("npu_arch")
    actual = sha256_text(canonical({
        "kernel": metadata.get("rendered_source_hash"),
        "executable": sha256_bytes(executable.read_bytes()),
        "npu_arch": npu_arch,
    }))
    if metadata.get("artifact_hash") != actual:
        raise ValueError(f"stored artifact_hash no longer matches executable for {build_id}")
    if expected is not None and expected != actual:
        raise ValueError(f"artifact_hash mismatch for {build_id}: expected {expected}, got {actual}")
    return metadata


def task_type_matches(value: Any) -> bool:
    text = str(value or "").strip().upper().replace(" ", "_")
    return text in DEVICE_TASK_TYPES


def read_csv_dicts(path: Path) -> list[dict[str, str]]:
    with path.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        return list(csv.DictReader(handle))


def find_op_summary(profile_root: Path) -> Path | None:
    candidates = sorted(profile_root.rglob("*op_summary*.csv")) + sorted(profile_root.rglob("*op_summary*.txt"))
    return candidates[0] if candidates else None


def find_op_summaries(profile_root: Path) -> list[Path]:
    return sorted(profile_root.rglob("*op_summary*.csv")) + sorted(profile_root.rglob("*op_summary*.txt"))


def parse_op_summary(path: Path, kernel_names: list[str], device_id: int) -> dict[str, Any]:
    rows = read_csv_dicts(path) if path.suffix.lower() == ".csv" else []
    matched: list[dict[str, Any]] = []
    lowered_names = [name.lower() for name in kernel_names if name]
    for row in rows:
        values = {key.lower(): value for key, value in row.items()}
        task_type = values.get("task type") or values.get("task_type") or values.get("tasktype") or values.get("type")
        op_name = values.get("op name") or values.get("op_name") or values.get("opname") or values.get("kernel name") or values.get("kernel_name") or values.get("name") or ""
        row_device = values.get("device_id") or values.get("device id") or values.get("device")
        if row_device is None or not str(row_device).strip().isdecimal():
            continue
        if int(str(row_device).strip()) != device_id:
            continue
        if not task_type_matches(task_type):
            continue
        if lowered_names and not any(name in op_name.lower() for name in lowered_names):
            continue
        matched_name = next((name for name in kernel_names if name and name.lower() in op_name.lower()), op_name)
        matched.append({
            "device_id": int(str(row_device).strip()),
            "kernel_name": matched_name,
            "task_id": values.get("task id") or values.get("task_id"),
            "stream_id": values.get("stream id") or values.get("stream_id"),
            "task_type": task_type,
            "op_name": op_name,
            "op_type": values.get("op type") or values.get("op_type"),
            "task_start_time_us": values.get("task start time(us)") or values.get("task_start_time(us)") or values.get("task_start_time_us"),
            "task_duration_us": values.get("task duration(us)") or values.get("task_duration(us)") or values.get("task_duration_us"),
            "block_dim": values.get("block dim") or values.get("block_dim"),
        })
    return {
        "op_summary_ref": str(path),
        "matched_task_count": len(matched),
        "task_types": sorted({str(item.get("task_type")) for item in matched if item.get("task_type")}),
        "matched_tasks": matched[:20],
    }


def msprof_witness_command(executable: Path, args: list[str], kernel_names: list[str], device_id: int,
                           profile_root: Path, cwd: Path) -> dict[str, Any]:
    if not kernel_names:
        return {"status": "MISSING", "tool": "msprof", "reason": "candidate kernel_name is required for device execution witness", "allowed_to_pass": False}
    msprof = shutil.which("msprof")
    if msprof is None:
        return {"status": "UNAVAILABLE", "tool": "msprof", "reason": "msprof not found", "allowed_to_pass": False}
    if profile_root.exists():
        shutil.rmtree(profile_root)
    profile_root.mkdir(parents=True)
    command = [
        msprof,
        "--task-time=l1",
        "--ai-core=on",
        "--aic-mode=task-based",
        "--aic-metrics=PipeUtilization",
        "--ascendcl=on",
        "--runtime-api=on",
        f"--output={profile_root}",
        str(executable), *[str(arg) for arg in args],
    ]
    prof = run_command(command, cwd, timeout=900)
    if prof["returncode"] != 0:
        return {"status": "MISSING", "tool": "msprof", "reason": "msprof returned nonzero", "log": prof, "allowed_to_pass": False}
    summaries = find_op_summaries(profile_root)
    if not summaries:
        return {"status": "MISSING", "tool": "msprof", "reason": "op_summary not found", "log": prof, "allowed_to_pass": False}
    parsed_items = [parse_op_summary(summary, kernel_names, device_id) for summary in summaries]
    matched_tasks = [task for item in parsed_items for task in item["matched_tasks"]]
    matched_task_count = sum(item["matched_task_count"] for item in parsed_items)
    combined = {
        "source": "profile_dir",
        "profile_dir": str(profile_root),
        "op_summary_refs": [str(path) for path in summaries],
        "matched_task_count": matched_task_count,
        "task_types": sorted({task_type for item in parsed_items for task_type in item["task_types"]}),
        "matched_tasks": matched_tasks[:20],
        "matched_ops": matched_tasks[:20],
    }
    if matched_task_count <= 0:
        return {"status": "MISSING", "tool": "msprof", "reason": "no AI_CORE/AI_VECTOR/MIX_AIC task matched candidate kernel and logical device", **combined, "log": prof, "allowed_to_pass": False}
    return {"status": "CONFIRMED", "tool": "msprof", "kernel_names": kernel_names, "device_id": device_id, **combined, "log": prof, "allowed_to_pass": True}


def msprof_witness(request: dict[str, Any], executable: Path, case: dict[str, Any], case_dir: Path,
                  device_id: int, warmup: int, repetitions: int) -> dict[str, Any]:
    kernel_names = [str(value) for value in request.get("kernel_names") or [] if isinstance(value, str)]
    if isinstance(request.get("kernel_name"), str):
        kernel_names.append(request["kernel_name"])
    shape = case.get("shape") or {}
    args = [str(shape["m"]), str(shape["n"]), str(shape["k"]), str(device_id), str(warmup), str(repetitions)]
    return msprof_witness_command(executable, args, kernel_names, device_id, case_dir / "msprof", case_dir)


def execute_case(request: dict[str, Any], remote_root: Path, executable: Path, case: dict[str, Any],
                 device_id: int, warmup: int, repetitions: int, work_root: Path, simulated: bool) -> dict[str, Any]:
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
    if simulated:
        device_execution = {
            "status": "SIMULATED",
            "tool": "fake-harness",
            "reason": "METEOR_REMOTE_DRIVER_FAKE_BUILD is enabled; this is not hardware evidence",
            "allowed_to_pass": True,
            "matched_tasks": [],
        }
    elif status == "PASS":
        device_execution = msprof_witness(request, executable, case, case_dir, device_id, warmup, repetitions)
        if device_execution.get("status") != "CONFIRMED":
            status = "RUN_FAILED"
            reason = "device execution witness missing"
    else:
        device_execution = {"status": "NOT_RUN", "tool": "msprof", "reason": "not collected because case did not pass functional execution", "allowed_to_pass": False}
    return {
        "case_id": case_id,
        "status": status,
        "samples_us": timings,
        "median_us": median(timings),
        "reason": reason,
        "device_execution": device_execution,
        "run": run,
        "verify": verify,
        "input_hash": input_hash,
        "oracle_hash": oracle_hash,
    }


def action_test(request: dict[str, Any], remote_root: Path, request_dir: Path) -> dict[str, Any]:
    simulated = fake_enabled()
    build_id = require_id(request.get("build_id"), "build_id")
    device_id = require_int(request.get("device_id"), "device_id")
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
            rows.append(execute_case(request, remote_root, executable, case, device_id, warmup, repetitions, work_root, simulated))
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
    return result


def action_profile(request: dict[str, Any], remote_root: Path, request_dir: Path) -> dict[str, Any]:
    simulated = fake_enabled()
    metrics = request.get("metrics") or ["kernel_time_us"]
    unsupported = [metric for metric in metrics if metric not in SUPPORTED_PROFILE_METRICS]
    if unsupported:
        result = {
            "status": "FAILED",
            "backend": "ssh",
            "simulated": simulated,
            "reason": "unsupported profile metrics requested",
            "unsupported_metrics": unsupported,
            "allowed_metrics": SUPPORTED_PROFILE_METRICS,
            "instrumented": False,
        }
        return result
    build_id = require_id(request.get("build_id"), "build_id")
    device_id = require_int(request.get("device_id"), "device_id")
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
            row = execute_case(request, remote_root, executable, case, device_id, warmup, repetitions, work_root, simulated)
            raw.append(row)
            if row["status"] == "PASS" and "kernel_time_us" in metrics and row["median_us"] is not None:
                observations.append({"case_id": case_id, "metric": "kernel_time_us", "value": row["median_us"], "unit": "us", "measurement_kind": "acl_event_interval"})
            if row["status"] == "PASS" and "device_task_time_us" in metrics:
                durations = []
                for task in row.get("device_execution", {}).get("matched_tasks", []):
                    raw_duration = task.get("task_duration_us")
                    try:
                        durations.append(float(raw_duration))
                    except (TypeError, ValueError):
                        pass
                if durations:
                    observations.append({"case_id": case_id, "metric": "device_task_time_us", "value": median(durations), "unit": "us", "measurement_kind": "msprof_task_duration"})
    result = {
        "status": "COMPLETED",
        "backend": "ssh",
        "simulated": simulated,
        "build_id": build_id,
        "artifact_hash": build_info.get("artifact_hash"),
        "rendered_source_hash": build_info.get("rendered_source_hash"),
        "instrumented": "device_task_time_us" in metrics,
        "measurement_kind": "acl_event_interval" if set(metrics) == {"kernel_time_us"} else "mixed",
        "supported_metrics": SUPPORTED_PROFILE_METRICS,
        "observations": observations,
        "raw_profiles": raw,
    }
    return result


def parse_npu_smi_devices(stdout: str) -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        if "|" not in line:
            continue
        parts = [part.strip() for part in line.strip("|").split("|")]
        numbers = [part for part in parts if part.isdecimal()]
        if len(numbers) >= 1 and any("910" in part or "Ascend" in part for part in parts):
            devices.append({
                "device_id": int(numbers[0]),
                "name": next((part for part in parts if "Ascend" in part or "910" in part), None),
                "soc_version": None,
                "health": None,
                "memory": {"total_bytes": None, "free_bytes": None, "reason": "not parsed from npu-smi table"},
                "raw": line,
            })
    return devices


def parse_npu_smi_mapping(stdout: str) -> list[dict[str, Any]]:
    devices: list[dict[str, Any]] = []
    for line in stdout.splitlines():
        parts = line.split()
        if len(parts) >= 5 and parts[0].isdecimal() and parts[1].isdecimal() and parts[2].isdecimal():
            devices.append({
                "device_id": int(parts[2]),
                "card_id": int(parts[0]),
                "chip_id": int(parts[1]),
                "physical_id": int(parts[3]) if parts[3].isdecimal() else None,
                "name": parts[4],
                "soc_version": parts[4],
                "npu_arch": None,
                "npu_arch_reason": "Platform GetCurNpuArch unavailable in this probe build",
                "memory": {"total_bytes": None, "free_bytes": None, "reason": "not parsed from npu-smi mapping"},
                "health": {"status": None, "reason": "health query requires per-card npu-smi raw log"},
                "raw": line,
            })
    return devices



def merge_inventory_fields(devices: list[dict[str, Any]], inventory_devices: list[dict[str, Any]]) -> list[dict[str, Any]]:
    inventory_by_id = {device.get("device_id"): device for device in inventory_devices}
    merged = []
    for device in devices:
        item = dict(device)
        inventory = inventory_by_id.get(item.get("device_id"))
        if inventory:
            for key in ("card_id", "chip_id", "physical_id", "raw"):
                if key not in item or item.get(key) is None:
                    item[key] = inventory.get(key)
            if inventory.get("name") and item.get("name") != inventory.get("name"):
                item["inventory_name"] = inventory.get("name")
        merged.append(item)
    return merged


def build_and_witness_hardware_add(remote_root: Path, request: dict[str, Any], probe_root: Path,
                                   build_dir: Path, selected: dict[str, Any] | None) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    logs: list[dict[str, Any]] = []
    if selected is None:
        return {
            "compile": False,
            "launch": False,
            "correctness": False,
            "reason": "no selected device from runtime discovery",
            "device_execution": {"status": "NOT_RUN", "source": "msprof", "matched_tasks": [], "reason": "not collected: no selected device"},
        }, logs
    npu_arch = selected.get("npu_arch")
    if not isinstance(npu_arch, str) or not npu_arch:
        return {
            "compile": False,
            "launch": False,
            "correctness": False,
            "reason": "npu_arch unavailable; refusing to compile device kernel with guessed architecture",
            "device_execution": {"status": "NOT_RUN", "source": "msprof", "matched_tasks": [], "reason": "not collected: npu_arch unavailable"},
        }, logs
    device_id = int(selected.get("device_id"))
    logs.append(run_optional_command(["cmake", "-S", str(probe_root), "-B", str(build_dir), f"-DNPU_ARCH={npu_arch}"], probe_root, timeout=300))
    if logs[-1].get("returncode") == 0:
        logs.append(run_optional_command(["cmake", "--build", str(build_dir), "--target", "meteor_hardware_add", "-j2"], probe_root, timeout=300))
    executable = build_dir / "meteor_hardware_add"
    compile_ok = bool(len(logs) >= 2 and logs[0].get("returncode") == 0 and logs[1].get("returncode") == 0 and executable.exists())
    launch = {"returncode": None, "stdout": "", "stderr": "", "command": [str(executable)], "unavailable_reason": "compile failed"}
    witness: dict[str, Any] = {"status": "NOT_RUN", "source": "msprof", "matched_tasks": [], "reason": "not collected because compilation failed"}
    if compile_ok:
        request_id = require_id(request.get("request_id"), "request_id")
        run_root = inside(remote_root, "hardware-probe-runs", request_id)
        run_root.mkdir(parents=True, exist_ok=True)
        args = ["1", "1", "1", str(device_id), "2", "3"]
        with DeviceLock(remote_root, device_id):
            launch = run_command([str(executable), *args], run_root, timeout=300)
            logs.append(launch)
            if launch.get("returncode") == 0 and "METEOR_HARDWARE_ADD_PASS" in launch.get("stdout", ""):
                witness = msprof_witness_command(
                    executable,
                    args,
                    ["meteor_hardware_add_kernel"],
                    device_id,
                    run_root / "msprof",
                    run_root,
                )
            else:
                witness = {"status": "NOT_RUN", "source": "msprof", "matched_tasks": [], "reason": "not collected because hardware add launch/correctness failed", "log": launch}
    launch_ok = bool(launch.get("returncode") == 0)
    correctness_ok = bool(launch_ok and "METEOR_HARDWARE_ADD_PASS" in launch.get("stdout", ""))
    validation = {
        "compile": compile_ok,
        "launch": launch_ok,
        "correctness": correctness_ok,
        "reason": ("minimal device-kernel compilation failed" if not compile_ok else
                   "minimal device-kernel launch/correctness failed" if not correctness_ok else
                   "minimal device-kernel msprof witness did not confirm" if witness.get("status") != "CONFIRMED" else None),
        "device_execution": witness,
    }
    return validation, logs

def run_hardware_probe(remote_root: Path, request: dict[str, Any]) -> dict[str, Any]:
    probe_root = inside(remote_root, "hardware-probes", require_id(request.get("request_id"), "request_id"))
    probe_root.mkdir(parents=True, exist_ok=True)
    install_harness(probe_root)
    build_dir = probe_root / "cmake-build"
    build_dir.mkdir(exist_ok=True)
    logs = [
        run_optional_command(["cmake", "-S", str(probe_root), "-B", str(build_dir)], probe_root, timeout=300),
    ]
    if logs[-1]["returncode"] == 0:
        logs.append(run_optional_command(["cmake", "--build", str(build_dir), "--target", "meteor_hardware_probe", "-j2"], probe_root, timeout=300))
    executable = build_dir / "meteor_hardware_probe"
    launched = False
    parsed: dict[str, Any] | None = None
    if logs and logs[-1]["returncode"] == 0 and executable.exists():
        run = run_command([str(executable)], probe_root, timeout=300)
        logs.append(run)
        launched = run["returncode"] == 0
        try:
            parsed = json.loads(run["stdout"])
        except Exception:
            parsed = None
    devices = parsed.get("devices") if isinstance(parsed, dict) and isinstance(parsed.get("devices"), list) else []
    requested_device = request.get("device_id")
    selected = None
    if isinstance(requested_device, int) or (isinstance(requested_device, str) and requested_device.isdecimal()):
        device_id = int(requested_device)
        selected = next((device for device in devices if device.get("device_id") == device_id), None)
    elif devices:
        selected = next((device for device in devices if device.get("soc_version") and device.get("npu_arch")), None)
    runtime_discovery = {
        "compile": bool(len(logs) >= 2 and logs[0].get("returncode") == 0 and logs[1].get("returncode") == 0),
        "launch": launched,
        "correctness": bool(parsed and parsed.get("status") == "READY" and devices),
    }
    validation, add_logs = build_and_witness_hardware_add(remote_root, request, probe_root, build_dir, selected)
    logs.extend(add_logs)
    validation["runtime_discovery"] = runtime_discovery
    return {"logs": logs, "parsed": parsed, "devices": devices, "selected_device": selected, "validation": validation}


def action_hardware(request: dict[str, Any], remote_root: Path, request_dir: Path) -> dict[str, Any]:
    simulated = fake_enabled()
    if simulated:
        return {
            "status": "COMPLETED",
            "readiness": "BLOCKED",
            "backend": "ssh",
            "simulated": True,
            "supported_metrics": SUPPORTED_PROFILE_METRICS,
            "selected_device": None,
            "validation": {
                "compile": False,
                "launch": False,
                "correctness": False,
                "device_execution": {"status": "SIMULATED", "source": "fake-harness", "matched_tasks": [], "reason": "fake harness cannot validate hardware"},
            },
            "devices": [],
            "device_count": 0,
            "cann": {"compiler": None, "runtime": None, "reason": "fake harness"},
            "tools": {"msprof": None, "reason": "fake harness"},
            "logs": [{"command": ["fake-hardware"], "returncode": 0, "stdout": "", "stderr": ""}],
        }
    probe = run_hardware_probe(remote_root, request)
    logs = [
        run_optional_command(["npu-smi", "info"], remote_root),
        run_optional_command(["npu-smi", "info", "-m"], remote_root),
    ]
    device_log = next((item for item in logs if item["command"][:2] == ["npu-smi", "info"] and item.get("returncode") == 0), None)
    mapping_log = next((item for item in logs if item["command"][:3] == ["npu-smi", "info", "-m"] and item.get("returncode") == 0), None)
    inventory_devices = parse_npu_smi_mapping(mapping_log.get("stdout", "")) if mapping_log else []
    if not inventory_devices and device_log:
        inventory_devices = parse_npu_smi_devices(device_log.get("stdout", ""))
    devices = merge_inventory_fields(probe["devices"], inventory_devices) if probe["devices"] else inventory_devices
    selected = probe["selected_device"]
    if selected is not None:
        selected = merge_inventory_fields([selected], inventory_devices)[0]
    if selected is None and inventory_devices:
        requested_device = request.get("device_id")
        if isinstance(requested_device, int) or (isinstance(requested_device, str) and requested_device.isdecimal()):
            selected = next((device for device in inventory_devices if device.get("device_id") == int(requested_device)), None)
    if selected and selected.get("card_id") is not None:
        card_id = str(selected.get("card_id"))
        chip_id = str(selected.get("chip_id")) if selected.get("chip_id") is not None else None
        logs.append(run_optional_command(["npu-smi", "info", "-t", "memory", "-i", card_id] + (["-c", chip_id] if chip_id is not None else []), remote_root))
        logs.append(run_optional_command(["npu-smi", "info", "-t", "health", "-i", card_id] + (["-c", chip_id] if chip_id is not None else []), remote_root))
    else:
        logs.append(run_optional_command(["npu-smi", "info", "-t", "memory"], remote_root))
        logs.append(run_optional_command(["npu-smi", "info", "-t", "health"], remote_root))
    if selected is not None:
        health_log = next((item for item in logs if item.get("command", [])[1:4] == ["info", "-t", "health"] and item.get("returncode") == 0), None)
        if health_log:
            health_fields = dict(line.strip().split(":", 1) for line in health_log.get("stdout", "").splitlines() if ":" in line)
            health_fields = {key.strip(): value.strip() for key, value in health_fields.items()}
            selected["health"] = {"status": health_fields.get("Health Status"), "error_code": health_fields.get("Error Code"),
                                  "error_information": health_fields.get("Error Information"),
                                  "reason": None if health_fields.get("Health Status") else "Health Status field unavailable"}
    logs.extend([
        run_optional_command(["msprof", "--help"], remote_root),
        run_optional_command(["bisheng", "--version"], remote_root),
        run_optional_command(["ccec", "--version"], remote_root),
    ])
    selected_ready = bool(
        selected
        and selected.get("npu_arch")
        and all(probe["validation"].get(key) is True for key in ("compile", "launch", "correctness"))
        and probe["validation"]["device_execution"].get("status") == "CONFIRMED"
        and probe["validation"]["device_execution"].get("matched_tasks")
    )
    result = {
        "status": "COMPLETED" if (device_log or probe["validation"]["launch"]) else "FAILED",
        "readiness": "READY" if selected_ready else "BLOCKED",
        "backend": "ssh",
        "simulated": False,
        "supported_metrics": SUPPORTED_PROFILE_METRICS,
        "selected_device": selected,
        "validation": probe["validation"],
        "device_count": len(devices) if devices else None,
        "devices": devices,
        "cann": {
            "compiler": next((item.get("stdout") or item.get("stderr") for item in logs if item["command"][0] in {"bisheng", "ccec"} and item.get("returncode") == 0), None),
            "runtime": None,
            "reason": None if device_log else "npu-smi info unavailable",
        },
        "tools": {
            "msprof": next((item.get("stdout") or item.get("stderr") for item in logs if item["command"][0] == "msprof" and (item.get("returncode") == 0 or "Usage:" in (item.get("stdout") or ""))), None),
            "reason": None if any(item["command"][0] == "msprof" and (item.get("returncode") == 0 or "Usage:" in (item.get("stdout") or "")) for item in logs) else "msprof unavailable",
        },
        "probe": probe.get("parsed"),
        "logs": probe["logs"] + logs,
    }
    return result


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
    return {"status": "RUNNING" if running else "UNKNOWN_REMOTE", "state": status, "queue": status.get("queue"), "remote_release_confirmed": False}


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
    if status.get("status") == "FINISHED":
        return {**status, "remote_released": status["result"].get("remote_release_confirmed", False)}
    return {"status": "CANCEL_REQUESTED", "state": status, "remote_released": False}


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    global ACTIVE_QUEUE
    action = request.get("action")
    if action not in {"build", "test", "profile", "hardware", "poll", "collect", "cancel"}:
        raise ValueError("action must be build, test, profile, hardware, poll, collect, or cancel")
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
        guarded = guard_before_execution(request_dir, fake_enabled())
        if guarded is not None:
            return guarded
        queue_root = require_remote_root(request["queue_root"]) if request.get("queue_root") else None
        queue = ExecutionQueue(request_dir, action, queue_root)
        # dispatch owns the input object. The durable payload is already checked
        # and stored. Drop large base64 case arrays while waiting; only the head
        # reloads them. Keep the response header used by main().
        request_id = request["request_id"]
        request.clear()
        request.update({"action": action, "request_id": request_id})
        try:
            with queue:
                ACTIVE_QUEUE = queue
                handler = {"build": action_build, "test": action_test, "profile": action_profile, "hardware": action_hardware}[action]
                stored = read_json(request_dir / "payload.json")
                if sha256_text(canonical(stored)) != payload_hash:
                    raise ValueError("Durable request payload changed while queued")
                result = handler(stored, remote_root, request_dir)
        except QueueCancelled as exc:
            result = {"status": "CANCELLED", "backend": "ssh", "simulated": fake_enabled(), "reason": str(exc)}
        except Exception as exc:
            if queue.released():
                finish(request_dir, {"status": "FAILED", "backend": "ssh", "simulated": fake_enabled(),
                                     "error": str(exc), "queue": queue.queue, "remote_release_confirmed": True})
            raise
        finally:
            ACTIVE_QUEUE = None
        released = queue.released()
        if not released:
            return {**result, "status": "UNKNOWN_REMOTE", "queue": queue.queue, "remote_release_confirmed": False,
                    "reason": "A command still holds this execution ticket; poll the original request"}
        return finish(request_dir, {**result, "queue": queue.queue, "remote_release_confirmed": released})


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
