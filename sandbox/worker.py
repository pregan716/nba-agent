"""Executed as uid 1000 with no capabilities. Kernel policy precedes untrusted code."""

import ctypes
import errno
import json
import sys

libc = ctypes.CDLL(None, use_errno=True)
if libc.prctl(38, 1, 0, 0, 0) != 0:  # PR_SET_NO_NEW_PRIVS
    raise RuntimeError("no_new_privs failed")
sec = ctypes.CDLL("libseccomp.so.2", use_errno=True)
sec.seccomp_init.argtypes = [ctypes.c_uint32]
sec.seccomp_init.restype = ctypes.c_void_p
sec.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
sec.seccomp_rule_add.argtypes = [
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_int,
    ctypes.c_uint,
]
sec.seccomp_load.argtypes = [ctypes.c_void_p]
ctx = sec.seccomp_init(0x7FFF0000)  # ALLOW; Docker's outer filter also remains active.
for name in [
    "socket",
    "socketpair",
    "execve",
    "execveat",
    "fork",
    "vfork",
    "ptrace",
    "process_vm_readv",
    "process_vm_writev",
    "mount",
    "umount2",
    "unshare",
    "setns",
    "bpf",
    "keyctl",
    "open_by_handle_at",
    "symlink",
    "symlinkat",
    "link",
    "linkat",
    "setsid",
    "setpgid",
]:
    nr = sec.seccomp_syscall_resolve_name(name.encode())
    if nr >= 0 and sec.seccomp_rule_add(ctx, 0x50000 | errno.EPERM, nr, 0) != 0:
        raise RuntimeError("seccomp rule failed")


# Allow native numerical threads, but no additional processes. clone3 falls back to clone.
class Compare(ctypes.Structure):
    _fields_ = [
        ("arg", ctypes.c_uint),
        ("op", ctypes.c_int),
        ("a", ctypes.c_uint64),
        ("b", ctypes.c_uint64),
    ]


sec.seccomp_rule_add_array.argtypes = [
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_int,
    ctypes.c_uint,
    ctypes.POINTER(Compare),
]
rule = Compare(0, 7, 0x10000, 0)  # MASKED_EQ: CLONE_THREAD absent
if (
    sec.seccomp_rule_add_array(
        ctx,
        0x50000 | errno.EPERM,
        sec.seccomp_syscall_resolve_name(b"clone"),
        1,
        ctypes.byref(rule),
    )
    != 0
):
    raise RuntimeError("clone policy failed")
clone3 = sec.seccomp_syscall_resolve_name(b"clone3")
if clone3 >= 0 and sec.seccomp_rule_add(ctx, 0x50000 | errno.ENOSYS, clone3, 0) != 0:
    raise RuntimeError("clone3 policy failed")
if sec.seccomp_load(ctx) != 0:
    raise RuntimeError("seccomp load failed")
program = json.load(sys.stdin)["program"]
exec(compile(program, "<agent>", "exec"), {"__name__": "__main__"})
