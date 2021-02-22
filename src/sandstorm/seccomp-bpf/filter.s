#include <sys/syscall.h>
#include <sandstorm/seccomp-bpf/constants.h>

// Offsets to parts of `struct seccomp_data` (defined in
// `linux/seccomp.h`. NOTE: this asumes a little-endian machine,
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
    jne #AUDIT_ARCH_X86_64, enosys_1

    // Examine the syscall number.
    ld [OFF_NR]

    // These are all OK, regardless of arguments:
    jeq #SYS_accept, allow_1
    jeq #SYS_accept4, allow_1
    jeq #SYS_access, allow_1
    jeq #SYS_alarm, allow_1
    jeq #SYS_bind, allow_1
    jeq #SYS_brk, allow_1
    jeq #SYS_chdir, allow_1
    jeq #SYS_chmod, allow_1
    jeq #SYS_close, allow_1
    jeq #SYS_clock_gettime, allow_1
    jeq #SYS_connect, allow_1
    jeq #SYS_creat, allow_1
    jeq #SYS_dup, allow_1
    jeq #SYS_dup2, allow_1
    jeq #SYS_dup3, allow_1
    jeq #SYS_epoll_create, allow_1
    jeq #SYS_epoll_create1, allow_1
    jeq #SYS_epoll_ctl, allow_1
    jeq #SYS_epoll_pwait, allow_1
    jeq #SYS_epoll_wait, allow_1
    jeq #SYS_eventfd, allow_1
    jeq #SYS_eventfd2, allow_1
    jeq #SYS_execve, allow_1
    jeq #SYS_exit, allow_1
    jeq #SYS_exit_group, allow_1
    jeq #SYS_faccessat, allow_1
    jeq #SYS_fchdir, allow_1
    jeq #SYS_fchmod, allow_1
    jeq #SYS_fchmodat, allow_1
    jeq #SYS_fcntl, allow_1
    jeq #SYS_fdatasync, allow_1
    jeq #SYS_flock, allow_1
    jeq #SYS_fork, allow_1
    jeq #SYS_fstat, allow_1
    jeq #SYS_fsync, allow_1
    jeq #SYS_ftruncate, allow_1
    jeq #SYS_futex, allow_1
    jeq #SYS_getcwd, allow_1
    jeq #SYS_getdents, allow_1
    jeq #SYS_getdents64, allow_1
    jeq #SYS_getegid, allow_1
    jeq #SYS_geteuid, allow_1
    jeq #SYS_getgid, allow_1
    jeq #SYS_getgroups, allow_1
    jeq #SYS_getitimer, allow_1
    jeq #SYS_getpeername, allow_1
    jeq #SYS_getpgid, allow_1
    jeq #SYS_getpgrp, allow_1
    jeq #SYS_getpid, allow_1
    jeq #SYS_getppid, allow_1
    jeq #SYS_getrandom, allow_1
    jeq #SYS_getrlimit, allow_1
    jeq #SYS_getsockname, allow_1
    jeq #SYS_gettid, allow_1
    jeq #SYS_gettimeofday, allow_1
    jeq #SYS_getuid, allow_1
    jeq #SYS_inotify_add_watch, allow_1
    jeq #SYS_inotify_init, allow_1
    jeq #SYS_inotify_init1, allow_1
    jeq #SYS_inotify_rm_watch, allow_1
    jeq #SYS_kill, allow_1
    jeq #SYS_link, allow_1
    jeq #SYS_listen, allow_1
    jeq #SYS_lseek, allow_1
    jeq #SYS_lstat, allow_1
    jeq #SYS_mkdir, allow_1
    jeq #SYS_mremap, allow_1
    jeq #SYS_msync, allow_1
    jeq #SYS_munmap, allow_1
    jeq #SYS_nanosleep, allow_1
    jeq #SYS_newfstatat, allow_1
    jeq #SYS_open, allow_1
    jeq #SYS_openat, allow_1
    jeq #SYS_pause, allow_1
    jeq #SYS_pipe, allow_1
    jeq #SYS_pipe2, allow_1
    jeq #SYS_poll, allow_1
    jeq #SYS_ppoll, allow_1
    jeq #SYS_pread64, allow_1
    jeq #SYS_prlimit64, allow_1
    jeq #SYS_pwrite64, allow_1
    jeq #SYS_read, allow_1
    jeq #SYS_readv, allow_1
    jeq #SYS_readlink, allow_1
    jeq #SYS_rename, allow_1
    jeq #SYS_rmdir, allow_1
    jeq #SYS_rt_sigaction, allow_1
    jeq #SYS_rt_sigprocmask, allow_1
    jeq #SYS_rt_sigreturn, allow_1
    jeq #SYS_rt_sigsuspend, allow_1
    jeq #SYS_rt_sigtimedwait, allow_1
    jeq #SYS_sched_getaffinity, allow_1
    jeq #SYS_sched_setaffinity, allow_1
    jeq #SYS_select, allow_1
    jeq #SYS_sendfile, allow_1
    jeq #SYS_set_tid_address, allow_1
    jeq #SYS_setitimer, allow_1
    jeq #SYS_setrlimit, allow_1
    jeq #SYS_setsid, allow_1
    jeq #SYS_shutdown, allow_1
    jeq #SYS_sigaltstack, allow_1
    jeq #SYS_signalfd, allow_1
    jeq #SYS_signalfd4, allow_1
    jeq #SYS_stat, allow_1
    jeq #SYS_statfs, allow_1
    jeq #SYS_symlink, allow_1
    jeq #SYS_symlinkat, allow_1
    jeq #SYS_sysinfo, allow_1
    jeq #SYS_timer_create, allow_1
    jeq #SYS_timer_delete, allow_1
    jeq #SYS_timer_getoverrun, allow_1
    jeq #SYS_timer_gettime, allow_1
    jeq #SYS_timer_settime, allow_1
    jeq #SYS_times, allow_1
    jeq #SYS_umask, allow_1
    jeq #SYS_uname, allow_1
    jeq #SYS_unlink, allow_1
    jeq #SYS_unlinkat, allow_1
    jeq #SYS_utime, allow_1
    jeq #SYS_vfork, allow_1
    jeq #SYS_wait4, allow_1
    jeq #SYS_write, allow_1
    jeq #SYS_writev, allow_1

    // Architecture specific: if we ever support non-x86_64
    // machines, we'll want to pay attention to this list:
    jeq #SYS_arch_prctl, allow_1

    // TODO: should we filter any of the flags for these?
    jeq #SYS_madvise, allow_1
    jeq #SYS_mmap, allow_1
    jeq #SYS_mprotect, allow_1
    jeq #SYS_recvfrom, allow_1
    jeq #SYS_recvmsg, allow_1
    jeq #SYS_sendmsg, allow_1
    jeq #SYS_sendto, allow_1

    jmp skip_1
// See the comments for the 'allow' label. These are analagous, but BPF's
// conditional jumps only have an 8-bit offset for their target, so
// for some of the early instructions the labels below are too far away,
// so we need a set that is closer.
allow_1: ret #SECCOMP_RET_ALLOW
enosys_1: ret #RET_ENOSYS
skip_1:

    // These might be okay; examine the arguments:
    jeq #SYS_clone, sys_clone
    jeq #SYS_getsockopt, sys_getsockopt
    jeq #SYS_ioctl, sys_ioctl
    jeq #SYS_setsockopt, sys_setsockopt
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

    // Catchall: return ENOSYS.
    ret #RET_ENOSYS

sys_getsockopt:
// getsockopt_level:
    ld [OFF_ARG_1_HI]
    jne #0, einval

    ld [OFF_ARG_1_LO]
    jeq #SOL_SOCKET, getsockopt_sol_socket
    jeq #IPPROTO_TCP, getsockopt_ipproto_tcp
    jeq #IPPROTO_IPV6, getsockopt_ipproto_ipv6
    ret #RET_EINVAL
getsockopt_sol_socket:
    ld [OFF_ARG_2_HI]
    jne #0, einval

    ld [OFF_ARG_2_LO]
    jeq #SO_ACCEPTCONN, allow
    jeq #SO_DOMAIN, allow
    jeq #SO_ERROR, allow
    jeq #SO_PROTOCOL, allow
    jeq #SO_TYPE, allow

    jeq #SO_BROADCAST, allow
    jeq #SO_KEEPALIVE, allow
    jeq #SO_LINGER, allow
    jeq #SO_OOBINLINE, allow
    jeq #SO_REUSEADDR, allow
    jeq #SO_SNDBUF, allow
    jeq #SO_RCVBUF, allow
    jeq #SO_RCVTIMEO, allow
    jeq #SO_SNDTIMEO, allow
    jeq #SO_RCVLOWAT, allow

    ret #RET_EINVAL
getsockopt_ipproto_tcp:
    ld [OFF_ARG_2_HI]
    jne #0, einval

    ret #RET_EINVAL
getsockopt_ipproto_ipv6:
    ld [OFF_ARG_2_HI]
    jne #0, einval

    ret #RET_EINVAL

sys_ioctl:
    // Check the ioctl number. If we don't recognize it,
    // return EINVAL.

    // The request argument is 32-bit, so high should be zero.
    ld [OFF_ARG_1_HI]
    jne #0, einval

    ld [OFF_ARG_1_LO]

    // Async-io related ioctls
    jeq #FIONBIO, allow
    jeq #FIOASYNC, allow
    jeq #FIONREAD, allow

    // tty ioctls. We don't provide terminal access,
    // so just return ENOTTY.
    jeq #TCGETS, enotty
    jeq #TCSETS, enotty
    jeq #TCSETSW, enotty
    jeq #TCSETSF, enotty
    jeq #TCGETA, enotty
    jeq #TCSETA, enotty
    jeq #TCSETAW, enotty
    jeq #TCSETAF, enotty
    jeq #TIOCGLCKTRMIOS, enotty
    jeq #TIOCSLCKTRMIOS, enotty
    jeq #TIOCGWINSZ, enotty
    jeq #TIOCSWINSZ, enotty
    jeq #TCSBRK, enotty
    jeq #TIOCCBRK, enotty
    jeq #TCXONC, enotty
    jeq #TIOCINQ, enotty
    jeq #TIOCOUTQ, enotty
    jeq #TCFLSH, enotty
    jeq #TIOCSTI, enotty
    jeq #TIOCCONS, enotty
    jeq #TIOCSCTTY, enotty
    jeq #TIOCNOTTY, enotty
    jeq #TIOCSPGRP, enotty
    jeq #TIOCEXCL, enotty
    jeq #TIOCNXCL, enotty
    jeq #TIOCGETD, enotty
    jeq #TIOCSETD, enotty

    ret #RET_EINVAL

sys_setsockopt:
// setsockopt_level:
    ld [OFF_ARG_1_HI]
    jne #0, einval

    ld [OFF_ARG_1_LO]
    jeq #SOL_SOCKET, setsockopt_sol_socket
    jeq #IPPROTO_TCP, setsockopt_ipproto_tcp
    jeq #IPPROTO_IPV6, setsockopt_ipproto_ipv6
    ret #RET_EINVAL
setsockopt_sol_socket:
    ld [OFF_ARG_2_HI]
    jne #0, einval

    ld [OFF_ARG_2_LO]
    jeq #SO_BROADCAST, allow
    jeq #SO_KEEPALIVE, allow
    jeq #SO_LINGER, allow
    jeq #SO_OOBINLINE, allow
    jeq #SO_REUSEADDR, allow
    jeq #SO_SNDBUF, allow
    jeq #SO_RCVBUF, allow
    jeq #SO_RCVTIMEO, allow
    jeq #SO_SNDTIMEO, allow
    jeq #SO_RCVLOWAT, allow
    ret #RET_EINVAL
setsockopt_ipproto_tcp:
    ld [OFF_ARG_2_HI]
    jne #0, einval

    ld [OFF_ARG_2_LO]
    jeq #TCP_CORK, allow
    jeq #TCP_NODELAY, allow
    ret #RET_EINVAL
setsockopt_ipproto_ipv6:
    ld [OFF_ARG_2_HI]
    jne #0, einval

    ld [OFF_ARG_2_LO]
    jeq #IPV6_V6ONLY, allow
    ret #RET_EINVAL

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
    or #ALLOWED_CLONE_FLAGS_HI
    jne #ALLOWED_CLONE_FLAGS_HI, eperm

    ld [OFF_ARG_0_LO]
    or #ALLOWED_CLONE_FLAGS_LO
    jne #ALLOWED_CLONE_FLAGS_LO, eperm

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
enotty: ret #RET_ENOTTY
eperm: ret #RET_EPERM

noop:
    // This is supposed to be OR'd with the errno, so
    // returning this on its own sets errno = 0, i.e. silently
    // no-ops.
    ret #SECCOMP_RET_ERRNO

// vim: set ts=4 sw=4 et :
