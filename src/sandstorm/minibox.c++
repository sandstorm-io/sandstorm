// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// Hack around stdlib bug with C++14.
#include <initializer_list>  // force libstdc++ to include its config
#undef _GLIBCXX_HAVE_GETS    // correct broken config
// End hack.

#include <kj/main.h>
#include <kj/io.h>
#include <kj/debug.h>
#include <sched.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <sys/prctl.h>
#include <sys/capability.h>
#include <sys/wait.h>
#include <signal.h>
#include <stdlib.h>
#include <stdio.h>
#include <mntent.h>
#include <errno.h>

#include "version.h"

// In case kernel headers are old.
#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

namespace sandstorm {

kj::AutoCloseFd raiiOpen(kj::StringPtr name, int flags, mode_t mode = 0666) {
  int fd;
  KJ_SYSCALL(fd = open(name.cStr(), flags, mode), name);
  return kj::AutoCloseFd(fd);
}

kj::Maybe<kj::String> readLine(kj::BufferedInputStream& input) {
  kj::Vector<char> result(80);

  for (;;) {
    auto buffer = input.tryGetReadBuffer();
    if (buffer.size() == 0) {
      KJ_REQUIRE(result.size() == 0, "Got partial line.");
      return nullptr;
    }
    for (size_t i: kj::indices(buffer)) {
      if (buffer[i] == '\n') {
        input.skip(i+1);
        result.add('\0');
        return kj::String(result.releaseAsArray());
      } else {
        result.add(buffer[i]);
      }
    }
    input.skip(buffer.size());
  }
}

class MiniboxMain {
  // Main class for a mini sandbox we use to wrap command-line tools (especially zip/unzip) which
  // we don't totally trust. This box makes the entire filesystem read-only except for some
  // explicit paths specified on the command-line which will be bind-mounted read-write to specific
  // locations. Normal file permissions still apply.

public:
  MiniboxMain(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Runs a mini-sandbox meant to offer a layer of protection around "
                           "command-line tools that are generally trusted but are being fed "
                           "untrusted user data. You can also set up arbitrary file and "
                           "directory mappings inside the box. This is not the main Sandstorm "
                           "sandbox, but is used e.g. when running zip/unzip on user-provided "
                           "data.")
        .addOptionWithArg({'r', "map-readonly"}, KJ_BIND_METHOD(*this, addReadOnlyMapping), "<vpath>=<path>",
                          "The real directory located at <path> will be mapped into the sandbox "
                          "at <vpath> and will be read-only.")
        .addOptionWithArg({'w', "map-writable"}, KJ_BIND_METHOD(*this, addWritableMapping), "<vpath>=<path>",
                          "The real directory located at <path> will be mapped into the sandbox "
                          "at <vpath> and will be writable.")
        .addOptionWithArg({'t', "map-tempfs"}, KJ_BIND_METHOD(*this, addTempfsMapping), "<vpath>",
                          "Mount a writable tempfs at <vpath>. If subsequent mappings have vpaths "
                          "inside this tempfs, those directories will be created automatically.")
        .addOptionWithArg({'p', "map-procfs"}, KJ_BIND_METHOD(*this, addProcfsMapping), "<vpath>",
                          "Mount procfs at <vpath> (usually '/proc').")
        .addOptionWithArg({'h', "hide"}, KJ_BIND_METHOD(*this, addHideMapping), "<vpath>",
                          "Make the given vpath appear empty by overmounting it with a read-only "
                          "tempfs.")
        .addOptionWithArg({'d', "set-cwd"}, KJ_BIND_METHOD(*this, setWorkingDir), "<vpath>",
                          "After mounting all paths, set the working directory to <vpath> before "
                          "invoking the command. Default is to run at the root of the new "
                          "filesystem.")
        .addOption({'n', "network"}, KJ_BIND_METHOD(*this, enableNetwork),
                   "Allow network access in the box.")
        .addOption({'i', "ipc"}, KJ_BIND_METHOD(*this, enableIpc),
                   "Allow IPC to be sent out of the box.")
        .addOption({'P', "pid"}, KJ_BIND_METHOD(*this, enablePid),
                   "Allow signals to be sent out of the box.")
        .expectOneOrMoreArgs("<command>", KJ_BIND_METHOD(*this, addCommandArg))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

private:
  kj::ProcessContext& context;

  enum class MappingType {
    READABLE,
    WRITABLE,
    TEMPFS,
    PROCFS,
    HIDE
  };
  struct Mapping {
    kj::String vpath;
    kj::String path;
    MappingType mappingType;
    bool isDirectory;
  };

  kj::Vector<Mapping> mappings;
  kj::Vector<kj::String> command;
  kj::String workingDir;
  int unshareFlags = CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWPID |
                     CLONE_NEWNET;

  kj::MainBuilder::Validity addMapping(kj::StringPtr arg, MappingType mappingType) {
    Mapping mapping;
    mapping.mappingType = mappingType;

    KJ_IF_MAYBE(equalsPos, arg.findFirst('=')) {
      mapping.vpath = kj::heapString(arg.slice(0, *equalsPos));
      mapping.path = kj::heapString(arg.slice(*equalsPos + 1));
    } else {
      mapping.vpath = kj::heapString(arg);
      mapping.path = kj::heapString(arg);
    }

    if (mappingType == MappingType::READABLE || mappingType == MappingType::WRITABLE) {
      if (access(mapping.path.cStr(), F_OK) < 0) {
        return "No such file or directory.";
      }
      mapping.isDirectory = isDirectory(mapping.path.cStr());
    } else {
      mapping.isDirectory = true;
    }

    mappings.add(kj::mv(mapping));
    return true;
  }

  kj::MainBuilder::Validity addReadOnlyMapping(kj::StringPtr arg) {
    return addMapping(arg, MappingType::READABLE);
  }

  kj::MainBuilder::Validity addWritableMapping(kj::StringPtr arg) {
    return addMapping(arg, MappingType::WRITABLE);
  }

  kj::MainBuilder::Validity addTempfsMapping(kj::StringPtr arg) {
    return addMapping(arg, MappingType::TEMPFS);
  }

  kj::MainBuilder::Validity addProcfsMapping(kj::StringPtr arg) {
    return addMapping(arg, MappingType::PROCFS);
  }

  kj::MainBuilder::Validity addHideMapping(kj::StringPtr arg) {
    return addMapping(arg, MappingType::HIDE);
  }

  kj::MainBuilder::Validity enableNetwork() {
    unshareFlags &= ~CLONE_NEWNET;
    return true;
  }

  kj::MainBuilder::Validity enableIpc() {
    unshareFlags &= ~CLONE_NEWIPC;
    return true;
  }

  kj::MainBuilder::Validity enablePid() {
    unshareFlags &= ~CLONE_NEWPID;
    return true;
  }

  kj::MainBuilder::Validity setWorkingDir(kj::StringPtr arg) {
    workingDir = kj::heapString(arg);
    return true;
  }

  kj::MainBuilder::Validity addCommandArg(kj::StringPtr arg) {
    command.add(kj::heapString(arg));
    return true;
  }

  kj::MainBuilder::Validity run() {
    if (mappings.size() == 0 || mappings[0].vpath != "/") {
      return "The first mapping must be for '/'.";
    }

    static const char MOUNT_POINT[] = "/tmp/minibox-mount";
    mkdir(MOUNT_POINT, 0777);

    uid_t uid = getuid();
    gid_t gid = getgid();

    KJ_SYSCALL(unshare(unshareFlags));

    writeUserNSMap("uid", kj::str("1000 ", uid, " 1\n"));
    writeUserNSMap("gid", kj::str("1000 ", gid, " 1\n"));

    if (unshareFlags & CLONE_NEWPID) {
      // Need to create a child process to actually enter the PID namespace.
      pid_t child;
      KJ_SYSCALL(child = fork());
      if (child != 0) {
        for (;;) {
          int status;
          KJ_SYSCALL(waitpid(child, &status, 0));
          if (WIFEXITED(status)) {
            _exit(WEXITSTATUS(status));
          } else if (WIFSIGNALED(status)) {
            // Kill ourselves with the same signal.
            KJ_SYSCALL(kill(getpid(), WTERMSIG(status)));
            // Shouldn't get here.
            context.exitError(strsignal(WTERMSIG(status)));
          }
        }
      }

      // We're in the child process. Arrange to kill the child if the parent dies.
      KJ_SYSCALL(prctl(PR_SET_PDEATHSIG, SIGKILL));
    }

    // Make sure all mounts are private.
    KJ_SYSCALL(mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr));

    // Map all mounts.
    for (auto& mapping: mappings) {
      auto vpath = mapping.vpath == "/" ? kj::str(MOUNT_POINT) :
          mapping.vpath.startsWith("/") ? kj::str(MOUNT_POINT, mapping.vpath) :
                                          kj::str(MOUNT_POINT, '/', mapping.vpath);

      ensureExists(vpath, mapping.isDirectory);

      switch (mapping.mappingType) {
        case MappingType::READABLE:
          KJ_SYSCALL(mount(mapping.path.cStr(), vpath.cStr(), nullptr, MS_BIND | MS_REC, nullptr),
                     mapping.path, vpath);
          remountUnder(vpath, MS_RDONLY);
          break;
        case MappingType::WRITABLE:
          KJ_SYSCALL(mount(mapping.path.cStr(), vpath.cStr(), nullptr, MS_BIND | MS_REC, nullptr),
                     mapping.path, vpath);
          break;
        case MappingType::TEMPFS:
          KJ_SYSCALL(mount("tmpfs", vpath.cStr(), "tmpfs", 0, "size=8m,nr_inodes=128,mode=777"),
                     vpath);
          break;
        case MappingType::PROCFS:
          KJ_SYSCALL(mount("proc", vpath.cStr(), "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, ""),
                     vpath);
          break;
        case MappingType::HIDE:
          KJ_SYSCALL(mount("tmpfs", vpath.cStr(), "tmpfs", MS_RDONLY,
                           "size=32k,nr_inodes=8,mode=555"),
                     vpath);
          break;
      }
    }

    // Use Andy's ridiculous pivot_root trick to place ourselves into the sandbox.
    // See supervisor-main.c++ for more discussion.
    {
      auto oldRootDir = raiiOpen("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
      KJ_SYSCALL(syscall(SYS_pivot_root, MOUNT_POINT, MOUNT_POINT));
      KJ_SYSCALL(fchdir(oldRootDir));
      KJ_SYSCALL(umount2(".", MNT_DETACH));
      KJ_SYSCALL(chdir("/"));
    }

    if (workingDir.size() > 0) {
      KJ_SYSCALL(chdir(workingDir.cStr()), workingDir);
    }

    // Drop all Linux "capabilities". (These are Linux/POSIX "capabilities", which are not true
    // object-capabilities, hence the quotes.)
    struct __user_cap_header_struct hdr;
    struct __user_cap_data_struct data[2];
    hdr.version = _LINUX_CAPABILITY_VERSION_3;
    hdr.pid = 0;
    memset(data, 0, sizeof(data));  // All capabilities disabled!
    KJ_SYSCALL(capset(&hdr, data));

    // Set no_new_privs for good measure.
    KJ_SYSCALL(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));

    // Exec our program.
    auto argv = kj::heapArrayBuilder<char*>(command.size() + 1);
    for (auto& arg: command) {
      argv.add(arg.begin());
    }
    argv.add(nullptr);
    KJ_SYSCALL(execvp(command[0].cStr(), argv.begin()));
    KJ_UNREACHABLE;
  }

  void writeUserNSMap(const char *type, kj::StringPtr contents) {
    kj::FdOutputStream(raiiOpen(kj::str("/proc/self/", type, "_map").cStr(), O_WRONLY | O_CLOEXEC))
        .write(contents.begin(), contents.size());
  }

  bool isDirectory(kj::StringPtr path) {
    struct stat stats;
    KJ_SYSCALL(stat(path.cStr(), &stats));
    return S_ISDIR(stats.st_mode);
  }

  void ensureExists(kj::StringPtr path, bool asDirectory) {
    if (access(path.cStr(), F_OK) == 0) {
      return;
    }

    KJ_IF_MAYBE(slashPos, path.findFirst('/')) {
      if (*slashPos > 0) {
        ensureExists(kj::heapString(path.slice(0, *slashPos)), true);
      }
    }

    if (asDirectory) {
      KJ_SYSCALL(mkdir(path.cStr(), 0777));
    } else {
      KJ_SYSCALL(mknod(path.cStr(), S_IFREG | 0777, 0));
    }
  }

  struct MountInfo {
    kj::String path;
    unsigned long flags = 0;
  };

  kj::Array<MountInfo> getAllMounts() {
    FILE* mounts = fopen("/proc/mounts", "r");
    if (mounts == nullptr) {
      KJ_FAIL_SYSCALL("fopen", errno);
    }
    KJ_DEFER(fclose(mounts));

    kj::Vector<MountInfo> results;

    while (struct mntent* entry = getmntent(mounts)) {
      MountInfo info;
      info.path = kj::heapString(entry->mnt_dir);

      kj::StringPtr opts = entry->mnt_opts;
      while (opts.size() > 0) {
        kj::String opt;

        KJ_IF_MAYBE(commaPos, opts.findFirst(',')) {
          opt = kj::heapString(opts.slice(0, *commaPos));
          opts = opts.slice(*commaPos + 1);
        } else {
          opt = kj::heapString(opts);
          opts = nullptr;
        }

        if (opt == "ro") {
          info.flags |= MS_RDONLY;
        } else if (opt == "nosuid") {
          info.flags |= MS_NOSUID;
        } else if (opt == "nodev") {
          info.flags |= MS_NODEV;
        } else if (opt == "noexec") {
          info.flags |= MS_NOEXEC;
        }
      }

      results.add(kj::mv(info));
    }

    return results.releaseAsArray();
  }

  void remountUnder(kj::StringPtr prefix, unsigned long flagsToAdd) {
    for (auto& mnt: getAllMounts()) {
      if ((mnt.flags & flagsToAdd) != flagsToAdd &&
          mnt.path.startsWith(prefix) &&
          (mnt.path.size() == prefix.size() || mnt.path[prefix.size()] == '/')) {
        KJ_SYSCALL(mount(nullptr, mnt.path.cStr(), nullptr,
                         MS_BIND | MS_REMOUNT | mnt.flags | flagsToAdd, nullptr),
                   mnt.path, prefix);
      }
    }
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::MiniboxMain)
