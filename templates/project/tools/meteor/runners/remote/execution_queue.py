"""One FIFO execution slot per SSH user/host, shared by every Meteor project.

Ticket liveness is an OS lock, never a timestamp lease. On POSIX the driver
passes its ticket descriptor to commands so a surviving command keeps its slot
even if the driver dies. Queue metadata locks are held only during bookkeeping.
"""

import errno
import json
import os
from pathlib import Path
import tempfile
import time
import uuid


class QueueCancelled(Exception):
    pass


class FileLock:
    def __init__(self, path: Path):
        self.file = open(path, "a+b")

    def acquire(self, blocking: bool = True) -> bool:
        while True:
            try:
                if os.name == "posix":
                    import fcntl
                    fcntl.flock(self.file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                else:
                    import msvcrt
                    self.file.seek(0)
                    msvcrt.locking(self.file.fileno(), msvcrt.LK_NBLCK, 1)
                return True
            except OSError as exc:
                if exc.errno not in (errno.EACCES, errno.EAGAIN, errno.EDEADLK):
                    raise
                if not blocking:
                    return False
                time.sleep(0.05)

    def close(self):
        # Do not LOCK_UN: an inherited descriptor may still protect a live child.
        self.file.close()

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_):
        self.close()


def write_json(path: Path, value):
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, sort_keys=True) + "\n", encoding="utf-8")
    os.replace(temporary, path)


class ExecutionQueue:
    def __init__(self, request_dir: Path, action: str, queue_root: Path | None = None):
        # Linux /tmp is host-local even when HOME is an NFS mount. Different
        # accounts can deliberately share a configured, permissioned directory.
        default = Path("/tmp") / f"meteor-execution-{os.getuid()}" if os.name == "posix" else Path(tempfile.gettempdir()) / "meteor-execution"
        self.root = (queue_root or default).resolve()
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.request_dir = request_dir.resolve()
        self.action = action
        self.token = uuid.uuid4().hex
        self.lease = None
        self.entry = None
        self.queue = {}

    @property
    def pass_fds(self):
        return (self.lease.file.fileno(),) if self.lease and os.name == "posix" else ()

    def check_cancelled(self):
        if (self.request_dir / "cancel.json").exists():
            raise QueueCancelled("Remote request cancelled")

    def _load(self):
        path = self.root / "queue.json"
        return json.loads(path.read_text(encoding="utf-8")) if path.exists() else {"next_ticket": 1, "entries": []}

    def _save(self, state):
        write_json(self.root / "queue.json", state)

    def _prune(self, state):
        live = []
        for entry in state["entries"]:
            if entry["token"] == self.token and self.lease:
                live.append(entry)
                continue
            path = self.root / (entry["token"] + ".lock")
            probe = FileLock(path)
            try:
                alive = not probe.acquire(blocking=False)
            finally:
                probe.close()
            if alive:
                live.append(entry)
            else:
                path.unlink(missing_ok=True)
        state["entries"] = live

    def _publish(self, entry, position, active_request_id):
        now = time.time()
        self.queue = {
            "scope": "host", "capacity": 1, "root": str(self.root),
            "ticket": entry["ticket"], "position": position,
            "active_request_id": active_request_id,
            "enqueued_at": entry["enqueued_at"], "started_at": entry.get("started_at"),
            "wait_seconds": max(0, entry.get("started_at", now) - entry["enqueued_at"]),
        }
        write_json(self.request_dir / "status.json", {
            "state": entry["state"], "action": self.action, "pid": os.getpid(),
            "started_at": entry.get("started_at"), "queue": self.queue,
        })

    def __enter__(self):
        self.request_dir.mkdir(parents=True, exist_ok=True)
        self.lease = FileLock(self.root / (self.token + ".lock"))
        self.lease.acquire()
        try:
            with FileLock(self.root / "metadata.lock"):
                state = self._load()
                self._prune(state)
                self.entry = {
                    "token": self.token, "ticket": state["next_ticket"],
                    "request_id": self.request_dir.name, "request_dir": str(self.request_dir),
                    "action": self.action, "pid": os.getpid(),
                    "state": "queued", "enqueued_at": time.time(),
                }
                state["next_ticket"] += 1
                state["entries"].append(self.entry)
                self._save(state)
            while True:
                self.check_cancelled()
                with FileLock(self.root / "metadata.lock"):
                    state = self._load()
                    self._prune(state)
                    index = next(i for i, item in enumerate(state["entries"]) if item["token"] == self.token)
                    entry = state["entries"][index]
                    if index == 0:
                        self.check_cancelled()
                        entry["state"] = "running"
                        entry["started_at"] = time.time()
                    active = next((item["request_id"] for item in state["entries"] if item["state"] == "running"), None)
                    self._save(state)
                    # Position is zero while running; 1 is next in line. If the
                    # first ticket is still being admitted, include it as ahead.
                    self._publish(entry, 0 if index == 0 else index + (0 if active else 1), active)
                if index == 0:
                    return self
                time.sleep(0.2)
        except BaseException:
            self.__exit__(None, None, None)
            raise

    def __exit__(self, *_):
        if self.lease:
            self.lease.close()
            self.lease = None
        with FileLock(self.root / "metadata.lock"):
            state = self._load()
            self._prune(state)
            self._save(state)

    def released(self) -> bool:
        """Confirm this ticket is gone, including any inherited command handles."""
        with FileLock(self.root / "metadata.lock"):
            state = self._load()
            self._prune(state)
            self._save(state)
            return not any(entry["token"] == self.token for entry in state["entries"])
