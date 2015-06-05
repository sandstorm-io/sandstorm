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

namespace sandstorm {

class BackupMain: public AbstractMain {
public:
  BackupMain(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() override {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Backs up the grain directory in <grain> to <file>, reading the grain "
                           "metadata struct on stdin. Or, restores the backup in <file>, "
                           "unpacking it to <grain>, and writing the metadata to stdout. In "
                           "backup mode, <file> can be `-` to write the data to stdout.")
        .addOption({'r', "restore"}, KJ_BIND_METHOD(*this, setRestore),
                   "Restore a backup, rather than create a backup.")
        .addOptionWithArg({"root"}, KJ_BIND_METHOD(*this, setRoot), "<root>",
                   "Set the \"root directory\" to map in, which contains the zip/unzip binaries.")
        .expectArg("<file>", KJ_BIND_METHOD(*this, setFile))
        .expectArg("<grain>", KJ_BIND_METHOD(*this, run))
        .build();
  }

private:
  kj::ProcessContext& context;
  bool restore = false;
  kj::StringPtr filename;
  kj::StringPtr root = "";

  bool setRestore() {
    restore = true;
    return true;
  }

  bool setFile(kj::StringPtr arg) {
    filename = arg;
    return true;
  }

  bool setRoot(kj::StringPtr arg) {
    root = arg;
    return true;
  }

  void writeSetgroupsIfPresent(const char *contents) {
    KJ_IF_MAYBE(fd, raiiOpenIfExists("/proc/self/setgroups", O_WRONLY | O_CLOEXEC)) {
      kj::FdOutputStream(kj::mv(*fd)).write(contents, strlen(contents));
    }
  }

  void writeUserNSMap(const char *type, kj::StringPtr contents) {
    kj::FdOutputStream(raiiOpen(kj::str("/proc/self/", type, "_map").cStr(), O_WRONLY | O_CLOEXEC))
        .write(contents.begin(), contents.size());
  }

  bool run(kj::StringPtr grainDir) {
    uid_t uid = getuid();
    gid_t gid = getgid();

    KJ_SYSCALL(unshare(CLONE_NEWUSER | CLONE_NEWNS));
    writeSetgroupsIfPresent("deny\n");
    writeUserNSMap("uid", kj::str("1000 ", uid, " 1\n"));
    writeUserNSMap("gid", kj::str("1000 ", gid, " 1\n"));

    // Mount root read-only.
    KJ_SYSCALL(mount(kj::str(root, "/").cStr(), "/tmp", nullptr,
                     MS_BIND | MS_REC | MS_RDONLY, nullptr));

    if (access("/tmp/dev/null", F_OK) != 0) {
      // Looks like we need to bind in /dev.
      KJ_SYSCALL(mount("/dev", "/tmp/dev", nullptr, MS_BIND, nullptr));
    }

    // Hide sensitive directories.
    KJ_SYSCALL(mount("tmpfs", "/tmp/proc", "tmpfs", 0, "size=32k,nr_inodes=8,mode=000"));
    KJ_SYSCALL(mount("tmpfs", "/tmp/var", "tmpfs", 0, "size=32k,nr_inodes=8,mode=000"));
    KJ_SYSCALL(mount("tmpfs", "/tmp/etc", "tmpfs", 0, "size=32k,nr_inodes=8,mode=000"));

    // Mount inner tmpfs.
    KJ_SYSCALL(mount("tmpfs", "/tmp/tmp", "tmpfs", 0, "size=8m,nr_inodes=128,mode=777"));

    // Bind in the grain's `data` (=`sandbox`).
    if (restore) {
      KJ_SYSCALL(mkdir(kj::str(grainDir, "/sandbox").cStr(), 0770));
    }
    KJ_SYSCALL(mkdir("/tmp/tmp/data", 0700));
    KJ_SYSCALL(mount(kj::str(grainDir, "/sandbox").cStr(), "/tmp/tmp/data", nullptr,
                     MS_BIND | (restore ? 0 : MS_RDONLY), nullptr));

    // Bind in the grain's `log`. When restoring, we discard the log.
    if (!restore) {
      KJ_SYSCALL(mknod("/tmp/tmp/log", S_IFREG | 0600, 0));
      KJ_SYSCALL(mount(kj::str(grainDir, "/log").cStr(), "/tmp/tmp/log", nullptr,
                       MS_BIND | MS_RDONLY, nullptr));
    }

    // Bind in the file.
    if (restore) {
      KJ_SYSCALL(mknod("/tmp/tmp/file.zip", S_IFREG | 0600, 0));
      KJ_SYSCALL(mount(filename.cStr(), "/tmp/tmp/file.zip", nullptr, MS_BIND, nullptr));
    } else if (filename != "-") {
      // Instead of binding, just open the file and we'll compress to stdout.
      KJ_SYSCALL(dup2(raiiOpen(filename, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC), STDOUT_FILENO));
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

    // TODO(someday): Find a zip library that doesn't suck and use it instead of shelling out
    //   to zip/unzip.
    if (restore) {
      Subprocess({"unzip", "-q", "file.zip", "data/*", "metadata"}).waitForSuccess();

      // Read metadata file to stdout.
      kj::FdInputStream in(raiiOpen("metadata", O_RDONLY | O_CLOEXEC));
      kj::FdOutputStream out(STDOUT_FILENO);
      pump(in, out);
    } else {
      // Read stdin to metadata file.
      {
        kj::FdInputStream in(STDIN_FILENO);
        kj::FdOutputStream out(raiiOpen("metadata", O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC));
        pump(in, out);
      }

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

  static void pump(kj::InputStream& in, kj::OutputStream& out) {
    byte buffer[4096];
    while (size_t n = in.tryRead(buffer, 1, sizeof(buffer))) {
      out.write(buffer, n);
    }
  }

  void findFilesToZip(kj::StringPtr path, kj::OutputStream& out) {
    struct stat stats;
    KJ_SYSCALL(lstat(path.cStr(), &stats));
    if (S_ISREG(stats.st_mode) || S_ISLNK(stats.st_mode)) {
      // Regular file or link can be zipped; write to file stream.
      // If the path contains a newline, we cannot correctly pass it to `zip` since `zip` expects
      // one file per line. For security reasons, we must detect and filter out these files.
      // Hopefully this never happens legitimately?
      if (path.findFirst('\n') == nullptr) {
        kj::ArrayPtr<const byte> pieces[2];
        pieces[0] = path.asBytes();
        pieces[1] = kj::StringPtr("\n").asBytes();
        out.write(pieces);
      } else {
        KJ_LOG(ERROR, "tried to backup file containing newlines", path);
      }
    } else if (S_ISDIR(stats.st_mode)) {
      // Subdirectory; enumerate contents.
      for (auto& entry: listDirectory(path)) {
        findFilesToZip(kj::str(path, '/', entry), out);
      }
    }
  }
};

kj::Own<AbstractMain> getBackupMain(kj::ProcessContext& context) {
  return kj::heap<BackupMain>(context);
}

} // namespace sandstorm

