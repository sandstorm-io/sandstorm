// This program prints out a "clean" header for use in bpf assembly, defining
// constants we need from various system headers. `bpf_asm` will choke on the
// originals, for two reasons:
//
// 1. They contain C code
// 2. The #defines use expressions, which `bpf_asm` doesn't understand.
//
// Luckily, we *don't* need to do this for <sys/syscall.h>, since it has
// neither of the above problems.

#define _GNU_SOURCE
// For various constants:
#include <linux/audit.h>
#include <linux/sched.h>
#include <linux/seccomp.h>
#include <sys/socket.h>
#include <sys/ioctl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>

// to return specific errno values, we need to do
// ret (SECCOMP_RET_ERRNO | value), but we can't put expressions
// in macros to be used in bpf asm. Instead, we generate RET_value
// constants for each value we need.
#include <errno.h>

/* printf: */
#include <stdio.h>

/* size_t: */
#include <stddef.h>

// The kernel defines this constant, but it isn't exposed in
// the headers. It is needed to mask off things that can
// be OR'd in with socket()'s type argument.
#define SOCK_TYPE_MASK 0x0f

// Print out a #define for a constant with the name `sym`, with
// the correct value but no operators.
#define DEF(sym) \
  printf("#define %s 0x%x\n", #sym, sym)

#define DEF_ERET(sym) \
  printf("#define %s 0x%x\n", "RET_" #sym, SECCOMP_RET_ERRNO | sym)

// Permitted flags passed to clone(). This is most things that
// unprvileged processes can use, but with a few omissions, most
// notably CLONE_NEWUSER.
#define ALLOWED_CLONE_FLAGS \
  ( CSIGNAL \
  | CLONE_CHILD_CLEARTID \
  | CLONE_CHILD_SETTID \
  | CLONE_SIGHAND \
  | CLONE_CLEAR_SIGHAND \
  | CLONE_FILES \
  | CLONE_FS \
  | CLONE_IO \
  | CLONE_PARENT \
  | CLONE_PARENT_SETTID \
  | CLONE_SETTLS \
  | CLONE_SYSVSEM \
  | CLONE_THREAD \
  | CLONE_VFORK \
  | CLONE_VM \
  )
#define ALLOWED_CLONE_FLAGS_LO \
  ((unsigned int)(ALLOWED_CLONE_FLAGS & 0xffffffff))
#define ALLOWED_CLONE_FLAGS_HI \
  ((unsigned int)(ALLOWED_CLONE_FLAGS >> 32))

int main(void) {
  // constants from linux/audit.h -- architecture constants
  DEF(AUDIT_ARCH_I386);
  DEF(AUDIT_ARCH_X86_64);

  // constants from linux/seccomp.h -- seccomp return values
  DEF(SECCOMP_RET_ALLOW);
  DEF(SECCOMP_RET_ERRNO);
  DEF(SECCOMP_RET_KILL);
  DEF(SECCOMP_RET_TRACE);
  DEF(SECCOMP_RET_TRAP);

  // constants from sys/socket.h -- arguments to socket syscall
  DEF(AF_INET);
  DEF(AF_INET6);
  DEF(AF_UNIX);
  DEF(SOCK_DGRAM);
  DEF(SOCK_STREAM);
  DEF(IPPROTO_TCP);
  DEF(IPPROTO_UDP);

  DEF(SOCK_TYPE_MASK);

  // tty ioctls
  DEF(TCGETS);
  DEF(TCSETS);
  DEF(TCSETSW);
  DEF(TCSETSF);
  DEF(TCGETA);
  DEF(TCSETA);
  DEF(TCSETAW);
  DEF(TCSETAF);
  DEF(TIOCGLCKTRMIOS);
  DEF(TIOCSLCKTRMIOS);
  DEF(TIOCGWINSZ);
  DEF(TIOCSWINSZ);
  DEF(TCSBRK);
  DEF(TIOCCBRK);
  DEF(TCXONC);
  DEF(TIOCINQ);
  DEF(TIOCOUTQ);
  DEF(TCFLSH);
  DEF(TIOCSTI);
  DEF(TIOCCONS);
  DEF(TIOCSCTTY);
  DEF(TIOCNOTTY);
  DEF(TIOCSPGRP);
  DEF(TIOCEXCL);
  DEF(TIOCNXCL);
  DEF(TIOCGETD);
  DEF(TIOCSETD);

  // async io related ioctls
  DEF(FIONBIO);
  DEF(FIONREAD);
  DEF(FIOASYNC);

  // getsockopt/setsockopt args
  DEF(SOL_SOCKET);
  DEF(SO_ACCEPTCONN);
  DEF(SO_DOMAIN);
  DEF(SO_ERROR);
  DEF(SO_PROTOCOL);
  DEF(SO_TYPE);
  DEF(SO_BROADCAST);
  DEF(SO_KEEPALIVE);
  DEF(SO_LINGER);
  DEF(SO_OOBINLINE);
  DEF(SO_REUSEADDR);
  DEF(SO_SNDBUF);
  DEF(SO_RCVBUF);
  DEF(SO_RCVTIMEO);
  DEF(SO_SNDTIMEO);
  DEF(SO_RCVLOWAT);
  DEF(IPPROTO_TCP);
  DEF(TCP_CORK);
  DEF(TCP_NODELAY);
  DEF(IPPROTO_IPV6);
  DEF(IPV6_V6ONLY);

  DEF(ALLOWED_CLONE_FLAGS_LO);
  DEF(ALLOWED_CLONE_FLAGS_HI);

  // errno return values; RET_value == (SECCOMP_RET_ERRNO | value).
  DEF_ERET(EACCES);
  DEF_ERET(EAFNOSUPPORT);
  DEF_ERET(EPROTONOSUPPORT);
  DEF_ERET(EINVAL);
  DEF_ERET(ENOSYS);
  DEF_ERET(ENOTSUP);
  DEF_ERET(ENOTTY);
  DEF_ERET(EPERM);

  return 0;
}

// vim: set ts=2 sw=2 et :
