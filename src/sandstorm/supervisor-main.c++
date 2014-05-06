// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/async-io.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/rpc.capnp.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/mount.h>
#include <sys/fsuid.h>
#include <sys/prctl.h>
#include <sys/capability.h>
#include <netinet/in.h>
#include <net/if.h>
#include <linux/sockios.h>
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <limits.h>
#include <sched.h>
#include <dirent.h>
#include <pwd.h>
#include <grp.h>

#include <sandstorm/grain.capnp.h>
#include <sandstorm/supervisor.capnp.h>

#include "version.h"

// In case kernel headers are old.
#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

namespace sandstorm {

typedef unsigned int uint;

// =======================================================================================
// Termination handling:  Must kill child if parent terminates.
//
// We also terminate automatically if we don't receive any keep-alives in a 5-minute interval.

pid_t childPid = 0;
bool keepAlive = true;

void logSafely(const char* text) {
  // Log a message in an async-signal-safe way.

  while (text[0] != '\0') {
    ssize_t n = write(STDERR_FILENO, text, strlen(text));
    if (n < 0) return;
    text += n;
  }
}

#define SANDSTORM_LOG(text) \
  logSafely("** SANDSTORM SUPERVISOR: " text "\n")

void killChild() {
  if (childPid != 0) {
    kill(childPid, SIGKILL);
    childPid = 0;
  }

  // We don't have to waitpid() because when we exit the child will be adopted by init which will
  // automatically reap it.
}

void killChildAndExit(int status) KJ_NORETURN;
void killChildAndExit(int status) {
  killChild();

  // TODO(cleanup):  Decide what exit status is supposed to mean.  Maybe it should just always be
  //   zero?
  _exit(status);
}

void signalHandler(int signo) {
  switch (signo) {
    case SIGCHLD:
      // Oh, our child exited.  I guess we're useless now.
      SANDSTORM_LOG("Grain shutting down because child exited.");
      _exit(0);

    case SIGALRM:
      if (keepAlive) {
        SANDSTORM_LOG("Grain still in use; staying up for now.");
        keepAlive = false;
        return;
      }
      SANDSTORM_LOG("Grain no longer in use; shutting down.");
      killChildAndExit(0);

    case SIGINT:
    case SIGTERM:
      SANDSTORM_LOG("Grain supervisor terminated by signal.");
      killChildAndExit(0);

    default:
      // Some signal that should cause death.
      SANDSTORM_LOG("Grain supervisor crashed due to signal.");
      killChildAndExit(1);
  }
}

int DEATH_SIGNALS[] = {
  // All signals that by default terminate the process.
  SIGHUP, SIGINT, SIGQUIT, SIGILL, SIGABRT, SIGFPE, SIGSEGV, SIGTERM, SIGUSR1, SIGUSR2, SIGBUS,
  SIGPOLL, SIGPROF, SIGSYS, SIGTRAP, SIGVTALRM, SIGXCPU, SIGXFSZ, SIGSTKFLT, SIGPWR
};

void registerSignalHandlers() {
  // Create a sigaction that runs our signal handler with all signals blocked.  Our signal handler
  // completes (or exits) quickly anyway, so let's not try to deal with it being interruptable.
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = &signalHandler;
  sigfillset(&action.sa_mask);

  // SIGALRM will fire every five minutes and will kill us if no keepalive was received in that
  // time.
  KJ_SYSCALL(sigaction(SIGALRM, &action, nullptr));

  // Other death signals simply kill us immediately.
  for (int signo: kj::ArrayPtr<int>(DEATH_SIGNALS)) {
    KJ_SYSCALL(sigaction(signo, &action, nullptr));
  }

  // SIGCHLD will fire when the child exits, in which case we might as well also exit.
  action.sa_flags = SA_NOCLDSTOP;  // Only fire when child exits.
  KJ_SYSCALL(sigaction(SIGCHLD, &action, nullptr));

  // Set up the SIGALRM timer.  Note that this is not inherited over fork.
  struct itimerval timer;
  memset(&timer, 0, sizeof(timer));
  timer.it_interval.tv_sec = 300;
  timer.it_value.tv_sec = 300;
  KJ_SYSCALL(setitimer(ITIMER_REAL, &timer, nullptr));
}

// =======================================================================================

class SupervisorMain {
  // Main class for the Sandstorm supervisor.  This program:
  // - Sets up a sandbox for a grain.
  // - Executes the grain in the sandbox.
  // - Implements the platform API for the grain.
  // - Exposes a network interface through which the rest of the platform can talk to the grain.
  //
  // The supervisor places itself into the same sandbox as the grain, except that the supervisor
  // gets network access whereas the grain does not (the grain can only communicate with the world
  // through the supervisor).
  //
  // This program is meant to be suid-root, so that it can use system calls like chroot() and
  // unshare().
  //
  // Alternatively, rather than suid, you may grant the binary "capabilities":
  //     setcap cap_setgid,cap_sys_chroot,cap_sys_admin,cap_mknod+ep BINARY
  // In theory this reduces the attack surface by giving the supervisor only the "capabilities" it
  // needs to do its job, although in practice it is pretty easy to carry out a privilege escalation
  // to full root starting from any of these "capabilities", so maybe it's not worth the effort.
  // (Note that Linux/POSIX "capabilities" are unrelated to the concept of capabilities usually
  // discussed in Sandstorm and Cap'n Proto.)

public:
  SupervisorMain(kj::ProcessContext& context): context(context) {
    // Make sure we didn't inherit a weird signal mask from the parent process.  Gotta do this as
    // early as possible so as not to confuse KJ code that deals with signals.
    sigset_t sigset;
    KJ_SYSCALL(sigemptyset(&sigset));
    KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigset, nullptr));
  }

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Runs a Sandstorm grain supervisor for the grain <grain-id>, which is "
                           "an instance of app <app-id>.  Executes <command> inside the grain "
                           "sandbox.")
        .addOptionWithArg({"pkg"}, KJ_BIND_METHOD(*this, setPkg), "<path>",
                          "Set directory containing the app package.  "
                          "Defaults to '/var/sandstorm/apps/<app-name>'.")
        .addOptionWithArg({"var"}, KJ_BIND_METHOD(*this, setVar), "<path>",
                          "Set directory where grain's mutable persistent data will be stored.  "
                          "Defaults to '/var/sandstorm/grains/<grain-id>'.")
        .addOptionWithArg({"uid"}, KJ_BIND_METHOD(*this, setUid), "<uid>",
                          "Set the user ID under which to run the sandbox.  When running as "
                          "root, you must specify this.  When running as non-root, you *cannot* "
                          "specify this; your own UID will be used.  <uid> may be a name or a "
                          "number.")
        .addOptionWithArg({"gid"}, KJ_BIND_METHOD(*this, setGid), "<gid>",
                          "Set the group ID under which to run the sandbox, and which will have "
                          "read/write access to the sandbox's storage.  When running as root, "
                          "you must specify this.  When running as non-root, you *cannot* specify "
                          "this; your own GID will be used.  <gid> may be a name or a number.")
        .addOptionWithArg({'e', "env"}, KJ_BIND_METHOD(*this, addEnv), "<name>=<val>",
                          "Set the environment variable <name> to <val> inside the sandbox.  Note "
                          "that *no* environment variables are set by default.")
        .addOption({"proc"}, [this]() { setMountProc(true); return true; },
                   "Mount procfs inside the sandbox.  For security reasons, this is NOT "
                   "RECOMMENDED during normal use, but it may be useful for debugging.")
        .addOption({"stdio"}, [this]() { keepStdio = true; return true; },
                   "Don't redirect the sandbox's stdio.  Useful for debugging.")
        .addOption({'n', "new"}, [this]() { setIsNew(true); return true; },
                   "Initializes a new grain.  (Otherwise, runs an existing one.)")
        .expectArg("<app-name>", KJ_BIND_METHOD(*this, setAppName))
        .expectArg("<grain-id>", KJ_BIND_METHOD(*this, setGrainId))
        .expectOneOrMoreArgs("<command>", KJ_BIND_METHOD(*this, addCommandArg))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

  // =====================================================================================
  // Flag handlers

  void setIsNew(bool isNew) {
    this->isNew = isNew;
  }

  void setMountProc(bool mountProc) {
    if (mountProc) {
      context.warning("WARNING: --proc is dangerous.  Only use it when debugging code you trust.");
    }
    this->mountProc = mountProc;
  }

  kj::MainBuilder::Validity setAppName(kj::StringPtr name) {
    if (name == nullptr || name.findFirst('/') != nullptr) {
      return "Invalid app name.";
    }
    appName = kj::heapString(name);
    return true;
  }

  kj::MainBuilder::Validity setGrainId(kj::StringPtr id) {
    if (id == nullptr || id.findFirst('/') != nullptr) {
      return "Invalid grain id.";
    }
    grainId = kj::heapString(id);
    return true;
  }

  kj::MainBuilder::Validity setPkg(kj::StringPtr path) {
    pkgPath = realPath(kj::heapString(path));
    return true;
  }

  kj::MainBuilder::Validity setVar(kj::StringPtr path) {
    varPath = realPath(kj::heapString(path));
    return true;
  }

  kj::MainBuilder::Validity setUid(kj::StringPtr arg) {
    // Careful to check real UID, not effective UID, so that this binary can be suid-root.
    // TODO(someday):  Devise some way that users can safely have their Sandstorm instances run
    //   under alternate UIDs for increased security.  Perhaps choose single-use UIDs somehow (i.e.
    //   use a UID that isn't in /etc/passwd, never will be, and never will be used for anything
    //   else).  This will require configuration on the part of the system administrator.  On the
    //   bright side, UIDs are 32-bit which should provide plenty of space.
    if (getuid() != 0) {
      return "Only root can specify a UID.";
    }

    char* end;
    uid = strtol(arg.cStr(), &end, 0);
    if (arg == nullptr || *end != '\0') {
      uid = 0;
      struct passwd* user = getpwnam(arg.cStr());
      if (user == nullptr) {
        return "Invalid UID.";
      }
      uid = user->pw_uid;
      gidFromUsername = user->pw_gid;
    }

    return true;
  }

  kj::MainBuilder::Validity setGid(kj::StringPtr arg) {
    // Careful to check real UID, not effective UID, so that this binary can be suid-root.
    // TODO(someday):  One-off group IDs?  The user should have some way to add themselves to the
    //   group so that they can access the grain's storage.
    if (getuid() != 0) {
      return "Only root can specify a GID.";
    }

    char* end;
    gid = strtol(arg.cStr(), &end, 0);
    if (arg == nullptr || *end != '\0') {
      gid = 0;
      struct group* group = getgrnam(arg.cStr());
      if (group == nullptr) {
        return "Invalid GID.";
      }
      gid = group->gr_gid;
    }

    return true;
  }

  kj::MainBuilder::Validity addEnv(kj::StringPtr arg) {
    environment.add(kj::heapString(arg));
    return true;
  }

  kj::MainBuilder::Validity addCommandArg(kj::StringPtr arg) {
    command.add(kj::heapString(arg));
    return true;
  }

  // =====================================================================================

  kj::MainBuilder::Validity run() {
    setupSupervisor();

    checkIfAlreadyRunning();  // Exits if another supervisor is still running in this sandbox.

    SANDSTORM_LOG("Starting up grain.");

    registerSignalHandlers();

    // Allocate the API socket.
    int fds[2];
    KJ_SYSCALL(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds));

    // Now time to run the start command, in a further chroot.
    KJ_SYSCALL(childPid = fork());
    if (childPid == 0) {
      // We're in the child.
      KJ_SYSCALL(close(fds[0]));  // just to be safe, even though it's CLOEXEC.
      runChild(fds[1]);
    } else {
      // We're in the supervisor.
      KJ_DEFER(killChild());
      KJ_SYSCALL(close(fds[1]));
      runSupervisor(fds[0]);
    }
  }

private:
  kj::ProcessContext& context;

  kj::String appName;
  kj::String grainId;
  kj::String pkgPath;
  kj::String varPath;
  kj::Vector<kj::String> command;
  kj::Vector<kj::String> environment;
  bool isNew = false;
  bool mountProc = false;
  bool keepStdio = false;
  uid_t uid = 0;
  gid_t gid = 0;
  gid_t gidFromUsername = 0;  // If --uid was given a username.

  void bind(kj::StringPtr src, kj::StringPtr dst, unsigned long flags = 0) {
    // Contrary to the documentation of MS_BIND claiming this is no longer the case after 2.6.26,
    // mountflags are ignored on the initial bind.  We have to issue a subsequent remount to set
    // them.
    KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr, MS_BIND, nullptr), src, dst);
    KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr,
                     MS_BIND | MS_REMOUNT | MS_NOSUID | MS_NOATIME | flags, nullptr),
        src, dst);
  }

  kj::String realPath(kj::StringPtr path) {
    char* cResult = realpath(path.cStr(), nullptr);
    if (cResult == nullptr) {
      int error = errno;
      if (error != ENOENT) {
        KJ_FAIL_SYSCALL("realpath", error, path);
      }

      // realpath() fails if the target doesn't exist, but our goal here is just to convert a
      // relative path to absolute whether it exists or not. So try resolving the parent instead.
      KJ_IF_MAYBE(slashPos, path.findLast('/')) {
        if (*slashPos == 0) {
          // Path is e.g. "/foo". The root directory obviously exists.
          return kj::heapString(path);
        } else {
          return kj::str(realPath(kj::heapString(path.slice(0, *slashPos))),
                         path.slice(*slashPos));
        }
      } else {
        // Path is a relative path with only one component.
        char* cwd = getcwd(nullptr, 0);
        KJ_DEFER(free(cwd));
        if (cwd[0] == '/' && cwd[1] == '\0') {
          return kj::str('/', path);
        } else {
          return kj::str(cwd, '/', path);
        }
      }
    }
    auto result = kj::heapString(cResult);
    free(cResult);
    return result;
  }

  // =====================================================================================

  void setupSupervisor() {
    // Enable no_new_privs so that once we drop privileges we can never regain them through e.g.
    // execing a suid-root binary.  Sandboxed apps should not need that.
    KJ_SYSCALL(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));

    validateCreds();
    closeFds();
    checkPaths();
    unshareOuter();
    setupTmpfs();
    bindDirs();
    setupStdio();

    // TODO(someday):  Turn on seccomp-bpf.

    // Note:  permanentlyDropSuperuser() is performed post-fork; see comment in function def.
  }

  void validateCreds() {
    if (gid == 0) {
      // --gid was not given.  If --uid specified a user name, use that user's default GID.
      gid = gidFromUsername;
    }
    uid_t realUid = getuid();
    if (realUid == 0) {
      if (uid == 0) {
        context.exitError("When running as root you must specify --uid.");
      }
      if (gid == 0 && gidFromUsername == 0) {
        context.exitError("When running as root you must specify --gid.");
      }
    } else {
      // User is not root, therefore they cannot specify uid/gid.
      uid = realUid;
      gid = getgid();
    }
  }

  void closeFds() {
    // Close all unexpected file descriptors (i.e. other than stdin/stdout/stderr).  This is a
    // safety measure incase we were launched by a badly-written parent program which forgot to
    // set CLOEXEC on its private file descriptors.  We don't want the sandboxed process to
    // accidentally get access to those.

    // We detect open file descriptors by reading from /proc.
    //
    // We need to defer closing each FD until after the scan completes, because:
    // 1) We probably shouldn't change the directory contents while listing.
    // 2) opendir() itself opens an FD.  Closing it would disrupt the scan.
    kj::Vector<int> fds;

    {
      DIR* dir = opendir("/proc/self/fd");
      if (dir == nullptr) {
        KJ_FAIL_SYSCALL("opendir(/proc/self/fd)", errno);
      }
      KJ_DEFER(KJ_SYSCALL(closedir(dir)) { break; });

      for (;;) {
        struct dirent entry;
        struct dirent* eptr = nullptr;
        int error = readdir_r(dir, &entry, &eptr);
        if (error != 0) {
          KJ_FAIL_SYSCALL("readdir_r(/proc/self/fd)", error);
        }
        if (eptr == nullptr) {
          // End of directory.
          break;
        }

        if (eptr->d_name[0] != '.') {
          char* end;
          int fd = strtoul(eptr->d_name, &end, 10);
          KJ_ASSERT(*end == '\0' && end > eptr->d_name,
                    "File in /proc/self/fd had non-numeric name?", eptr->d_name);
          if (fd > STDERR_FILENO) {
            fds.add(fd);
          }
        }
      }
    }

    for (int fd: fds) {
      // Ignore close errors -- we don't care, as long as the file is closed.  (Also, one close()
      // will always return EBADF because it's the directory FD closed in closedir().)
      close(fd);
    }
  }

  void checkPaths() {
    // Create or verify the pkg, var, and tmp directories.

    // Temporarily drop credentials for filesystem access.
    uid_t olduid = geteuid();
    gid_t oldgid = getegid();
    KJ_SYSCALL(setegid(gid));
    KJ_SYSCALL(seteuid(uid));

    // Let us be explicit about permissions for now.
    umask(0);

    // Set default paths if flags weren't provided.
    if (pkgPath == nullptr) pkgPath = kj::str("/var/sandstorm/apps/", appName);
    if (varPath == nullptr) varPath = kj::str("/var/sandstorm/grains/", grainId);

    // Check that package exists.
    KJ_SYSCALL(access(pkgPath.cStr(), R_OK | X_OK), pkgPath);

    // Create / verify existence of the var directory.  Do this as the target user.
    if (isNew) {
      if (mkdir(varPath.cStr(), 0770) != 0) {
        int error = errno;
        if (errno == EEXIST) {
          context.exitError(kj::str("Grain already exists: ", grainId));
        } else {
          KJ_FAIL_SYSCALL("mkdir(varPath.cStr(), 0770)", error, varPath);
        }
      }
      KJ_SYSCALL(mkdir(kj::str(varPath, "/sandbox").cStr(), 0770), varPath);
    } else {
      if (access(varPath.cStr(), R_OK | W_OK | X_OK) != 0) {
        int error = errno;
        if (error == ENOENT) {
          context.exitError(kj::str("No such grain: ", grainId));
        } else {
          KJ_FAIL_SYSCALL("access(varPath.cStr(), R_OK | W_OK | X_OK)", error, varPath);
        }
      }
    }

    // Create the temp directory if it doesn't exist.  We only need one tmpdir because we're just
    // going to bind it to a private mount anyway.
    if (mkdir("/tmp/sandstorm-grain", 0770) < 0) {
      int error = errno;
      if (error != EEXIST) {
        KJ_FAIL_SYSCALL("mkdir(\"/tmp/sandstorm-grain\")", error);
      }
    }

    // Create the log file while we're still non-superuser.
    int logfd;
    KJ_SYSCALL(logfd = open(kj::str(varPath, "/log").cStr(),
        O_WRONLY | O_APPEND | O_CLOEXEC | O_CREAT, 0600));
    KJ_SYSCALL(close(logfd));

    // Restore superuser access (e.g. so that we can do mknod later).
    KJ_SYSCALL(seteuid(olduid));
    KJ_SYSCALL(setegid(oldgid));
  }

  void unshareOuter() {
    // Unshare the mount namespace so that we can create a bunch of bindings.
    // Go ahead and unshare IPC, UTS, and PID now so we don't have to later.  Note that unsharing
    // the pid namespace is a little odd in that it doesn't actually affect this process, but
    // affects later children created by it.
    KJ_SYSCALL(unshare(CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWPID));

    // To really unshare the mount namespace, we also have to make sure all mounts are private.
    // The parameters here were derived by strace'ing `mount --make-rprivate /`.  AFAICT the flags
    // are undocumented.  :(
    //
    // Note:  We accept EINVAL as an indication that / is not a mount point, which indicates we're
    //   running in a chroot, which means we're probably running in the Sandstorm bundle, which has
    //   already private-mounted everything.
    // TODO(someday):  More robustly detect when we're in the sandstorm bundle.
    if (mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr) < 0) {
      int error = errno;
      if (error != EINVAL) {
        KJ_FAIL_SYSCALL("mount(recursively remount / as private)", error);
      }
    }

    // Set a dummy host / domain so the grain can't see the real one.  (unshare(CLONE_NEWUTS) means
    // these settings only affect this process and its children.)
    KJ_SYSCALL(sethostname("sandbox", 7));
    KJ_SYSCALL(setdomainname("sandbox", 7));
  }

  void setupTmpfs() {
    // Create a new tmpfs for this run.  We don't use a shared one or just /tmp for two reasons:
    // 1) tmpfs has no quota control, so a shared instance could be DoS'd by any one grain, or
    //    just used to effectively allocate more RAM than the grain is allowed.
    // 2) When we exit, the mount namespace disappears and the tmpfs is thus automatically
    //    unmounted.  No need for careful cleanup, and no need to implement a risky recursive
    //    delete.
    KJ_SYSCALL(mount("tmpfs", "/tmp/sandstorm-grain", "tmpfs", MS_NOATIME | MS_NOSUID | MS_NOEXEC,
                     kj::str("size=16m,nr_inodes=4k,mode=770,uid=", uid, ",gid=", gid).cStr()));

    // Change to that directory.
    KJ_SYSCALL(chdir("/tmp/sandstorm-grain"));

    // Set up the directory tree.

    // Create a minimal dev directory.
    KJ_SYSCALL(mkdir("dev", 0755));
    KJ_SYSCALL(mknod("dev/null", S_IFCHR | 0666, makedev(1, 3)));
    KJ_SYSCALL(mknod("dev/zero", S_IFCHR | 0666, makedev(1, 5)));
    KJ_SYSCALL(mknod("dev/random", S_IFCHR | 0666, makedev(1, 8)));
    KJ_SYSCALL(mknod("dev/urandom", S_IFCHR | 0666, makedev(1, 9)));

    // Mount point for var directory, as seen by the supervisor.
    KJ_SYSCALL(mkdir("var", 0777));

    // Temp directory.
    KJ_SYSCALL(mkdir("tmp", 0777));
    KJ_SYSCALL(mkdir("tmp/sandbox", 0777));  // Piece of tmp visible to sandbox.

    // The root directory of the sandbox.
    KJ_SYSCALL(mkdir("sandbox", 0777));
  }

  void bindDirs() {
    // Bind the app package to "sandbox", which will be the grain's root directory.
    bind(pkgPath, "sandbox", MS_NODEV | MS_RDONLY);

    // We want to chroot the supervisor.  It will need access to the var directory, so we need to
    // bind-mount that into the local tree.  We can't just map it to sandbox/var because part of
    // the var directory is supposed to be visible only to the supervisor.
    bind(varPath, "var", MS_NODEV | MS_NOEXEC);

    // Optionally bind var, tmp, dev if the app requests it by having the corresponding directories
    // in the package.
    if (access("sandbox/tmp", F_OK) == 0) {
      bind("tmp/sandbox", "sandbox/tmp", MS_NODEV | MS_NOEXEC);
    }
    if (access("sandbox/dev", F_OK) == 0) {
      bind("dev", "sandbox/dev", MS_NOEXEC | MS_RDONLY);
    }
    if (access("sandbox/var", F_OK) == 0) {
      bind(kj::str(varPath, "/sandbox"), "sandbox/var", MS_NODEV | MS_NOEXEC);
    }

    // OK, everything is bound, so we can chroot.
    KJ_SYSCALL(chroot("."));
    KJ_SYSCALL(chdir("/"));
  }

  void setupStdio() {
    // Make sure stdin is /dev/null and set stderr to go to a log file.

    if (!keepStdio) {
      // We want to replace stdin with /dev/null because even if there is no input on stdin, it
      // could inadvertently be an FD with other powers.  For example, it might be a TTY, in which
      // case you could write to it or otherwise mess with the terminal.
      int devNull;
      KJ_SYSCALL(devNull = open("/dev/null", O_RDONLY | O_CLOEXEC));
      KJ_SYSCALL(dup2(devNull, STDIN_FILENO));
      KJ_SYSCALL(close(devNull));

      // We direct stderr to a log file for debugging purposes.
      // TODO(soon):  Rotate logs.
      int log;
      KJ_SYSCALL(log = open("/var/log", O_WRONLY | O_APPEND | O_CLOEXEC));
      KJ_SYSCALL(dup2(log, STDERR_FILENO));
      KJ_SYSCALL(close(log));
    }

    // We will later make stdout a copy of stderr specifically for the sandboxed process.  In the
    // supervisor, stdout is how we tell our parent that we're ready to receive connections.
  }

  void unshareNetwork() {
    // Unshare the network and set up a new loopback device.

    // Enter new network namespace.
    KJ_SYSCALL(unshare(CLONE_NEWNET));

    // Create a socket for our ioctls.
    int fd;
    KJ_SYSCALL(fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP));
    KJ_DEFER(close(fd));

    // Set the address of "lo".
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strcpy(ifr.ifr_ifrn.ifrn_name, "lo");
    struct sockaddr_in* addr = reinterpret_cast<struct sockaddr_in*>(&ifr.ifr_ifru.ifru_addr);
    addr->sin_family = AF_INET;
    addr->sin_addr.s_addr = htonl(0x7F000001);  // 127.0.0.1
    KJ_SYSCALL(ioctl(fd, SIOCSIFADDR, &ifr));

    // Set flags to enable "lo".
    memset(&ifr.ifr_ifru, 0, sizeof(ifr.ifr_ifru));
    ifr.ifr_ifru.ifru_flags = IFF_LOOPBACK | IFF_UP | IFF_RUNNING;
    KJ_SYSCALL(ioctl(fd, SIOCSIFFLAGS, &ifr));
  }

  void maybeMountProc() {
    // Mount proc if it was requested.  Note that this must take place after fork() to get the
    // correct pid namespace.

    if (mountProc && access("proc", F_OK) == 0) {
      KJ_SYSCALL(mount("proc", "proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, ""));
    }
  }

  void permanentlyDropSuperuser() {
    // Drop all credentials.
    //
    // This unfortunately must be performed post-fork (in both parent and child), because the child
    // needs to do one final chroot().  Perhaps if chroot() is ever enabled by no_new_privs, we can
    // get around that.

    KJ_SYSCALL(setresgid(gid, gid, gid));
    KJ_SYSCALL(setgroups(0, nullptr));
    KJ_SYSCALL(setresuid(uid, uid, uid));

    // Also empty the "capability" set, so that one could use file "capabilities" instead of suid
    // on the sandstorm supervisor binary, perhaps getting added security.  (These are Linux/POSIX
    // "capabilities", which are not true object-capabilities, hence the quotes.)
    struct __user_cap_header_struct hdr;
    struct __user_cap_data_struct data[2];
    hdr.version = _LINUX_CAPABILITY_VERSION_3;
    hdr.pid = 0;
    memset(data, 0, sizeof(data));  // All capabilities disabled!
    KJ_SYSCALL(capset(&hdr, data));

    // Sandstorm data is private.  Don't let other users see it.  But, do grant full access to the
    // group.  The idea here is that you might have a dedicated sandstorm-sandbox user account but
    // define a special "sandstorm-admin" group which includes that account as well as a real user
    // who should have direct access to the data.
    umask(0007);
  }

  void enterSandbox() {
    // Fully enter the sandbox.  Called only by the child process.

    // Chroot the rest of the way into the sandbox.
    KJ_SYSCALL(chroot("sandbox"));
    KJ_SYSCALL(chdir("/"));

    // Unshare the network, creating a new loopback interface.
    unshareNetwork();

    // Mount proc if --proc was passed.
    maybeMountProc();

    // Now actually drop all credentials.
    permanentlyDropSuperuser();
  }

  // =====================================================================================

  void checkIfAlreadyRunning() {
    // Attempt to connect to any existing supervisor and call keepAlive().  If successful, we
    // don't want to start a new instance; we should use the existing instance.

    // TODO(soon):  There's a race condition if two supervisors are started up in rapid succession.
    //   We could maybe avoid that with some filesystem locking.  It's currently unlikely to happen
    //   in practice because it would require sending a request to the shell server to open the
    //   grain, then restarting the shell server, then opening the grain again, all before the
    //   first supervisor finished starting.  Or, I suppose, running two shell servers and trying
    //   to open the same grain in both at once.

    auto ioContext = kj::setupAsyncIo();

    // Connect to the client.
    auto addr = ioContext.provider->getNetwork().parseAddress("unix:/var/socket")
        .wait(ioContext.waitScope);
    kj::Own<kj::AsyncIoStream> connection;
    KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
      connection = addr->connect().wait(ioContext.waitScope);
    })) {
      // Failed to connect.  Assume socket is stale.
      return;
    }

    // Set up RPC.
    capnp::TwoPartyVatNetwork vatNetwork(*connection, capnp::rpc::twoparty::Side::CLIENT);
    auto client = capnp::makeRpcClient(vatNetwork);

    // Restore the default capability (the Supervisor interface).
    capnp::MallocMessageBuilder message;
    capnp::rpc::SturdyRef::Builder ref = message.getRoot<capnp::rpc::SturdyRef>();
    auto hostId = ref.getHostId().initAs<capnp::rpc::twoparty::SturdyRefHostId>();
    hostId.setSide(capnp::rpc::twoparty::Side::SERVER);
    Supervisor::Client cap = client.restore(hostId, ref.getObjectId()).castAs<Supervisor>();

    // Call keepAlive().
    auto promise = cap.keepAliveRequest().send();
    KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
      promise.wait(ioContext.waitScope);
    })) {
      // Failed to keep-alive.  Supervisor must have died just as we were connecting to it.  Go
      // ahead and start a new one.
      return;
    }

    // We successfully connected and keepalived the existing supervisor, so we can exit.  The
    // caller is expecting us to write to stdout when the stocket is ready, so do that anyway.
    KJ_SYSCALL(write(STDOUT_FILENO, "Already running...\n", strlen("Already running...\n")));
    _exit(0);
    KJ_UNREACHABLE;
  }

  // =====================================================================================

  void runChild(int apiFd) KJ_NORETURN {
    // We are the child.

    enterSandbox();

    // Reset all signal handlers to default.  (exec() will leave ignored signals ignored, and KJ
    // code likes to ignore e.g. SIGPIPE.)
    // TODO(cleanup):  Is there a better way to do this?
    for (uint i = 0; i < NSIG; i++) {
      signal(i, SIG_DFL);  // Only possible error is EINVAL (invalid signum); we don't care.
    }

    // Unblock all signals.  (Yes, the signal mask is inherited over exec...)
    sigset_t sigmask;
    sigemptyset(&sigmask);
    KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigmask, nullptr));

    // Make sure the API socket is on FD 3.
    if (apiFd == 3) {
      // Socket end already has correct fd.  Unset CLOEXEC.
      KJ_SYSCALL(fcntl(apiFd, F_SETFD, 0));
    } else {
      // dup socket to correct fd.
      KJ_SYSCALL(dup2(apiFd, 3));
      KJ_SYSCALL(close(apiFd));
    }

    // Redirect stdout to stderr, so that our own stdout serves one purpose:  to notify the parent
    // process when we're ready to accept connections.  We previously directed stderr to a log file.
    KJ_SYSCALL(dup2(STDERR_FILENO, STDOUT_FILENO));

    char* argv[command.size() + 1];
    for (uint i: kj::indices(command)) {
      argv[i] = const_cast<char*>(command[i].cStr());
    }
    argv[command.size()] = nullptr;

    char* env[environment.size() + 1];
    for (uint i: kj::indices(environment)) {
      env[i] = const_cast<char*>(environment[i].cStr());
    }
    env[environment.size()] = nullptr;

    char** argvp = argv;  // work-around Clang not liking lambda + vararray
    char** envp = env;    // same

    KJ_SYSCALL(execve(argvp[0], argvp, envp), argvp[0]);
    KJ_UNREACHABLE;
  }

  class SandstormApiImpl final: public SandstormApi::Server {
  public:
    // TODO(someday):  Implement API.
//    kj::Promise<void> publish(PublishContext context) override {

//    }

//    kj::Promise<void> registerAction(RegisterActionContext context) override {

//    }

//    kj::Promise<void> shareCap(ShareCapContext context) override {

//    }

//    kj::Promise<void> shareView(ShareViewContext context) override {

//    }
  };

  class SupervisorImpl final: public Supervisor::Server {
  public:
    inline SupervisorImpl(UiView::Client&& mainView): mainView(kj::mv(mainView)) {}

    kj::Promise<void> getMainView(GetMainViewContext context) {
      context.getResults(capnp::MessageSize {4, 1}).setView(mainView);
      return kj::READY_NOW;
    }

    kj::Promise<void> keepAlive(KeepAliveContext context) {
      sandstorm::keepAlive = true;
      return kj::READY_NOW;
    }

    kj::Promise<void> shutdown(ShutdownContext context) {
      killChildAndExit(0);
    }

  private:
    UiView::Client mainView;
  };

  class Restorer: public capnp::SturdyRefRestorer<capnp::AnyPointer> {
  public:
    explicit Restorer(capnp::Capability::Client&& defaultCap)
        : defaultCap(kj::mv(defaultCap)) {}

    capnp::Capability::Client restore(capnp::AnyPointer::Reader ref) override {
      // TODO(soon):  Make it possible to export a default capability on two-party connections.
      //   For now we use a null ref as a hack, but this is questionable because if guessable
      //   SturdyRefs exist then you can't let just any component of your system request arbitrary
      //   SturdyRefs.
      if (ref.isNull()) {
        return defaultCap;
      }

      // TODO(someday):  Implement level 2 RPC with distributed confinement.
      KJ_FAIL_ASSERT("SturdyRefs not implemented.");
    }

  private:
    capnp::Capability::Client defaultCap;
  };

  struct AcceptedConnection {
    kj::Own<kj::AsyncIoStream> connection;
    capnp::TwoPartyVatNetwork network;
    capnp::RpcSystem<capnp::rpc::twoparty::SturdyRefHostId> rpcSystem;

    explicit AcceptedConnection(Restorer& restorer, kj::Own<kj::AsyncIoStream>&& connectionParam)
        : connection(kj::mv(connectionParam)),
          network(*connection, capnp::rpc::twoparty::Side::SERVER),
          rpcSystem(capnp::makeRpcServer(network, restorer)) {}
  };

  kj::Promise<void> acceptLoop(kj::ConnectionReceiver& serverPort, Restorer& restorer,
                               kj::TaskSet& taskSet) {
    return serverPort.accept().then([&](kj::Own<kj::AsyncIoStream>&& connection) {
      auto connectionState = kj::heap<AcceptedConnection>(restorer, kj::mv(connection));
      auto promise = connectionState->network.onDisconnect();
      taskSet.add(promise.attach(kj::mv(connectionState)));
      return acceptLoop(serverPort, restorer, taskSet);
    });
  }

  class ErrorHandlerImpl: public kj::TaskSet::ErrorHandler {
  public:
    void taskFailed(kj::Exception&& exception) override {
      KJ_LOG(ERROR, "connection failed", exception);
    }
  };

  void runSupervisor(int apiFd) KJ_NORETURN {
    permanentlyDropSuperuser();

    // TODO(soon):  Make sure all grandchildren die if supervisor dies.

    // Set up the RPC connection to the app and export the supervisor interface.
    auto ioContext = kj::setupAsyncIo();
    auto appConnection = ioContext.lowLevelProvider->wrapSocketFd(apiFd,
        kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC |
        kj::LowLevelAsyncIoProvider::TAKE_OWNERSHIP);
    capnp::TwoPartyVatNetwork appNetwork(*appConnection, capnp::rpc::twoparty::Side::SERVER);
    Restorer appRestorer(kj::heap<SandstormApiImpl>());
    auto server = capnp::makeRpcServer(appNetwork, appRestorer);

    // Get the app's UiView by restoring a null SturdyRef from it.
    capnp::MallocMessageBuilder message;
    capnp::rpc::SturdyRef::Builder ref = message.getRoot<capnp::rpc::SturdyRef>();
    auto hostId = ref.getHostId().initAs<capnp::rpc::twoparty::SturdyRefHostId>();
    hostId.setSide(capnp::rpc::twoparty::Side::CLIENT);
    UiView::Client app = server.restore(hostId, ref.getObjectId()).castAs<UiView>();

    // Set up the external RPC interface, re-exporting the UiView.
    // TODO(someday):  If there are multiple front-ends, or the front-ends restart a lot, we'll
    //   want to wrap the UiView and cache session objects.  Perhaps we could do this by making
    //   them persistable, though it's unclear how that would work with SessionContext.
    Restorer serverRestorer(kj::heap<SupervisorImpl>(kj::mv(app)));
    ErrorHandlerImpl errorHandler;
    kj::TaskSet tasks(errorHandler);
    unlink("/var/socket");  // Clear stale socket, if any.
    auto acceptTask = ioContext.provider->getNetwork().parseAddress("unix:/var/socket", 0).then(
        [&](kj::Own<kj::NetworkAddress>&& addr) {
      auto serverPort = addr->listen();
      KJ_SYSCALL(write(STDOUT_FILENO, "Listening...\n", strlen("Listening...\n")));
      auto promise = acceptLoop(*serverPort, serverRestorer, tasks);
      return promise.attach(kj::mv(serverPort));
    });

    // Wait for disconnect or accept loop failure, then exit.
    acceptTask.exclusiveJoin(appNetwork.onDisconnect()).wait(ioContext.waitScope);

    SANDSTORM_LOG("App disconnected API socket; shutting down grain.");
    killChildAndExit(1);
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::SupervisorMain)
