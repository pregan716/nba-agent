"""Trusted supervisor and FUSE relay. Only protocol frames reach container stdout.
The agent has different credentials, separate pipes and an inherited seccomp filter.
"""

import base64
import errno
import json
import os
import queue
import select
import signal
import stat
import subprocess
import sys
import threading
import time
from fuse import FUSE, Operations, FuseOSError

out_lock = threading.Lock()
pending = {}
sequence = 0
rpc_lock = threading.Lock()
active = False


def send(value):
    with out_lock:
        print(json.dumps(value), flush=True)


def rpc(operation, **args):
    global sequence
    with rpc_lock:
        sequence += 1
        ident = sequence
        response = queue.Queue()
        pending[ident] = response
    send(dict(type="workspace", id=ident, operation=operation, **args))
    result = response.get(timeout=30)
    pending.pop(ident, None)
    if "error" in result:
        raise FuseOSError(
            errno.ENOENT if result["error"] == "not_found" else errno.EACCES
        )
    return result["value"]


class Mount(Operations):
    def __init__(self):
        self.handles = {}
        self.files = {}
        self.sequence = 0

    def metadata(self, size):
        return dict(
            st_mode=stat.S_IFREG | 0o644,
            st_nlink=1,
            st_size=size,
            st_uid=1000,
            st_gid=1000,
        )

    def size(self, state):
        return (state["base_size"] if state["operation"] == "append" else 0) + len(
            state["pending"]
        )

    def getattr(self, path, fh=None):
        if path == "/":
            return dict(
                st_mode=stat.S_IFDIR | 0o755, st_nlink=2, st_uid=1000, st_gid=1000
            )
        if path in self.files:
            return self.metadata(self.size(self.files[path]))
        parent, _, name = path[1:].rpartition("/")
        for entry in rpc("list", path=parent)["entries"]:
            if entry["path"].split("/")[-1] == name:
                if entry["kind"] == "directory":
                    return dict(
                        st_mode=stat.S_IFDIR | 0o755,
                        st_nlink=2,
                        st_uid=1000,
                        st_gid=1000,
                    )
                return self.metadata(entry["bytes"] or 0)
        raise FuseOSError(errno.ENOENT)

    def readdir(self, path, fh):
        names = {
            e["path"].split("/")[-1]
            for e in rpc("list", path=path.lstrip("/"))["entries"]
        }
        names.update(
            p.rsplit("/", 1)[1]
            for p in self.files
            if p.rsplit("/", 1)[0] == path.rstrip("/")
        )
        return [".", ".."] + sorted(names)

    def open(self, path, flags):
        if path not in self.files:
            self.files[path] = dict(
                base_size=self.getattr(path)["st_size"],
                pending=bytearray(),
                operation="append",
                dirty=False,
                cache=None,
            )
        self.sequence += 1
        self.handles[self.sequence] = (path, flags)
        return self.sequence

    def create(self, path, mode, fi=None):
        rpc("authorize", operation_kind="write", path=path[1:])
        self.files[path] = dict(
            base_size=0, pending=bytearray(), operation="write", dirty=True, cache=None
        )
        return self.open(path, os.O_WRONLY)

    def contents(self, path):
        state = self.files[path]
        if state["operation"] == "write":
            return bytes(state["pending"])
        if state["cache"] is None:
            state["cache"] = base64.b64decode(rpc("read", path=path[1:]))
        return state["cache"] + state["pending"]

    def read(self, path, size, offset, fh):
        state = self.files[path]
        if state["operation"] == "write":
            return bytes(state["pending"][offset : offset + size])
        if state["cache"] is None:
            state["cache"] = base64.b64decode(rpc("read", path=path[1:]))
        base = state["cache"]
        return base[offset : offset + size] + bytes(
            state["pending"][
                max(0, offset - len(base)) : max(0, offset + size - len(base))
            ]
        )

    def write(self, path, data, offset, fh):
        state = self.files[path]
        flags = self.handles[fh][1]
        if flags & os.O_APPEND:
            offset = self.size(state)
        if offset == self.size(state):
            # No readback for append or sequential writes. One pending mutation
            # per stream, checked again by the host at flush/close.
            state["pending"].extend(data)
        else:
            rpc("authorize", operation_kind="write", path=path[1:])
            current = self.contents(path)
            state["pending"] = bytearray(
                current[:offset].ljust(offset, b"\0")
                + data
                + current[offset + len(data) :]
            )
            state["operation"] = "write"
            state["cache"] = None
        state["dirty"] = True
        return len(data)

    def truncate(self, path, length, fh=None):
        rpc("authorize", operation_kind="write", path=path[1:])
        temporary = path not in self.files
        handle = self.open(path, os.O_WRONLY) if temporary else None
        current = self.contents(path) if length else b""
        state = self.files[path]
        state.update(
            pending=bytearray(current[:length].ljust(length, b"\0")),
            operation="write",
            dirty=True,
            cache=None,
        )
        # Path-based truncate need not be followed by open. Persist it before
        # replying; descriptor-based truncation can share the buffered stream.
        if handle is not None:
            self.release(path, handle)

    def unlink(self, path):
        rpc("authorize", operation_kind="delete", path=path[1:])
        if path in self.files:
            self.flush(path, None)
        rpc("mutate", operation_kind="delete", path=path[1:])
        self.files.pop(path, None)

    def flush(self, path, fh):
        state = self.files.get(path)
        if state and state["dirty"]:
            result = rpc(
                "mutate",
                operation_kind=state["operation"],
                path=path[1:],
                content=base64.b64encode(state["pending"]).decode(),
            )
            state.update(
                base_size=result["bytes"],
                pending=bytearray(),
                operation="append",
                dirty=False,
                cache=None,
            )
        return 0

    def fsync(self, path, datasync, fh):
        return self.flush(path, fh)

    def release(self, path, fh):
        try:
            return self.flush(path, fh)
        finally:
            self.handles.pop(fh, None)
            if not any(p == path for p, _ in self.handles.values()):
                self.files.pop(path, None)

    def chmod(self, *args):
        raise FuseOSError(errno.EPERM)

    def chown(self, *args):
        raise FuseOSError(errno.EPERM)

    def link(self, *args):
        raise FuseOSError(errno.EPERM)

    def symlink(self, *args):
        raise FuseOSError(errno.EPERM)

    def rename(self, *args):
        raise FuseOSError(errno.EPERM)

    def mkdir(self, path, mode):
        rpc("mkdir", path=path[1:])

    def rmdir(self, *args):
        raise FuseOSError(errno.EPERM)


def cpu():
    with open("/sys/fs/cgroup/cpu.stat") as f:
        return int(dict(line.split() for line in f)["usage_usec"]) / 1e6


def oom_kills():
    with open("/sys/fs/cgroup/memory.events") as f:
        return int(dict(line.split() for line in f).get("oom_kill", 0))


def kill_workers():
    for entry in os.listdir("/proc"):
        if entry.isdigit():
            try:
                if os.stat("/proc/" + entry).st_uid == 1000:
                    os.kill(int(entry), signal.SIGKILL)
            except (FileNotFoundError, ProcessLookupError):
                pass


def execute(request):
    global active
    start = time.monotonic()
    before = cpu()
    oom_before = oom_kills()
    limit = None
    cap = request["limits"]["stdoutBytes"]
    buffers = [bytearray(), bytearray()]
    truncated = False
    process = None
    try:
        process = subprocess.Popen(
            [sys.executable, "-I", "/opt/worker.py"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd="/scratch",
            user=1000,
            group=1000,
            extra_groups=[],
        )
        process.stdin.write(json.dumps({"program": request["program"]}).encode())
        process.stdin.close()
        streams = {process.stdout: 0, process.stderr: 1}
        while streams or process.poll() is None:
            if cpu() - before >= request["limits"]["computeSeconds"]:
                limit = "compute"
            elif time.monotonic() - start >= request["limits"]["wallSeconds"]:
                limit = "wall_clock"
            if limit:
                kill_workers()
            ready, _, _ = select.select(list(streams), [], [], 0.01)
            for stream in ready:
                chunk = os.read(stream.fileno(), 65536)
                if not chunk:
                    del streams[stream]
                    continue
                output = buffers[streams[stream]]
                available = max(0, cap - len(output))
                output.extend(chunk[:available])
                truncated |= len(chunk) > available
        status = process.wait()
        if oom_kills() > oom_before:
            limit = "memory"
        kill_workers()
        active = False
        send(
            dict(
                type="result",
                stdout=base64.b64encode(buffers[0]).decode(),
                stderr=base64.b64encode(buffers[1]).decode(),
                exitStatus=status,
                computeSeconds=max(0, cpu() - before),
                truncated=truncated,
                limit=limit,
            )
        )
    except Exception as error:
        kill_workers()
        active = False
        send(dict(type="failure", message=type(error).__name__))
    finally:
        active = False


if os.environ.get("WORKSPACE_MOUNT") == "1":
    os.chmod("/dev/fuse", 0o600)
    mount = threading.Thread(
        target=lambda: FUSE(
            Mount(),
            "/workspace",
            foreground=True,
            allow_other=True,
            nothreads=True,
            attr_timeout=0,
            entry_timeout=0,
            negative_timeout=0,
            direct_io=True,
        ),
        daemon=True,
    )
    mount.start()
    for _ in range(500):
        if os.path.ismount("/workspace"):
            break
        time.sleep(0.01)
    else:
        raise RuntimeError("FUSE mount failed")
send(dict(type="ready", cpu=cpu()))
for line in sys.stdin:
    message = json.loads(line)
    if message.get("type") == "workspace_response":
        if message["id"] in pending:
            pending[message["id"]].put(message)
    elif message.get("type") == "execute" and not active:
        active = True
        threading.Thread(target=execute, args=(message,), daemon=True).start()
    else:
        raise RuntimeError("Invalid supervisor request")
kill_workers()
