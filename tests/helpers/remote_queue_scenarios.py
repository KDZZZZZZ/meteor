#!/usr/bin/env python3
"""Behavioral scenarios for the Meteor remote ExecutionQueue and driver.dispatch.

Run directly on Linux/Windows:
  python tests/helpers/remote_queue_scenarios.py --driver-dir templates/project/tools/meteor/runners/remote

The script also re-executes itself as worker subprocesses. It intentionally uses
file markers for synchronization instead of timing thresholds.
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
from pathlib import Path


class ScenarioError(AssertionError):
    pass


def write_json(path: Path, value: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")


def read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def touch(path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("", encoding="utf-8")


def wait_for(path: Path, proc: subprocess.Popen | None = None, timeout: float = 10.0) -> None:
    deadline = time.monotonic() + timeout
    while not path.exists():
        if proc is not None and proc.poll() is not None:
            stderr = proc.stderr.read() if proc.stderr else ""
            raise ScenarioError(f"process exited before {path}: code={proc.returncode}, stderr={stderr}")
        if time.monotonic() > deadline:
            raise ScenarioError(f"timed out waiting for {path}")
        time.sleep(0.01)


def wait_status(request_dir: Path, state: str, proc: subprocess.Popen | None = None, timeout: float = 10.0) -> dict:
    deadline = time.monotonic() + timeout
    status = request_dir / "status.json"
    last: object = None
    while time.monotonic() <= deadline:
        if proc is not None and proc.poll() is not None and not status.exists():
            raise ScenarioError(f"process exited before status.json: code={proc.returncode}")
        if status.exists():
            try:
                last = read_json(status)
                if last.get("state") == state:
                    return last
            except Exception as exc:  # tolerate partially written files only during polling
                last = repr(exc)
        time.sleep(0.01)
    raise ScenarioError(f"timed out waiting for {request_dir} state {state}; last={last}")


def wait_exit(proc: subprocess.Popen, expected: int = 0, timeout: float = 10.0) -> tuple[str, str]:
    try:
        stdout, stderr = proc.communicate(timeout=timeout)
    except subprocess.TimeoutExpired:
        proc.kill()
        stdout, stderr = proc.communicate(timeout=5)
        raise ScenarioError(f"process timed out; stdout={stdout!r}; stderr={stderr!r}")
    if proc.returncode != expected:
        raise ScenarioError(f"process exited {proc.returncode}, expected {expected}; stdout={stdout!r}; stderr={stderr!r}")
    return stdout, stderr


def load_driver(driver_dir: Path):
    sys.path.insert(0, str(driver_dir))
    spec = importlib.util.spec_from_file_location("meteor_remote_driver_under_test", driver_dir / "driver.py")
    if spec is None or spec.loader is None:
        raise RuntimeError("cannot load driver.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def spawn_queue_worker(root: Path, driver_dir: Path, request_dir: Path, queue_root: Path, name: str,
                       release: Path | None = None, active: Path | None = None,
                       mode: str = "acquire") -> subprocess.Popen:
    request_dir.mkdir(parents=True, exist_ok=True)
    args = [
        sys.executable, "-u", __file__, "--worker", mode,
        "--driver-dir", str(driver_dir),
        "--request-dir", str(request_dir),
        "--queue-root", str(queue_root),
        "--name", name,
        "--events", str(root / "events.jsonl"),
    ]
    if release is not None:
        args += ["--release", str(release)]
    if active is not None:
        args += ["--active", str(active)]
    return subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)


def spawn_driver_worker(root: Path, driver_dir: Path, remote_root: Path, queue_root: Path, action: str,
                        request_id: str, release: Path | None = None, active: Path | None = None,
                        mode: str = "driver-hold") -> subprocess.Popen:
    args = [
        sys.executable, "-u", __file__, "--worker", mode,
        "--driver-dir", str(driver_dir),
        "--remote-root", str(remote_root),
        "--queue-root", str(queue_root),
        "--action", action,
        "--request-id", request_id,
        "--name", request_id,
        "--events", str(root / "driver-events.jsonl"),
    ]
    if release is not None:
        args += ["--release", str(release)]
    if active is not None:
        args += ["--active", str(active)]
    return subprocess.Popen(args, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True,
                            env={**os.environ, "METEOR_REMOTE_DRIVER_ALLOW_NON_POSIX_ROOT": "1"})


def execution_queue_worker(args: argparse.Namespace) -> int:
    sys.path.insert(0, str(args.driver_dir))
    from execution_queue import ExecutionQueue, QueueCancelled  # type: ignore

    request_dir = Path(args.request_dir)
    queue_root = Path(args.queue_root)
    name = args.name
    release = Path(args.release) if args.release else None
    events = Path(args.events)
    active = Path(args.active) if args.active else None

    try:
        with ExecutionQueue(request_dir, "test", queue_root=queue_root) as queue:
            if active is not None:
                if active.exists():
                    write_json(request_dir / "overlap.json", {"name": name, "active": active.read_text(encoding="utf-8")})
                    return 20
                active.write_text(name, encoding="utf-8")
            touch(request_dir / "entered")
            with events.open("a", encoding="utf-8") as handle:
                handle.write(json.dumps({"event": "entered", "name": name, "request_dir": str(request_dir)}) + "\n")
            if args.worker in {"parent-passfds", "parent-passfds-os-exit"}:
                if os.name == "nt":
                    return 77
                child_release = request_dir / "child-release"
                child_ready = request_dir / "child-ready"
                child_code = (
                    "import pathlib,sys,time\n"
                    "ready=pathlib.Path(sys.argv[1]); release=pathlib.Path(sys.argv[2])\n"
                    "ready.write_text('')\n"
                    "deadline=time.monotonic()+30\n"
                    "while not release.exists():\n"
                    "    assert time.monotonic()<deadline, 'child release timeout'\n"
                    "    time.sleep(0.01)\n"
                )
                pass_fds = tuple(getattr(queue, "pass_fds", ()))
                child = subprocess.Popen(
                    [sys.executable, "-c", child_code, str(child_ready), str(child_release)],
                    pass_fds=pass_fds,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                )
                deadline = time.monotonic() + 10
                while not child_ready.exists():
                    if child.poll() is not None:
                        return 21
                    if time.monotonic() > deadline:
                        return 22
                    time.sleep(0.01)
                if args.worker == "parent-passfds-os-exit":
                    os._exit(0)
                return 0
            if release is not None:
                while not release.exists():
                    queue.check_cancelled()
                    time.sleep(0.01)
            if active is not None and active.exists() and active.read_text(encoding="utf-8") == name:
                active.unlink()
            return 0
    except QueueCancelled:
        touch(request_dir / "cancelled")
        return 2


def patch_driver_handlers(driver, root: Path, release: Path | None, active: Path | None, events: Path, mode: str):
    def controlled(request, remote_root, request_dir):
        action = request["action"]
        request_id = request["request_id"]
        if active is not None:
            if active.exists():
                write_json(request_dir / "overlap.json", {"request_id": request_id, "active": active.read_text(encoding="utf-8")})
                raise RuntimeError("overlap detected")
            active.write_text(request_id, encoding="utf-8")
        touch(request_dir / "handler-entered")
        with events.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({"event": "handler-entered", "action": action, "request_id": request_id}) + "\n")
        counter = root / f"{request_id}.count"
        counter.write_text(str(int(counter.read_text(encoding="utf-8")) + 1 if counter.exists() else 1), encoding="utf-8")
        try:
            if mode == "driver-run-command":
                child_code = (
                    "import pathlib,sys,time\n"
                    "ready=pathlib.Path(sys.argv[1]); release=pathlib.Path(sys.argv[2])\n"
                    "ready.write_text('')\n"
                    "while not release.exists(): time.sleep(0.05)\n"
                )
                driver.run_command([sys.executable, "-c", child_code, str(request_dir / "command-started"), str(release)], remote_root, timeout=30)
            elif release is not None:
                while not release.exists():
                    if driver.ACTIVE_QUEUE:
                        driver.ACTIVE_QUEUE.check_cancelled()
                    time.sleep(0.01)
        finally:
            if active is not None and active.exists() and active.read_text(encoding="utf-8") == request_id:
                active.unlink()
        return {"status": "COMPLETED", "backend": "ssh", "simulated": False, "action_seen": action, "request_id_seen": request_id}

    driver.action_build = controlled
    driver.action_test = controlled
    driver.action_profile = controlled
    driver.action_hardware = controlled


def driver_worker(args: argparse.Namespace) -> int:
    driver = load_driver(Path(args.driver_dir))
    root = Path(args.events).parent
    release = Path(args.release) if args.release else None
    active = Path(args.active) if args.active else None
    patch_driver_handlers(driver, root, release, active, Path(args.events), args.worker)
    request = {
        "action": args.action,
        "request_id": args.request_id,
        "remote_root": str(Path(args.remote_root)),
        "queue_root": str(Path(args.queue_root)),
    }
    result = driver.dispatch(request)
    print(json.dumps(result, sort_keys=True))
    return 0


def dispatch(driver, remote_root: Path, action: str, request_id: str, queue_root: Path, **extra):
    return driver.dispatch({"action": action, "request_id": request_id, "remote_root": str(remote_root), "queue_root": str(queue_root), **extra})


def scenario_fifo_no_overlap(root: Path, driver_dir: Path) -> None:
    queue = root / "queue"
    active = root / "active.txt"
    first_release = root / "first.release"
    second_release = root / "second.release"
    first = spawn_queue_worker(root, driver_dir, root / "req-first", queue, "first", first_release, active)
    wait_for(root / "req-first" / "entered", first)
    second = spawn_queue_worker(root, driver_dir, root / "req-second", queue, "second", second_release, active)
    status = wait_status(root / "req-second", "queued", second)
    qinfo = status.get("queue") or {}
    if qinfo.get("active_request_id") is None:
        raise ScenarioError(f"queued status lacks active_request_id: {status}")
    if qinfo.get("position") not in (1, "1"):
        raise ScenarioError(f"second should be first queued waiter: {status}")
    if (root / "req-second" / "entered").exists():
        raise ScenarioError("second entered while first still held the queue")
    touch(first_release)
    wait_exit(first)
    wait_for(root / "req-second" / "entered", second)
    touch(second_release)
    wait_exit(second)
    events = [json.loads(line)["name"] for line in (root / "events.jsonl").read_text(encoding="utf-8").splitlines()]
    if events[:2] != ["first", "second"]:
        raise ScenarioError(f"FIFO order violated: {events}")


def scenario_cancel_queued(root: Path, driver_dir: Path) -> None:
    queue = root / "queue-cancel"
    first_release = root / "cancel-first.release"
    third_release = root / "cancel-third.release"
    first = spawn_queue_worker(root, driver_dir, root / "cancel-first", queue, "cancel-first", first_release)
    wait_for(root / "cancel-first" / "entered", first)
    second = spawn_queue_worker(root, driver_dir, root / "cancel-second", queue, "cancel-second", root / "never.release")
    wait_status(root / "cancel-second", "queued", second)
    touch(root / "cancel-second" / "cancel.json")
    wait_for(root / "cancel-second" / "cancelled", second)
    wait_exit(second, expected=2)
    third = spawn_queue_worker(root, driver_dir, root / "cancel-third", queue, "cancel-third", third_release)
    wait_status(root / "cancel-third", "queued", third)
    touch(first_release)
    wait_exit(first)
    wait_for(root / "cancel-third" / "entered", third)
    touch(third_release)
    wait_exit(third)
    if (root / "cancel-second" / "entered").exists():
        raise ScenarioError("cancelled queued worker executed")


def scenario_crash_cleanup(root: Path, driver_dir: Path) -> None:
    queue = root / "queue-crash"
    holder_release = root / "crash-holder.release"
    holder = spawn_queue_worker(root, driver_dir, root / "crash-holder", queue, "crash-holder", holder_release)
    wait_for(root / "crash-holder" / "entered", holder)
    queued = spawn_queue_worker(root, driver_dir, root / "crash-queued", queue, "crash-queued", root / "never.release")
    wait_status(root / "crash-queued", "queued", queued)
    queued.kill()
    queued.wait(timeout=10)
    third_release = root / "crash-third.release"
    third = spawn_queue_worker(root, driver_dir, root / "crash-third", queue, "crash-third", third_release)
    wait_status(root / "crash-third", "queued", third)
    touch(holder_release)
    wait_exit(holder)
    wait_for(root / "crash-third" / "entered", third)
    touch(third_release)
    wait_exit(third)

    running = spawn_queue_worker(root, driver_dir, root / "crash-running", queue, "crash-running", root / "never2.release")
    wait_for(root / "crash-running" / "entered", running)
    running.kill()
    try:
        running.wait(timeout=10)
    except subprocess.TimeoutExpired:
        running.kill(); running.wait(timeout=5)
        raise ScenarioError("running holder did not exit after kill")
    after_release = root / "crash-after.release"
    after = spawn_queue_worker(root, driver_dir, root / "crash-after", queue, "crash-after", after_release)
    wait_for(root / "crash-after" / "entered", after)
    touch(after_release)
    wait_exit(after)


def assert_pass_fds_child_holds_lock_after_parent_exit(root: Path, driver_dir: Path, label: str, mode: str) -> None:
    queue = root / f"queue-passfds-{label}"
    parent_dir = root / f"pass-parent-{label}"
    parent = spawn_queue_worker(root, driver_dir, parent_dir, queue, f"pass-parent-{label}", mode=mode)
    wait_for(parent_dir / "child-ready")
    wait_exit(parent)
    second_release = root / f"pass-second-{label}.release"
    second_dir = root / f"pass-second-{label}"
    second = spawn_queue_worker(root, driver_dir, second_dir, queue, f"pass-second-{label}", second_release)
    status = wait_status(second_dir, "queued", second)
    if (second_dir / "entered").exists():
        raise ScenarioError(f"pass_fds lock released before inherited child exited ({label}): {status}")
    touch(parent_dir / "child-release")
    wait_for(second_dir / "entered", second)
    touch(second_release)
    wait_exit(second)


def scenario_pass_fds_child_holds_lock(root: Path, driver_dir: Path) -> None:
    if os.name == "nt":
        return
    assert_pass_fds_child_holds_lock_after_parent_exit(root, driver_dir, "normal", "parent-passfds")
    assert_pass_fds_child_holds_lock_after_parent_exit(root, driver_dir, "os-exit", "parent-passfds-os-exit")


def scenario_explicit_roots_parallel(root: Path, driver_dir: Path) -> None:
    one_release = root / "parallel-one.release"
    two_release = root / "parallel-two.release"
    one = spawn_queue_worker(root, driver_dir, root / "parallel-one", root / "isolated-q1", "parallel-one", one_release)
    two = spawn_queue_worker(root, driver_dir, root / "parallel-two", root / "isolated-q2", "parallel-two", two_release)
    wait_for(root / "parallel-one" / "entered", one)
    wait_for(root / "parallel-two" / "entered", two)
    touch(one_release); touch(two_release)
    wait_exit(one); wait_exit(two)


def scenario_driver_actions_share_one_slot(root: Path, driver_dir: Path) -> None:
    remote_root = root / "driver-remote"
    queue_root = root / "driver-queue"
    active = root / "driver-active.txt"
    releases = {action: root / f"driver-{action}.release" for action in ["build", "test", "profile", "hardware"]}
    runs = []
    for action in ["build", "test", "profile", "hardware"]:
        run = spawn_driver_worker(root, driver_dir, remote_root, queue_root, action, f"drv-{action}", releases[action], active)
        runs.append((action, run))
    wait_for(remote_root / "requests" / "drv-build" / "handler-entered", runs[0][1])
    for action in ["test", "profile", "hardware"]:
        status = wait_status(remote_root / "requests" / f"drv-{action}", "queued")
        queue_info = status.get("queue", {})
        if status.get("state") != "queued" or int(queue_info.get("position", 0)) < 1:
            raise ScenarioError(f"{action} did not queue behind build: {status}")
    remaining = dict(runs)
    while remaining:
        deadline = time.monotonic() + 20
        entered = None
        while time.monotonic() <= deadline and entered is None:
            for action in list(remaining):
                if (remote_root / "requests" / f"drv-{action}" / "handler-entered").exists():
                    entered = action
                    break
            if entered is None:
                for action, run in remaining.items():
                    if run.poll() is not None:
                        raise ScenarioError(f"driver worker {action} exited early: {run.stderr.read() if run.stderr else ''}")
                time.sleep(0.01)
        if entered is None:
            raise ScenarioError(f"no queued driver action entered; remaining={list(remaining)}")
        run = remaining.pop(entered)
        touch(releases[entered])
        wait_exit(run, timeout=20)
        result = read_json(remote_root / "requests" / f"drv-{entered}" / "result.json")
        if result.get("status") != "COMPLETED" or result.get("remote_release_confirmed") is not True:
            raise ScenarioError(f"unexpected driver result for {entered}: {result}")
    if active.exists():
        raise ScenarioError("driver active marker leaked")
    events = [json.loads(line)["action"] for line in (root / "driver-events.jsonl").read_text(encoding="utf-8").splitlines()]
    if events[0] != "build" or sorted(events) != ["build", "hardware", "profile", "test"]:
        raise ScenarioError(f"driver action coverage/order violated: {events}")


def scenario_driver_replay_same_request_id(root: Path, driver_dir: Path) -> None:
    driver = load_driver(driver_dir)
    remote_root = root / "replay-remote"
    queue_root = root / "replay-queue"
    patch_driver_handlers(driver, root, None, None, root / "replay-events.jsonl", "driver-hold")
    first = dispatch(driver, remote_root, "build", "same-request", queue_root)
    second = dispatch(driver, remote_root, "build", "same-request", queue_root)
    if first != second:
        raise ScenarioError(f"same request replay should return durable result: first={first}, second={second}")
    if (root / "same-request.count").read_text(encoding="utf-8") != "1":
        raise ScenarioError("same request replay re-executed handler")


def scenario_driver_cancel_queued_collects_cancelled(root: Path, driver_dir: Path) -> None:
    driver = load_driver(driver_dir)
    remote_root = root / "cancel-remote"
    queue_root = root / "cancel-driver-queue"
    active = root / "cancel-active.txt"
    holder_release = root / "driver-cancel-holder.release"
    queued_release = root / "driver-cancel-queued.release"
    holder = spawn_driver_worker(root, driver_dir, remote_root, queue_root, "build", "cancel-holder", holder_release, active)
    wait_for(remote_root / "requests" / "cancel-holder" / "handler-entered", holder)
    queued = spawn_driver_worker(root, driver_dir, remote_root, queue_root, "test", "cancel-queued", queued_release, active)
    queued_status = wait_status(remote_root / "requests" / "cancel-queued", "queued", queued)
    poll = dispatch(driver, remote_root, "poll", "cancel-queued", queue_root)
    if poll.get("status") != "RUNNING" or poll.get("state", {}).get("state") != "queued" or not poll.get("queue"):
        raise ScenarioError(f"poll did not expose queued state: {poll}; file={queued_status}")
    cancel = dispatch(driver, remote_root, "cancel", "cancel-queued", queue_root)
    if cancel.get("status") != "CANCEL_REQUESTED":
        raise ScenarioError(f"cancel should request cancellation while queued: {cancel}")
    wait_exit(queued)
    collected = dispatch(driver, remote_root, "collect", "cancel-queued", queue_root)
    if collected.get("status") != "CANCELLED" or collected.get("remote_release_confirmed") is not True:
        raise ScenarioError(f"collect should return durable cancelled release: {collected}")
    next_release = root / "driver-cancel-next.release"
    nxt = spawn_driver_worker(root, driver_dir, remote_root, queue_root, "profile", "cancel-next", next_release, active)
    wait_status(remote_root / "requests" / "cancel-next", "queued", nxt)
    touch(holder_release)
    wait_exit(holder)
    wait_for(remote_root / "requests" / "cancel-next" / "handler-entered", nxt)
    touch(next_release)
    wait_exit(nxt)
    if (remote_root / "requests" / "cancel-queued" / "handler-entered").exists():
        raise ScenarioError("cancelled queued driver request executed handler")


def scenario_driver_run_command_cancel_releases(root: Path, driver_dir: Path) -> None:
    remote_root = root / "cmd-remote"
    queue_root = root / "cmd-queue"
    active = root / "cmd-active.txt"
    never_release = root / "cmd-never.release"
    running = spawn_driver_worker(root, driver_dir, remote_root, queue_root, "build", "cmd-running", never_release, active, mode="driver-run-command")
    wait_for(remote_root / "requests" / "cmd-running" / "command-started", running)
    driver = load_driver(driver_dir)
    cancel = dispatch(driver, remote_root, "cancel", "cmd-running", queue_root)
    if cancel.get("status") != "CANCEL_REQUESTED":
        raise ScenarioError(f"running command cancel should be requested: {cancel}")
    wait_exit(running)
    collected = dispatch(driver, remote_root, "collect", "cmd-running", queue_root)
    if collected.get("status") != "CANCELLED" or collected.get("remote_release_confirmed") is not True:
        raise ScenarioError(f"collect after run_command cancel should be released: {collected}")
    next_release = root / "cmd-next.release"
    nxt = spawn_driver_worker(root, driver_dir, remote_root, queue_root, "test", "cmd-next", next_release, active)
    wait_for(remote_root / "requests" / "cmd-next" / "handler-entered", nxt)
    touch(next_release)
    wait_exit(nxt)


def run_driver(args: argparse.Namespace) -> int:
    os.environ["METEOR_REMOTE_DRIVER_ALLOW_NON_POSIX_ROOT"] = "1"
    queue_module = Path(args.driver_dir) / "execution_queue.py"
    if not queue_module.exists():
        raise FileNotFoundError(queue_module)
    root = Path(tempfile.mkdtemp(prefix="meteor-remote-queue-"))
    try:
        scenario_fifo_no_overlap(root, Path(args.driver_dir))
        scenario_cancel_queued(root, Path(args.driver_dir))
        scenario_crash_cleanup(root, Path(args.driver_dir))
        scenario_pass_fds_child_holds_lock(root, Path(args.driver_dir))
        scenario_explicit_roots_parallel(root, Path(args.driver_dir))
        scenario_driver_actions_share_one_slot(root, Path(args.driver_dir))
        scenario_driver_replay_same_request_id(root, Path(args.driver_dir))
        scenario_driver_cancel_queued_collects_cancelled(root, Path(args.driver_dir))
        scenario_driver_run_command_cancel_releases(root, Path(args.driver_dir))
        print(json.dumps({"ok": True, "root": str(root), "posix_pass_fds_checked": os.name != "nt"}, sort_keys=True))
        return 0
    finally:
        import shutil
        shutil.rmtree(root, ignore_errors=True)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--driver-dir", required=True, type=Path)
    parser.add_argument("--worker", choices=["acquire", "parent-passfds", "parent-passfds-os-exit", "driver-hold", "driver-run-command"])
    parser.add_argument("--request-dir", type=Path)
    parser.add_argument("--remote-root", type=Path)
    parser.add_argument("--queue-root", type=Path)
    parser.add_argument("--action")
    parser.add_argument("--request-id")
    parser.add_argument("--name")
    parser.add_argument("--release", type=Path)
    parser.add_argument("--events", type=Path)
    parser.add_argument("--active", type=Path)
    args = parser.parse_args()
    if args.worker in {"acquire", "parent-passfds", "parent-passfds-os-exit"}:
        missing = [name for name in ["request_dir", "queue_root", "name", "events"] if getattr(args, name) is None]
        if missing:
            raise SystemExit(f"missing worker args: {missing}")
        return execution_queue_worker(args)
    if args.worker in {"driver-hold", "driver-run-command"}:
        missing = [name for name in ["remote_root", "queue_root", "action", "request_id", "events"] if getattr(args, name) is None]
        if missing:
            raise SystemExit(f"missing driver worker args: {missing}")
        return driver_worker(args)
    return run_driver(args)


if __name__ == "__main__":
    raise SystemExit(main())
