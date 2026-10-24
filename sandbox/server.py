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
    def getattr(self, path, fh=None):
        if path == "/":
            return dict(
                st_mode=stat.S_IFDIR | 0o755, st_nlink=2, st_uid=1000, st_gid=1000
            )
        parent, _, name = path[1:].rpartition("/")
        for entry in rpc("list", path=parent)["entries"]:
            if entry["path"].split("/")[-1] == name:
                directory = entry["kind"] == "directory"
                return dict(
                    st_mode=(
                        (stat.S_IFDIR | 0o755) if directory else (stat.S_IFREG | 0o644)
                    ),
                    st_nlink=2 if directory else 1,
                    st_size=entry["bytes"] or 0,
                    st_uid=1000,
                    st_gid=1000,
                )
        raise FuseOSError(errno.ENOENT)

    def readdir(self, path, fh):
        return [".", ".."] + [
            e["path"].split("/")[-1]
            for e in rpc("list", path=path.lstrip("/"))["entries"]
        ]

    def open(self, path, flags):
        # Kernel writes are separately authorized; open itself must not replace files.
        return flags

    def create(self, path, mode, fi=None):
        rpc("mutate", operation_kind="write", path=path[1:], content="")
        return os.O_WRONLY

    def read(self, path, size, offset, fh):
        return base64.b64decode(rpc("read", path=path[1:]))[offset : offset + size]

    def write(self, path, data, offset, fh):
        current = base64.b64decode(rpc("read", path=path[1:]))
        if fh & os.O_APPEND:
            rpc(
                "mutate",
                operation_kind="append",
                path=path[1:],
                content=base64.b64encode(data).decode(),
            )
        else:
            # Newly created files may be populated via append; any non-end write
            # requires replacement permission. O_TRUNC is checked by truncate().
            if offset == len(current):
                rpc(
                    "mutate",
                    operation_kind="append",
                    path=path[1:],
                    content=base64.b64encode(data).decode(),
                )
            else:
                value = (
                    current[:offset].ljust(offset, b"\0")
                    + data
                    + current[offset + len(data) :]
                )
                rpc(
                    "mutate",
                    operation_kind="write",
                    path=path[1:],
                    content=base64.b64encode(value).decode(),
                )
        return len(data)

    def truncate(self, path, length, fh=None):
        current = base64.b64decode(rpc("read", path=path[1:]))
        rpc(
            "mutate",
            operation_kind="write",
            path=path[1:],
            content=base64.b64encode(current[:length].ljust(length, b"\0")).decode(),
        )

    def unlink(self, path):
        rpc("mutate", operation_kind="delete", path=path[1:])

    def flush(self, path, fh):
        return 0

    def fsync(self, path, datasync, fh):
        return 0

    def release(self, path, fh):
        return 0

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
