// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// Redistribution and use in source and binary forms, with or without
// modification, are permitted provided that the following conditions are met:
//
// 1. Redistributions of source code must retain the above copyright notice, this
//    list of conditions and the following disclaimer.
// 2. Redistributions in binary form must reproduce the above copyright notice,
//    this list of conditions and the following disclaimer in the documentation
//    and/or other materials provided with the distribution.
//
// THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
// ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
// WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
// DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
// ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
// (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
// LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
// ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
// (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
// SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

#include <kj/main.h>
#include <kj/debug.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/mount.h>
#include <sys/fsuid.h>
#include <sys/prctl.h>
#include <sys/capability.h>
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <limits.h>
#include <sched.h>
#include <dirent.h>
#include <pwd.h>
#include <grp.h>

namespace sandstorm {

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
  SupervisorMain(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version 0.0",
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

    // Allocate the API socket.
    int fds[2];
    KJ_SYSCALL(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds));

    // Now time to run the start command, in a further chroot.
    pid_t child;
    KJ_SYSCALL(child = fork());
    if (child == 0) {
      // We're in the child.
      KJ_SYSCALL(close(fds[0]));  // just to be safe, even though it's CLOEXEC.
      runChild(fds[1]);
    } else {
      // We're in the supervisor.
      KJ_SYSCALL(close(fds[1]));
      runSupervisor(child, fds[0]);
    }
  }

public:
  kj::ProcessContext& context;

  kj::String appName;
  kj::String grainId;
  kj::String pkgPath;
  kj::String varPath;
  kj::Vector<kj::String> command;
  kj::Vector<kj::String> environment;
  bool isNew = false;
  bool mountProc = false;
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
      KJ_FAIL_SYSCALL("realpath", errno, path);
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
    KJ_SYSCALL(setfsuid(uid));
    KJ_SYSCALL(setfsgid(gid));

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

    // Restore superuser access (e.g. so that we can do mknod later).
    KJ_SYSCALL(setfsuid(geteuid()));
    KJ_SYSCALL(setfsgid(getegid()));
  }

  void unshareOuter() {
    // Unshare the mount namespace so that we can create a bunch of bindings.
    // Go ahead and unshare IPC, UTS, and PID now so we don't have to later.  Note that unsharing
    // the pid namespace is a little odd in that it doesn't actually affect this process, but
    // affects later children created by it.
    KJ_SYSCALL(unshare(CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWPID));

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
    KJ_SYSCALL(mkdir("dev", 0777));
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

    // Unshare remaining namespaces that supervisor couldn't.
    KJ_SYSCALL(unshare(CLONE_NEWNET));

    // Mount proc if --proc was passed.
    maybeMountProc();

    // Now actually drop all credentials.
    permanentlyDropSuperuser();
  }

  // =====================================================================================

  void runChild(int apiFd) KJ_NORETURN {
    // We are the child.

    enterSandbox();

    if (apiFd == 3) {
      // Socket end already has correct fd.  Unset CLOEXEC.
      KJ_SYSCALL(fcntl(apiFd, F_SETFD, 0));
    } else {
      // dup socket to correct fd.
      KJ_SYSCALL(dup2(apiFd, 3));
    }

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

  void runSupervisor(pid_t child, int apiFd) KJ_NORETURN {
    permanentlyDropSuperuser();

    // TODO(soon):  Export platform API, etc.
    // For now, just wait for pid to exit.
    int status;
    KJ_SYSCALL(waitpid(child, &status, 0));

    context.exit();
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::SupervisorMain)
