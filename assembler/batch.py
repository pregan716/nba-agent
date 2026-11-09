"""Stream states through fresh forked interpreters, without restarting Docker.

The supervisor never imports the package. It receives one state at a time; the
host uses length-prefixed frames, so input is read without buffering later states. Each child has fresh module/random
state, closed input, and an empty scratch directory, just like worker.py.
"""
import ctypes
import contextlib
import importlib.util
import pathlib
import random
import json
import os
import select
import shutil
import signal
import sys
import struct
import time

# Prevent package children opening the supervisor's /proc/<pid>/fd descriptors.
ctypes.CDLL(None).prctl(4, 0, 0, 0, 0)  # PR_SET_DUMPABLE


def execute(message):
    read_fd, write_fd = os.pipe()
    pid = os.fork()
    if pid == 0:
        os.close(read_fd)
        sys.stdin.close()
        os.dup2(write_fd, 1)
        os.dup2(write_fd, 2)
        os.close(write_fd)
        try:
            # Match the single-state entrypoint, in a fresh child each time.
            random.seed(0)
            with contextlib.redirect_stdout(sys.stderr):
                spec = importlib.util.spec_from_file_location("policy", "/package/assemble.py")
                module = importlib.util.module_from_spec(spec)
                spec.loader.exec_module(module)
                if not callable(getattr(module, "assemble", None)):
                    raise ValueError("assemble entry point missing")
                value = module.assemble(message["state"])
            # Separate result from diagnostics using a dedicated final frame.
            result = json.dumps({"value": value}, sort_keys=True, separators=(",", ":"), allow_nan=False)
            print("\nBATCH_RESULT:" + result, flush=True)
            os._exit(0)
        except BaseException:
            os._exit(1)
    os.close(write_fd)
    output = bytearray()
    end = time.monotonic() + message["wallSeconds"]
    error = None
    try:
        while True:
            remaining = end - time.monotonic()
            if remaining <= 0:
                error = "Assembler wall-clock limit"
                break
            ready, _, _ = select.select([read_fd], [], [], remaining)
            if not ready:
                error = "Assembler wall-clock limit"
                break
            chunk = os.read(read_fd, 65536)
            if not chunk:
                break
            output.extend(chunk)
            # The framing overhead is not package output.
            if len(output) > message["outputBytes"] + 32:
                error = "Assembler output limit"
                break
    finally:
        # In the container PID namespace, kill all remaining children (including
        # package-created descendants) before the next state. PID 1 is excluded.
        try:
            os.kill(-1, signal.SIGKILL)
        except ProcessLookupError:
            pass
        os.close(read_fd)
        _, status = os.waitpid(pid, 0)
        while True:
            try:
                os.waitpid(-1, os.WNOHANG)
            except ChildProcessError:
                break
            else:
                break
        for name in os.listdir("/scratch"):
            path = os.path.join("/scratch", name)
            if os.path.isdir(path) and not os.path.islink(path):
                shutil.rmtree(path)
            else:
                os.unlink(path)
    if error:
        return {"error": error}
    if status != 0:
        return {"error": "Assembler failed"}
    try:
        return json.loads(output.rsplit(b"\nBATCH_RESULT:", 1)[1])
    except (ValueError, IndexError):
        return {"error": "Invalid assembler JSON"}


def read_exact(size):
    chunks = bytearray()
    while len(chunks) < size:
        part = os.read(0, size - len(chunks))
        if not part:
            if chunks:
                raise ValueError("Truncated batch input")
            return None
        chunks.extend(part)
    return chunks


while True:
    header = read_exact(4)
    if header is None:
        break
    length = struct.unpack("!I", header)[0]
    message = json.loads(read_exact(length))
    result = execute(message)
    print(json.dumps(result, separators=(",", ":"), allow_nan=False), flush=True)
    del message, result, header, length
