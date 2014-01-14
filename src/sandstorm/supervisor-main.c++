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
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <limits.h>
#include <sched.h>

namespace sandstorm {

class SupervisorMain {
public:
  SupervisorMain(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version 0.0",
        "Runs a Sandstorm grain supervisor for the grain <grain-id>, which is an instance "
        "of app <app-id>.  Executes <command> inside the grain sandbox.\n")
        .addOptionWithArg({"pkg"}, KJ_BIND_METHOD(*this, setPkg), "<path>",
                          "Set directory containing the app package.  "
                          "Defaults to '/var/sandstorm/apps/<app-name>'.")
        .addOptionWithArg({"var"}, KJ_BIND_METHOD(*this, setVar), "<path>",
                          "Set directory where grain's mutable persistent data will be stored.  "
                          "Defaults to '/var/sandstorm/grains/<grain-id>'.")
        .addOptionWithArg({"tmp"}, KJ_BIND_METHOD(*this, setTmp), "<path>",
                          "Set directory to use for temporary files.  "
                          "Defaults to '/tmp/sandstorm/grains/<grain-id>'.")
        .addOption({'n', "new"}, [this]() { setIsNew(true); return true; },
                   "Initializes a new grain.  (Otherwise, runs an existing one.)")
        .expectArg("<app-name>", KJ_BIND_METHOD(*this, setAppName))
        .expectArg("<grain-id>", KJ_BIND_METHOD(*this, setGrainId))
        .expectOneOrMoreArgs("<command>...", KJ_BIND_METHOD(*this, addCommandArg))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
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

  kj::MainBuilder::Validity addCommandArg(kj::StringPtr arg) {
    command.add(kj::heapString(arg));
    return true;
  }

  void setIsNew(bool isNew) {
    this->isNew = isNew;
  }

  kj::MainBuilder::Validity setPkg(kj::StringPtr path) {
    pkgPath = realPath(kj::heapString(path));
    return true;
  }

  kj::MainBuilder::Validity setVar(kj::StringPtr path) {
    varPath = realPath(kj::heapString(path));
    return true;
  }

  kj::MainBuilder::Validity setTmp(kj::StringPtr path) {
    tmpPath = realPath(kj::heapString(path));
    return true;
  }

  kj::MainBuilder::Validity run() {
    if (pkgPath == nullptr) pkgPath = kj::str("/var/sandstorm/apps/", appName);
    if (varPath == nullptr) varPath = kj::str("/var/sandstorm/grains/", grainId);
    if (tmpPath == nullptr) tmpPath = kj::str("/tmp/sandstorm/grains/", grainId);

    // Package must exist.
    KJ_SYSCALL(access(pkgPath.cStr(), R_OK | W_OK), pkgPath);

    // TODO(security):  Close all unexpected open FDs by checking /proc.

    // TODO(soon):  Set UID, GID (to owning user), empty supplementary groups, set no_new_privs
    // TODO(someday):  Seccomp-bpf.  Do it here if we can get away with the same filter set for
    //   supervisor and sandbox, otherwise do it post-fork.

    if (isNew) {
      KJ_SYSCALL(mkdir(varPath.cStr(), 0770), varPath);
      KJ_SYSCALL(mkdir(kj::str(varPath, "/sandbox").cStr(), 0770), varPath);
    } else {
      KJ_SYSCALL(access(varPath.cStr(), R_OK | W_OK), varPath);
    }

    // Create the temp directory if it doesn't exist.
    if (mkdir(tmpPath.cStr(), 0770) < 0) {
      int error = errno;
      if (error != EEXIST) {
        KJ_FAIL_SYSCALL("mkdir(tmpPath)", error, tmpPath);
      }

      // It appears the tmp dir already exists.
      // TODO(soon):  Check a pidfile and automatically clean up if necessary.
      return "Temp dir already exists.  Stale?";
    }

    // We will live in the tmp directory.
    KJ_SYSCALL(chdir(tmpPath.cStr()), tmpPath);

    // Set up the directory tree.

    // Create a minimal dev directory.
    KJ_SYSCALL(mkdir("dev", 0770));
    KJ_SYSCALL(mknod("dev/null", S_IFCHR | 0660, makedev(1, 3)));
    KJ_SYSCALL(mknod("dev/zero", S_IFCHR | 0660, makedev(1, 5)));
    KJ_SYSCALL(mknod("dev/random", S_IFCHR | 0660, makedev(1, 8)));
    KJ_SYSCALL(mknod("dev/urandom", S_IFCHR | 0660, makedev(1, 9)));

    // Create other dirs.
    KJ_SYSCALL(mkdir("var", 0770));
    KJ_SYSCALL(mkdir("tmp", 0770));  // (to be bound to sandbox/tmp)

    // The root directory of the sandbox.
    KJ_SYSCALL(mkdir("sandbox", 0770));

    // Unshare the mount namespace so that we can create a bunch of bindings.
    // Go ahead and unshare IPC and UTS now so we don't have to later.
    KJ_SYSCALL(unshare(CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS));
    // TODO(soon):  Clear the UTS names to hide from sandbox.

    // Bind "var" so that we can chroot the supervisor itself and still have access to priveleged
    // metadata.
    bind(varPath, "var", MS_NODEV | MS_NOEXEC);

    // Bind the package contents to "sandbox".
    bind(pkgPath, "sandbox", MS_NODEV | MS_RDONLY);

    // Optionally bind var, tmp, dev if the app requests it by having the corresponding directories
    // in the package.
    // TODO(someday):  proc?
    if (access("sandbox/tmp", F_OK) == 0) {
      // TODO(security):  Give sandbox its own segregated tmpfs so it can't DoS everyone (ugh).
      bind("tmp", "sandbox/tmp", MS_NODEV | MS_NOEXEC);
    }
    if (access("sandbox/dev", F_OK) == 0) {
      bind("dev", "sandbox/dev", MS_NOEXEC | MS_RDONLY);
    }
    if (access("sandbox/var", F_OK) == 0) {
      if (isNew) {
        // TODO(soon):  Copy content of sandbox/var to varPath.
      }

      bind(kj::str(varPath, "/sandbox"), "sandbox/var", MS_NODEV | MS_NOEXEC);
    }

    // OK, everything is bound, so we can chroot.
    KJ_SYSCALL(chroot("."));

    // Allocate the API socket.
    int fds[2];
    KJ_SYSCALL(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds));

    // Now time to run the start command, in a further chroot.
    pid_t child;
    KJ_SYSCALL(child = fork());
    if (child == 0) {
      // We are the child.

      // Chroot the rest of the way into the sandbox.
      KJ_SYSCALL(chdir("sandbox"));
      KJ_SYSCALL(chroot("."));

      // Unshare remaining namespaces that supervisor couldn't.
      // TODO(someday):  Use raw clone() rather than fork() in order to unshare PIDs?
      KJ_SYSCALL(unshare(CLONE_NEWNET));

      // TODO(soon):  setuid/setgid

      // Close supervisor end of pipe (to be safe).
      KJ_SYSCALL(close(fds[0]));

      if (fds[1] == 3) {
        // Socket end already has correct fd.  Unset CLOEXEC.
        KJ_SYSCALL(fcntl(fds[1], F_SETFD, 0));
      } else {
        // dup socket to correct fd.
        KJ_SYSCALL(dup2(fds[1], 3));
      }

      char* argv[command.size() + 1];
      for (uint i: kj::indices(command)) {
        argv[i] = const_cast<char*>(command[i].cStr());
      }
      argv[command.size()] = nullptr;

      char* env = nullptr;  // TODO(soon): implement environment

      KJ_SYSCALL(execve(argv[0], argv, &env), argv[0]);
      KJ_UNREACHABLE;
    }

    // We're in the supervisor.

    // Close sandbox end of pipe.
    KJ_SYSCALL(close(fds[1]));

    // TODO(soon):  Supervisor stuff.
    // For now, just wait for pid to exit.
    int status;
    KJ_SYSCALL(waitpid(child, &status, 0));

    return true;
  }

public:
  kj::ProcessContext& context;

  kj::String appName;
  kj::String grainId;
  kj::String pkgPath;
  kj::String varPath;
  kj::String tmpPath;
  kj::Vector<kj::String> command;
  bool isNew = false;

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
    auto result = kj::heapString(cResult);
    free(cResult);
    return result;
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::SupervisorMain)
