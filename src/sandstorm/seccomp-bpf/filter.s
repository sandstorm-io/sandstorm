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
    jne #AUDIT_ARCH_X86_64, enosys

    ld [OFF_NR]

    // These are all OK, regardless of arguments:
    jeq #SYS_accept, allow
    jeq #SYS_accept4, allow
    jeq #SYS_access, allow
    jeq #SYS_alarm, allow
    jeq #SYS_bind, allow
    jeq #SYS_brk, allow
    jeq #SYS_chdir, allow
    jeq #SYS_chmod, allow
    jeq #SYS_clone, allow
    jeq #SYS_clone3, allow
    jeq #SYS_close, allow
    jeq #SYS_clock_gettime, allow
    jeq #SYS_connect, allow
    jeq #SYS_creat, allow
    jeq #SYS_dup, allow
    jeq #SYS_dup2, allow
    jeq #SYS_dup3, allow
    jeq #SYS_epoll_create, allow
    jeq #SYS_epoll_create1, allow
    jeq #SYS_epoll_ctl, allow
    jeq #SYS_epoll_pwait, allow
    jeq #SYS_epoll_wait, allow
    jeq #SYS_eventfd, allow
    jeq #SYS_eventfd2, allow
    jeq #SYS_execve, allow
    jeq #SYS_exit, allow
    jeq #SYS_exit_group, allow
    jeq #SYS_faccessat, allow
    jeq #SYS_fchdir, allow
    jeq #SYS_fchmod, allow
    jeq #SYS_fchmodat, allow
    jeq #SYS_fcntl, allow
    jeq #SYS_fdatasync, allow
    jeq #SYS_flock, allow
    jeq #SYS_fork, allow
    jeq #SYS_fstat, allow
    jeq #SYS_fsync, allow
    jeq #SYS_ftruncate, allow
    jeq #SYS_futex, allow
    jeq #SYS_getcwd, allow
    jeq #SYS_getdents, allow
    jeq #SYS_getdents64, allow
    jeq #SYS_getegid, allow
    jeq #SYS_geteuid, allow
    jeq #SYS_getgid, allow
    jeq #SYS_getgroups, allow
    jeq #SYS_getitimer, allow
    jeq #SYS_getpeername, allow
    jeq #SYS_getpgid, allow
    jeq #SYS_getpgrp, allow
    jeq #SYS_getpid, allow
    jeq #SYS_getppid, allow
    jeq #SYS_getrandom, allow
    jeq #SYS_getrlimit, allow
    jeq #SYS_getsockname, allow
    jeq #SYS_gettid, allow
    jeq #SYS_gettimeofday, allow
    jeq #SYS_getuid, allow
    jeq #SYS_inotify_add_watch, allow
    jeq #SYS_inotify_init, allow
    jeq #SYS_inotify_init1, allow
    jeq #SYS_inotify_rm_watch, allow
    jeq #SYS_kill, allow
    jeq #SYS_link, allow
    jeq #SYS_listen, allow
    jeq #SYS_lseek, allow
    jeq #SYS_lstat, allow
    jeq #SYS_mkdir, allow
    jeq #SYS_mremap, allow
    jeq #SYS_msync, allow
    jeq #SYS_munmap, allow
    jeq #SYS_nanosleep, allow
    jeq #SYS_newfstatat, allow
    jeq #SYS_open, allow
    jeq #SYS_openat, allow
    jeq #SYS_pause, allow
    jeq #SYS_poll, allow
    jeq #SYS_ppoll, allow
    jeq #SYS_pread64, allow
    jeq #SYS_prlimit64, allow
    jeq #SYS_pwrite64, allow
    jeq #SYS_read, allow
    jeq #SYS_readlink, allow
    jeq #SYS_rename, allow
    jeq #SYS_rmdir, allow
    jeq #SYS_rt_sigaction, allow
    jeq #SYS_rt_sigprocmask, allow
    jeq #SYS_rt_sigreturn, allow
    jeq #SYS_sched_getaffinity, allow
    jeq #SYS_sched_setaffinity, allow
    jeq #SYS_select, allow
    jeq #SYS_sendfile, allow
    jeq #SYS_set_tid_address, allow
    jeq #SYS_setitimer, allow
    jeq #SYS_setrlimit, allow
    jeq #SYS_shutdown, allow
    jeq #SYS_sigaltstack, allow
    jeq #SYS_signalfd, allow
    jeq #SYS_signalfd4, allow
    jeq #SYS_stat, allow
    jeq #SYS_symlink, allow
    jeq #SYS_symlinkat, allow
    jeq #SYS_sysinfo, allow
    jeq #SYS_timer_create, allow
    jeq #SYS_timer_delete, allow
    jeq #SYS_timer_getoverrun, allow
    jeq #SYS_timer_gettime, allow
    jeq #SYS_timer_settime, allow
    jeq #SYS_umask, allow
    jeq #SYS_uname, allow
    jeq #SYS_unlink, allow
    jeq #SYS_vfork, allow
    jeq #SYS_wait4, allow
    jeq #SYS_write, allow
    jeq #SYS_writev, allow

    // Architecture specific: if we ever support non-x86_64
    // machines, we'll want to pay attention to this list:
    jeq #SYS_arch_prctl, allow

    // TODO: should we filter any of the flags for these?
    jeq #SYS_madvise, allow
    jeq #SYS_mmap, allow
    jeq #SYS_mprotect, allow
    jeq #SYS_recvfrom, allow
    jeq #SYS_recvmsg, allow
    jeq #SYS_sendmsg, allow
    jeq #SYS_sendto, allow

    // These might be okay; examine the arguments:
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

    // An old way of setting a socket to non-blocking:
    jeq #FIONBIO, allow

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
    jeq #FIONREAD, enotty
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
    // protocol must be zero
    ld [OFF_ARG_2_HI]
    jne #0, einval
    ld [OFF_ARG_2_LO]
    jne #0, einval
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
