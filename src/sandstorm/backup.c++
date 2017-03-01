// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

#include "backup.h"
#include "util.h"
#include "version.h"
#include <kj/debug.h>
#include <sched.h>
#include <sys/mount.h>
#include <sys/syscall.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/prctl.h>
#include <sys/capability.h>

// In case kernel headers are old.
#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

namespace sandstorm {

BackupMain::BackupMain(kj::ProcessContext& context): context(context) {}

kj::MainFunc BackupMain::getMain() {
  return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                         "Backs up the grain directory in <grain> to <file>, reading the grain "
                         "metadata struct on stdin. Or, restores the backup in <file>, "
                         "unpacking it to <grain>, and writing the metadata to stdout. In "
                         "backup mode, <file> can be `-` to write the data to stdout.")
      .addOptionWithArg({"uid"}, KJ_BIND_METHOD(*this, setUid), "<uid>",
                        "Use setuid sandbox rather than userns. Must start as root, but swiches "
                        "to <uid> to run the app.")
      .addOption({'r', "restore"}, KJ_BIND_METHOD(*this, setRestore),
                 "Restore a backup, rather than create a backup.")
      .addOptionWithArg({"root"}, KJ_BIND_METHOD(*this, setRoot), "<root>",
                 "Set the \"root directory\" to map in, which contains the zip/unzip binaries.")
      .expectArg("<file>", KJ_BIND_METHOD(*this, setFile))
      .expectArg("<grain>", KJ_BIND_METHOD(*this, run))
      .build();
}

bool BackupMain::setRestore() {
  restore = true;
  return true;
}

bool BackupMain::setFile(kj::StringPtr arg) {
  filename = arg;
  return true;
}

bool BackupMain::setRoot(kj::StringPtr arg) {
  root = arg;
  return true;
}

bool BackupMain::setUid(kj::StringPtr arg) {
  KJ_IF_MAYBE(u, parseUInt(arg, 10)) {
    if (getuid() != 0) {
      return false;
    }
    if (*u == 0) {
      return false;
    }
    KJ_SYSCALL(seteuid(*u));
    sandboxUid = *u;
    return true;
  } else {
    return false;
  }
}

void BackupMain::writeSetgroupsIfPresent(const char *contents) {
  KJ_IF_MAYBE(fd, raiiOpenIfExists("/proc/self/setgroups", O_WRONLY | O_CLOEXEC)) {
    kj::FdOutputStream(kj::mv(*fd)).write(contents, strlen(contents));
  }
}

void BackupMain::writeUserNSMap(const char *type, kj::StringPtr contents) {
  kj::FdOutputStream(raiiOpen(kj::str("/proc/self/", type, "_map").cStr(), O_WRONLY | O_CLOEXEC))
      .write(contents.begin(), contents.size());
}

void BackupMain::bind(kj::StringPtr src, kj::StringPtr dst, unsigned long flags) {
  // Contrary to the documentation of MS_BIND claiming this is no longer the case after 2.6.26,
  // mountflags are ignored on the initial bind.  We have to issue a subsequent remount to set
  // them.
  KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr, MS_BIND | MS_REC, nullptr), src, dst);
  KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr,
                   MS_BIND | MS_REC | MS_REMOUNT | flags, nullptr),
      src, dst);
}

bool BackupMain::run(kj::StringPtr grainDir) {
  // Enable no_new_privs so that once we drop privileges we can never regain them through e.g.
  // execing a suid-root binary, as a backup measure. This is a backup measure in case someone
  // finds an arbitrary code execution exploit in zip/unzip; it's not needed otherwise.
  KJ_SYSCALL(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));

  // Create files / directories before we potentially change the UID, so that they are created
  // with the right owner.
  if (restore) {
    KJ_SYSCALL(mkdir(kj::str(grainDir, "/sandbox").cStr(), 0770));
  } else if (filename != "-") {
    // Instead of binding into mount tree later, just open the file and we'll compress to stdout.
    KJ_SYSCALL(dup2(raiiOpen(filename, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC), STDOUT_FILENO));
  }

  if (sandboxUid == nullptr) {
    uid_t uid = getuid();
    gid_t gid = getgid();

    KJ_SYSCALL(unshare(CLONE_NEWUSER | CLONE_NEWNS |
        // Unshare other stuff; like no_new_privs, this is only to defend against hypothetical
        // arbitrary code execution bugs in zip/unzip.
        CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWPID | CLONE_NEWUTS));
    writeSetgroupsIfPresent("deny\n");
    writeUserNSMap("uid", kj::str("1000 ", uid, " 1\n"));
    writeUserNSMap("gid", kj::str("1000 ", gid, " 1\n"));
  } else {
    KJ_SYSCALL(seteuid(0));
    KJ_SYSCALL(unshare(CLONE_NEWNS |
        // Unshare other stuff; like no_new_privs, this is only to defend against hypothetical
        // arbitrary code execution bugs in zip/unzip.
        CLONE_NEWNET | CLONE_NEWIPC | CLONE_NEWPID | CLONE_NEWUTS));
  }

  // To really unshare the mount namespace, we also have to make sure all mounts are private.
  // The parameters here were derived by strace'ing `mount --make-rprivate /`.  AFAICT the flags
  // are undocumented.  :(
  KJ_SYSCALL(mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr));

  // Create tmpfs root to whitelist directories that we want to bind in.
  KJ_SYSCALL(mount("tmpfs", "/tmp", "tmpfs", 0, "size=8m,nr_inodes=128,mode=755"));

  // Bind in whitelisted directories.
  const char* WHITELIST[] = { "dev", "bin", "lib", "lib64", "usr" };
  for (const char* dir: WHITELIST) {
    auto src = kj::str(root, "/", dir);
    auto dst = kj::str("/tmp/", dir);
    if (access(src.cStr(), F_OK) == 0) {
      KJ_SYSCALL(mkdir(dst.cStr(), 0755));
      bind(src, dst, MS_BIND | MS_NOSUID | MS_RDONLY);
    }
  }

  // Make sandboxed /tmp.
  KJ_SYSCALL(mkdir("/tmp/tmp", 0777));

  // Bind in the grain's `data` (=`sandbox`).
  KJ_SYSCALL(mkdir("/tmp/tmp/data", 0777));
  bind(kj::str(grainDir, "/sandbox"), "/tmp/tmp/data",
       MS_NODEV | MS_NOSUID | MS_NOEXEC | (restore ? 0 : MS_RDONLY));

  // Bind in the grain's `log`. When restoring, we discard the log.
  if (!restore) {
    KJ_SYSCALL(mknod("/tmp/tmp/log", S_IFREG | 0666, 0));
    bind(kj::str(grainDir, "/log"), "/tmp/tmp/log", MS_RDONLY | MS_NOEXEC | MS_NOSUID | MS_NODEV);
  }

  // Bind in the file.
  if (restore) {
    KJ_SYSCALL(mknod("/tmp/tmp/file.zip", S_IFREG | 0666, 0));
    KJ_SYSCALL(mount(filename.cStr(), "/tmp/tmp/file.zip", nullptr, MS_BIND, nullptr));
  }

  // Use Andy's ridiculous pivot_root trick to place ourselves into the sandbox.
  // See supervisor-main.c++ for more discussion.
  {
    auto oldRootDir = raiiOpen("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
    KJ_SYSCALL(syscall(SYS_pivot_root, "/tmp", "/tmp"));
    KJ_SYSCALL(fchdir(oldRootDir));
    KJ_SYSCALL(umount2(".", MNT_DETACH));
    KJ_SYSCALL(chdir("/tmp"));
  }

  KJ_IF_MAYBE(u, sandboxUid) {
    KJ_SYSCALL(setresuid(*u, *u, *u));
  }

  // TODO(security): We could seccomp this pretty tightly, but that would only be necessary to
  //   defend against *both* zip/unzip *and* the Linux kernel having bugs at the same time. It's
  //   fairly involved to set up, so maybe not worthwhile, unless we could factor the code out of
  //   supervisor.c++...

  if (!restore) {
    // Read stdin to metadata file.
    kj::FdInputStream in(STDIN_FILENO);
    kj::FdOutputStream out(raiiOpen("metadata", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC));
    pump(in, out);
  }

  {
    // Drop crapabilities.
    struct __user_cap_header_struct hdr;
    struct __user_cap_data_struct data[2];
    hdr.version = _LINUX_CAPABILITY_VERSION_3;
    hdr.pid = 0;
    memset(data, 0, sizeof(data));  // All capabilities disabled!
    KJ_SYSCALL(capset(&hdr, data));
    umask(0007);
  }

  // TODO(someday): Find a zip library that doesn't suck and use it instead of shelling out
  //   to zip/unzip.
  if (restore) {
    Subprocess({"unzip", "-q", "file.zip", "data/*", "metadata"}).waitForSuccess();

    // Read metadata file to stdout.
    kj::FdInputStream in(raiiOpen("metadata", O_RDONLY | O_CLOEXEC));
    kj::FdOutputStream out(STDOUT_FILENO);
    pump(in, out);
  } else {
    Subprocess::Options zipOptions({"zip", "-qy@", "-"});
    auto inPipe = Pipe::make();
    zipOptions.stdin = inPipe.readEnd;
    Subprocess zip(kj::mv(zipOptions));
    inPipe.readEnd = nullptr;

    {
      kj::FdOutputStream out(kj::mv(inPipe.writeEnd));
      for (auto& entry: listDirectory(".")) {
        findFilesToZip(entry, out);
      }
    }

    zip.waitForSuccess();
  }

  return true;
}

void BackupMain::pump(kj::InputStream& in, kj::OutputStream& out) {
  byte buffer[4096];
  while (size_t n = in.tryRead(buffer, 1, sizeof(buffer))) {
    out.write(buffer, n);
  }
}

bool BackupMain::findFilesToZip(kj::StringPtr path, kj::OutputStream& out) {
  // If the path contains a newline, we cannot correctly pass it to `zip` since `zip` expects
  // one file per line. For security reasons, we must detect and filter out these files.
  // Hopefully this never happens legitimately?
  if (path.findFirst('\n') != nullptr) {
    KJ_LOG(ERROR, "tried to backup file containing newlines", path);
    return false;
  }

  struct stat stats;
  KJ_SYSCALL(lstat(path.cStr(), &stats));
  if (S_ISREG(stats.st_mode) || S_ISLNK(stats.st_mode)) {
    // Regular file or link can be zipped; write to file stream.
    kj::ArrayPtr<const byte> pieces[2];
    pieces[0] = path.asBytes();
    pieces[1] = kj::StringPtr("\n").asBytes();
    out.write(pieces);
    return true;
  } else if (S_ISDIR(stats.st_mode)) {
    // Subdirectory; enumerate contents.
    bool packedAny = false;
    for (auto& entry: listDirectory(path)) {
      if (findFilesToZip(kj::str(path, '/', entry), out)) {
        packedAny = true;
      }
    }

    if (!packedAny) {
      // Empty directory. Need to make sure it gets into the zip.
      kj::ArrayPtr<const byte> pieces[2];
      pieces[0] = path.asBytes();
      pieces[1] = kj::StringPtr("\n").asBytes();
      out.write(pieces);
    }
    return true;
  } else {
    return false;
  }
}

} // namespace sandstorm

