#include <sys/syscall.h>
#include <sandstorm/seccomp-bpf/constants.h>

// Offsets to parts of `struct seccomp_data` (defined in
// `linux/seccomp.h`). NOTE: this asumes a little-endian machine,
// which is valid for x86_64 -- but we should sanity check this
// if/when we port to other architectures.
//
#define OFF_NR 0 // The syscall number.
#define OFF_ARCH 4 // The architecture for the syscall.
#define OFF_IP 8 // Instruction pointer at time of syscall.
// Arguments to the syscall. These are stored as 64-bit
// values, but bpf is a 32-bit VM, so we usually need to load
// high and low parts separately.
#define OFF_ARG_0_LO 16
#define OFF_ARG_0_HI 20
#define OFF_ARG_1_LO 24
#define OFF_ARG_1_HI 28
#define OFF_ARG_2_LO 32
#define OFF_ARG_2_HI 36
// Args can go up to 6, but we don't need more than this yet.

start:
    // Deny non-native syscalls:
    ld [OFF_ARCH]
    jne #AUDIT_ARCH_X86_64, enosys_near

    // Examine the syscall number.
    ld [OFF_NR]

    // These are all OK, regardless of arguments:
    jeq #SYS_accept, allow_near
    jeq #SYS_accept4, allow_near
    jeq #SYS_access, allow_near
    jeq #SYS_alarm, allow_near
    jeq #SYS_bind, allow_near
    jeq #SYS_brk, allow_near
    jeq #SYS_chdir, allow_near
    jeq #SYS_chmod, allow_near
    jeq #SYS_close, allow_near
    jeq #SYS_clock_getres, allow_near
    jeq #SYS_clock_gettime, allow_near
    jeq #SYS_clock_nanosleep, allow_near
    jeq #SYS_connect, allow_near
    jeq #SYS_creat, allow_near
    jeq #SYS_dup, allow_near
    jeq #SYS_dup2, allow_near
    jeq #SYS_dup3, allow_near
    jeq #SYS_epoll_create, allow_near
    jeq #SYS_epoll_create1, allow_near
    jeq #SYS_epoll_ctl, allow_near
    jeq #SYS_epoll_pwait, allow_near
    jeq #SYS_epoll_wait, allow_near
    jeq #SYS_eventfd, allow_near
    jeq #SYS_eventfd2, allow_near
    jeq #SYS_execve, allow_near
    jeq #SYS_exit, allow_near
    jeq #SYS_exit_group, allow_near
    jeq #SYS_faccessat, allow_near
    jeq #SYS_fchdir, allow_near
    jeq #SYS_fchmod, allow_near
    jeq #SYS_fchmodat, allow_near
    jeq #SYS_fcntl, allow_near
    jeq #SYS_fdatasync, allow_near
    jeq #SYS_flock, allow_near
    jeq #SYS_fork, allow_near
    jeq #SYS_fstat, allow_near
    jeq #SYS_fstatfs, allow_near
    jeq #SYS_fsync, allow_near
    jeq #SYS_ftruncate, allow_near
    jeq #SYS_futex, allow_near
    jeq #SYS_getcwd, allow_near
    jeq #SYS_getdents, allow_near
    jeq #SYS_getdents64, allow_near
    jeq #SYS_getegid, allow_near
    jeq #SYS_geteuid, allow_near
    jeq #SYS_getgid, allow_near
    jeq #SYS_getgroups, allow_near
    jeq #SYS_getitimer, allow_near
    jeq #SYS_getpeername, allow_near
    jeq #SYS_getpgid, allow_near
    jeq #SYS_getpgrp, allow_near
    jeq #SYS_getpid, allow_near
    jeq #SYS_getppid, allow_near
    jeq #SYS_getrandom, allow_near
    jeq #SYS_getresuid, allow_near
    jeq #SYS_getresgid, allow_near
    jeq #SYS_getrlimit, allow_near
    jeq #SYS_getrusage, allow_near
    jeq #SYS_getsid, allow_near
    jeq #SYS_getsockname, allow_near
    jeq #SYS_getsockopt, allow_near
    jeq #SYS_gettid, allow_near
    jeq #SYS_gettimeofday, allow_near
    jeq #SYS_getuid, allow_near
    jeq #SYS_inotify_add_watch, allow_near
    jeq #SYS_inotify_init, allow_near
    jeq #SYS_inotify_init1, allow_near
    jeq #SYS_inotify_rm_watch, allow_near
    jeq #SYS_kill, allow_near
    jeq #SYS_link, allow_near
    jeq #SYS_listen, allow_near
    jeq #SYS_lseek, allow_near
    jeq #SYS_lstat, allow_near
    jeq #SYS_mkdir, allow_near
    jeq #SYS_mremap, allow_near
    jeq #SYS_msync, allow_near
    jeq #SYS_munmap, allow_near
    jeq #SYS_nanosleep, allow_near
    jeq #SYS_newfstatat, allow_near
    jeq #SYS_open, allow_near
    jeq #SYS_openat, allow_near
    jeq #SYS_pause, allow_near
    jeq #SYS_pipe, allow_near
    jeq #SYS_pipe2, allow_near
    jeq #SYS_poll, allow_near
    jeq #SYS_ppoll, allow_near
    jeq #SYS_pread64, allow_near
    jeq #SYS_prlimit64, allow_near
    jeq #SYS_pwrite64, allow_near
    jeq #SYS_read, allow_near
    jeq #SYS_readv, allow_near
    jeq #SYS_readlink, allow_near
    jeq #SYS_readlinkat, allow_near
    jeq #SYS_rename, allow_near
    jeq #SYS_rmdir, allow_near
    jeq #SYS_rt_sigaction, allow_near
    jeq #SYS_rt_sigpending, allow_near
    jeq #SYS_rt_sigprocmask, allow_near
    jeq #SYS_rt_sigqueueinfo, allow_near
    jeq #SYS_rt_sigreturn, allow_near
    jeq #SYS_rt_sigsuspend, allow_near
    jeq #SYS_rt_sigtimedwait, allow_near
    jeq #SYS_sched_getaffinity, allow_near
    jeq #SYS_sched_setaffinity, allow_near
    jeq #SYS_select, allow_near
    jeq #SYS_sendfile, allow_near
    jeq #SYS_set_tid_address, allow_near
    jeq #SYS_setitimer, allow_near
    jeq #SYS_setrlimit, allow_near
    jeq #SYS_setsid, allow_near
    jeq #SYS_shutdown, allow_near
    jeq #SYS_sigaltstack, allow_near
    jeq #SYS_signalfd, allow_near
    jeq #SYS_signalfd4, allow_near
    jeq #SYS_stat, allow_near
    jeq #SYS_statfs, allow_near
    jeq #SYS_symlink, allow_near
    jeq #SYS_symlinkat, allow_near
    jeq #SYS_sysinfo, allow_near
    jeq #SYS_tgkill, allow_near
    jeq #SYS_timer_create, allow_near
    jeq #SYS_timer_delete, allow_near
    jeq #SYS_timer_getoverrun, allow_near
    jeq #SYS_timer_gettime, allow_near
    jeq #SYS_timer_settime, allow_near
    jeq #SYS_times, allow_near
    jeq #SYS_tkill, allow_near
    jeq #SYS_truncate, allow_near
    jeq #SYS_umask, allow_near
    jeq #SYS_uname, allow_near
    jeq #SYS_unlink, allow_near
    jeq #SYS_unlinkat, allow_near
    jeq #SYS_utime, allow_near
    jeq #SYS_vfork, allow_near
    jeq #SYS_wait4, allow_near
    jeq #SYS_write, allow_near
    jeq #SYS_writev, allow_near

    // Architecture specific: if we ever support non-x86_64
    // machines, we'll want to pay attention to this list:
    jeq #SYS_arch_prctl, allow_near

    // TODO: should we filter any of the flags for these?
    jeq #SYS_madvise, allow_near
    jeq #SYS_mmap, allow_near
    jeq #SYS_mprotect, allow_near
    jeq #SYS_recvfrom, allow_near
    jeq #SYS_recvmsg, allow_near
    jeq #SYS_sendmsg, allow_near
    jeq #SYS_sendto, allow_near
    jeq #SYS_setsockopt, allow_near

    jmp skip_near
// See the comments for the 'allow' label. These are analagous, but BPF's
// conditional jumps only have an 8-bit offset for their target, so
// for some of the early instructions the labels below are too far away,
// so we need a set that is closer.
allow_near: ret #SECCOMP_RET_ALLOW
enosys_near: ret #RET_ENOSYS
skip_near:

    // These might be okay; examine the arguments:
    jeq #SYS_clone, sys_clone
    jeq #SYS_ioctl, sys_ioctl
    // These both use the same filtering logic, so we
    // jump to the same place.
    jeq #SYS_socket, sys_socket
    jeq #SYS_socketpair, sys_socket

    // Anything else we deny. Depending on the syscall the
    // exact behavior differs, but nothing else is allowed
    // through.

    // Performance hints, so it's safe to silently no-op these:
    jeq #SYS_sched_yield, noop
    jeq #SYS_fadvise64, noop

    // These would normally be denied without elevated privileges anyway, so return
    // the right error code:
    jeq #SYS_chown, eperm
    jeq #SYS_chroot, eperm
    jeq #SYS_fchown, eperm
    jeq #SYS_fchownat, eperm
    jeq #SYS_lchown, eperm
    jeq #SYS_mount, eperm

    // Extended file attribute calls. A filesystem might
    // genuinely not support these, so apps can reasonably be
    // expected to handle ENOTSUP:
    jeq #SYS_getxattr, enotsup
    jeq #SYS_setxattr, enotsup
    jeq #SYS_listxattr, enotsup
    jeq #SYS_removexattr, enotsup
    jeq #SYS_fgetxattr, enotsup
    jeq #SYS_fsetxattr, enotsup
    jeq #SYS_flistxattr, enotsup
    jeq #SYS_fremovexattr, enotsup

    // For some older syscalls, ENOSYS is implausible, so provide
    // more reasonable errors (preferably which can happen according
    // to the docs).
    jeq #SYS_prctl, einval
    jeq #SYS_ptrace, eperm

    // Catchall: return ENOSYS.
    ret #RET_ENOSYS

sys_ioctl:
    // The request argument is 32-bit, so high should be zero.
    ld [OFF_ARG_1_HI]
    jne #0, einval

    ld [OFF_ARG_1_LO]

    // These can be used to toggle close-on-exec:
    jeq #FIOCLEX, allow
    jeq #FIONCLEX, allow

    // Common async-io-related ioctls:
    jeq #FIOASYNC, allow
    jeq #FIONBIO, allow
    jeq #FIONREAD, allow
    jeq #FIOQSIZE, allow

    // Stuff we don't want to support, but we should
    // return a sensible error code:
    jeq #FIFREEZE, eperm
    jeq #FITHAW, eperm
    jeq #FS_IOC_FIEMAP, eopnotsupp
    jeq #FICLONE, eopnotsupp
    jeq #FICLONERANGE, eopnotsupp
    jeq #FIDEDUPERANGE, eopnotsupp

    // If we don't recognize the request number, return ENOTTY,
    // which is the fallback the kernel uses as well:
    ret #RET_ENOTTY

// The logic for socket() and socketpair() is identical.
// So we use this block for both. socketpair() accepts a fourth argument, but we don't look at it.
sys_socket:
//sys_socketpair:
// socket_family:
    // Allow ip & unix domain sockets only.
    //
    // The family argument is 32-bit, so the high part of
    // the argument should be zero.
    ld [OFF_ARG_0_HI]
    jne #0, eafnosupport
    ld [OFF_ARG_0_LO]
    jeq #AF_INET, socket_type
    jeq #AF_INET6, socket_type
    jeq #AF_UNIX, socket_type
    ret #RET_EAFNOSUPPORT
socket_type:
    // Allow stream & datagram sockets only.
    ld [OFF_ARG_1_HI]
    jne #0, eacces
    ld [OFF_ARG_1_LO]
    // The type argument can have some flags or'd in with
    // it (namely SOCK_NONBLOCK and SOCK_CLOEXEC), so
    // mask those off before doing the comparison
    and #SOCK_TYPE_MASK
    jeq #SOCK_STREAM, socket_protocol
    jeq #SOCK_DGRAM, socket_protocol
    ret #RET_EACCES
socket_protocol:
    // Allow tcp, udp or 0 for the protocol.
    ld [OFF_ARG_2_HI]
    jne #0, einval
    ld [OFF_ARG_2_LO]
    jeq #0, allow
    jeq #IPPROTO_TCP, allow
    jeq #IPPROTO_UDP, allow
    ret #RET_EPROTONOSUPPORT

sys_clone:
    ld [OFF_ARG_0_HI]
    jne #0, eperm

    ld [OFF_ARG_0_LO]
    or #ALLOWED_CLONE_FLAGS
    jne #ALLOWED_CLONE_FLAGS, eperm

    jmp allow

// We can't do a conditional return, so we have stubs we can conditionally
// jump to for various return values:
allow: ret #SECCOMP_RET_ALLOW
kill: ret #SECCOMP_RET_KILL
eacces: ret #RET_EACCES
eafnosupport: ret #RET_EAFNOSUPPORT
einval: ret #RET_EINVAL
enosys: ret #RET_ENOSYS
enotsup: ret #RET_ENOTSUP
eopnotsupp: ret #RET_EOPNOTSUPP
eperm: ret #RET_EPERM

noop:
    // This is supposed to be OR'd with the errno, so
    // returning this on its own sets errno = 0, i.e. silently
    // no-ops.
    ret #SECCOMP_RET_ERRNO

// vim: set ts=4 sw=4 et :
