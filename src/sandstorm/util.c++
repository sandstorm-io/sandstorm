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

#include "util.h"
#include <errno.h>
#include <kj/vector.h>
#include <kj/async-unix.h>
#include <kj/filesystem.h>
#include <ctype.h>
#include <stdlib.h>
#include <unistd.h>
#include <sys/types.h>
#include <dirent.h>
#include <syscall.h>
#include <signal.h>
#include <sys/wait.h>
#include <map>
#include <sys/mman.h>
#include <sys/socket.h>
#include <sys/sendfile.h>

namespace sandstorm {

Pipe Pipe::make() {
  int fds[2];
  KJ_SYSCALL(pipe2(fds, O_CLOEXEC));
  return { kj::AutoCloseFd(fds[0]), kj::AutoCloseFd(fds[1]) };
}

Pipe Pipe::makeAsync() {
  int fds[2];
  KJ_SYSCALL(pipe2(fds, O_CLOEXEC | O_ASYNC));
  return { kj::AutoCloseFd(fds[0]), kj::AutoCloseFd(fds[1]) };
}

Pipe Pipe::makeTwoWayAsync() {
  int fds[2];
  KJ_SYSCALL(socketpair(AF_UNIX, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, 0, fds));
  return { kj::AutoCloseFd(fds[0]), kj::AutoCloseFd(fds[1]) };
}

kj::AutoCloseFd raiiOpen(kj::StringPtr name, int flags, mode_t mode) {
  int fd;
  KJ_SYSCALL(fd = open(name.cStr(), flags, mode), name);
  return kj::AutoCloseFd(fd);
}

kj::AutoCloseFd raiiOpenAt(int dirfd, kj::StringPtr name, int flags, mode_t mode) {
  int fd;
  if ((flags & O_TMPFILE) == O_TMPFILE) {
    // work around glibc bug: https://sourceware.org/bugzilla/show_bug.cgi?id=17523
    KJ_SYSCALL(fd = syscall(SYS_openat, dirfd, name.cStr(), flags, mode), name);
  } else {
    KJ_SYSCALL(fd = openat(dirfd, name.cStr(), flags, mode), name);
  }
  return kj::AutoCloseFd(fd);
}

kj::Maybe<kj::AutoCloseFd> raiiOpenIfExists(kj::StringPtr name, int flags, mode_t mode) {
  int fd = open(name.cStr(), flags, mode);
  if (fd == -1) {
    if (errno == ENOENT) {
      return nullptr;
    } else {
      KJ_FAIL_SYSCALL("open", errno, name);
    }
  } else {
    return kj::AutoCloseFd(fd);
  }
}

kj::Maybe<kj::AutoCloseFd> raiiOpenAtIfExists(
    int dirfd, kj::StringPtr name, int flags, mode_t mode) {
  int fd = openat(dirfd, name.cStr(), flags, mode);
  if (fd == -1) {
    if (errno == ENOENT) {
      return nullptr;
    } else {
      KJ_FAIL_SYSCALL("open", errno, name);
    }
  } else {
    return kj::AutoCloseFd(fd);
  }
}

kj::Maybe<kj::AutoCloseFd> raiiOpenAtIfExistsContained(int dirfd, kj::StringPtr path, int flags, mode_t mode) {
  return raiiOpenAtIfExistsContained(dirfd, kj::Path::parse(path), flags, mode);
}

kj::Maybe<kj::AutoCloseFd> raiiOpenAtIfExistsContained(int dirfd, kj::PathPtr path, int flags, mode_t mode) {
  return raiiOpenAtIfExistsContained(dirfd, kj::Path{}.append(path), flags, mode);
}

kj::Maybe<kj::AutoCloseFd> raiiOpenAtIfExistsContained(int dirfd, kj::Path&& path, int flags, mode_t mode) {
  int fd;
  KJ_SYSCALL(fd = dup(dirfd));
  kj::AutoCloseFd file(fd);
  char path_buf[PATH_MAX+1]; // scratch buffer for file paths
  int symlink_limit = 16; // arbitrary limit

  int i = 0;
  while(i < path.size()) {
    const char *part = path[i].cStr();
    KJ_SYSCALL_HANDLE_ERRORS(fd = openat(file.get(), part, flags | O_NOFOLLOW, mode)) {
      case ENOENT:
        return nullptr;
      case ELOOP:
        {
          if(symlink_limit == 0) {
            KJ_FAIL_SYSCALL("openat()", error);
          }
          symlink_limit--;

          ssize_t target_len;
          KJ_SYSCALL(target_len = readlinkat(file.get(), part, path_buf, PATH_MAX+1));
          if(target_len >= PATH_MAX) {
            // It might be nice to handle larger paths here by dynamically
            // resizing the buffer. TODO: consider using the kj filesystem
            // API instead, which does this itself.
            KJ_FAIL_REQUIRE("readlinkat: name too long");
          }
          path_buf[target_len] = '\0';
          kj::Path nextPath = path.slice(0, i).eval(path_buf);
          path = kj::mv(nextPath).append(path.slice(i+1, path.size()));
          i = 0;
          KJ_SYSCALL(fd = dup(dirfd));
          break;
        }
      default:
        KJ_FAIL_SYSCALL("openat()", error);
    } else {
      i++;
    }
    file = kj::AutoCloseFd(fd);
  }
  return kj::mv(file);
}

size_t getFileSize(int fd, kj::StringPtr filename) {
  struct stat stats;
  KJ_SYSCALL(fstat(fd, &stats));
  KJ_REQUIRE(S_ISREG(stats.st_mode), "Not a regular file.", filename);
  return stats.st_size;
}

MemoryMapping::MemoryMapping(int fd, kj::StringPtr filename): content(nullptr) {
  size_t size = getFileSize(fd, filename);

  if (size != 0) {
    void* ptr = mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (ptr == MAP_FAILED) {
      KJ_FAIL_SYSCALL("mmap", errno, filename);
    }

    content = kj::arrayPtr(reinterpret_cast<byte*>(ptr), size);
  }
}

MemoryMapping::~MemoryMapping() noexcept(false) {
  if (content != nullptr) {
    KJ_SYSCALL(munmap(content.begin(), content.size()));
  }
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

kj::Promise<void> pump(kj::AsyncInputStream& input, ByteStream::Client stream) {
  auto req = stream.writeRequest(capnp::MessageSize { 2100, 0 });
  auto orphanage = capnp::Orphanage::getForMessageContaining(
      kj::implicitCast<ByteStream::WriteParams::Builder>(req));
  auto orphan = orphanage.newOrphan<capnp::Data>(8192);
  auto buffer = orphan.get();

  return input.tryRead(buffer.begin(), 1, buffer.size())
      .then([&input,KJ_MVCAP(stream),KJ_MVCAP(req),KJ_MVCAP(orphan)](size_t n) mutable
            -> kj::Promise<void> {
    if (n == 0) {
      return stream.doneRequest(capnp::MessageSize {4, 0}).send().then([](auto&&) {});
    }

    orphan.truncate(n);
    req.adoptData(kj::mv(orphan));

    return req.send().then([&input,KJ_MVCAP(stream)]() mutable {
      return pump(input, kj::mv(stream));
    });
  });
}

kj::Promise<void> pump(kj::InputStream& input, ByteStream::Client stream) {
  auto req = stream.writeRequest(capnp::MessageSize { 2100, 0 });
  auto orphanage = capnp::Orphanage::getForMessageContaining(
      kj::implicitCast<ByteStream::WriteParams::Builder>(req));
  auto orphan = orphanage.newOrphan<capnp::Data>(8192);
  auto buffer = orphan.get();

  size_t n = input.tryRead(buffer.begin(), 1, buffer.size());
  if (n == 0) {
    return stream.doneRequest(capnp::MessageSize {4, 0}).send().then([](auto&&) {});
  }

  orphan.truncate(n);
  req.adoptData(kj::mv(orphan));

  return req.send().then([&input,KJ_MVCAP(stream)]() mutable {
    return pump(input, kj::mv(stream));
  });
}

kj::Promise<void> pumpDuplex(kj::Own<kj::AsyncIoStream> client,
                             kj::Own<kj::AsyncIoStream> server) {
  auto promise = client->pumpTo(*server)
      .then([](size_t) -> kj::Promise<void> { return kj::NEVER_DONE; })
      .exclusiveJoin(server->pumpTo(*client).ignoreResult());
  return promise.attach(kj::mv(client), kj::mv(server));
}

kj::ArrayPtr<const char> trimArray(kj::ArrayPtr<const char> slice) {
  while (slice.size() > 0 && isspace(slice[0])) {
    slice = slice.slice(1, slice.size());
  }
  while (slice.size() > 0 && isspace(slice[slice.size() - 1])) {
    slice = slice.slice(0, slice.size() - 1);
  }

  return slice;
}

kj::String trim(kj::ArrayPtr<const char> slice) {
  return kj::heapString(trimArray(slice));
}

void toLower(kj::ArrayPtr<char> text) {
  for (char& c: text) {
    if ('A' <= c && c <= 'Z') {
      c = c - 'A' + 'a';
    }
  }
}

kj::Maybe<uint> parseUInt(kj::StringPtr s, int base) {
  char* end;
  uint result = strtoul(s.cStr(), &end, base);
  if (s.size() == 0 || *end != '\0') {
    return nullptr;
  }
  return result;
}

kj::Maybe<uint64_t> parseUInt64(kj::StringPtr s, int base) {
  char* end;
  uint64_t result = strtoull(s.cStr(), &end, base);
  if (s.size() == 0 || *end != '\0') {
    return nullptr;
  }
  return result;
}

kj::AutoCloseFd openTemporary(kj::StringPtr near) {
  // TODO(someday):  Use O_TMPFILE?  New in Linux 3.11.

  int fd;
  auto name = kj::str(near, ".XXXXXX");
  KJ_SYSCALL(fd = mkostemp(name.begin(), O_CLOEXEC), name);
  kj::AutoCloseFd result(fd);
  KJ_SYSCALL(unlink(name.cStr()));
  return result;
}

bool isDirectory(kj::StringPtr path) {
  struct stat stats;
  KJ_SYSCALL(lstat(path.cStr(), &stats));
  return S_ISDIR(stats.st_mode);
}

static kj::Array<kj::String> listDirectoryAndClose(DIR* dir) {
  KJ_DEFER(closedir(dir));
  kj::Vector<kj::String> entries;

  for (;;) {
    errno = 0;
    struct dirent* entry = readdir(dir);
    if (entry == nullptr) {
      int error = errno;
      if (error == 0) {
        break;
      } else {
        KJ_FAIL_SYSCALL("readdir", error);
      }
    }

    kj::StringPtr name = entry->d_name;
    if (name != "." && name != "..") {
      entries.add(kj::heapString(entry->d_name));
    }
  }

  return entries.releaseAsArray();
}

kj::Array<kj::String> listDirectory(kj::StringPtr dirname) {
  DIR* dir = opendir(dirname.cStr());
  if (dir == nullptr) {
    KJ_FAIL_SYSCALL("opendir", errno, dirname);
  }
  return listDirectoryAndClose(dir);
}

kj::Array<kj::String> listDirectoryAt(int dirfd, kj::StringPtr path) {
  int fd;
  KJ_SYSCALL(fd = openat(dirfd, path.cStr(), O_RDONLY | O_DIRECTORY));
  DIR* dir = fdopendir(fd);
  if (dir == nullptr) {
    KJ_FAIL_SYSCALL("fdopendir", errno);
  }
  return listDirectoryAndClose(dir);
}

kj::Array<kj::String> listDirectoryFd(int dirfd) {
  // We can't actually use `dirfd` directly because we'd mess up the seek state and because
  // closedir() unfortunately always closes the FD even if opened with fdopendir(). So instead
  // we delegate to listDirectoryAt() which will open a new FD.
  return listDirectoryAt(dirfd, ".");
}

void recursivelyDelete(kj::StringPtr path) {
  KJ_REQUIRE(!path.endsWith("/"),
      "refusing to recursively delete directory name with trailing / to reduce risk of "
      "catastrophic empty-string bugs");
  struct stat stats;
  KJ_SYSCALL(lstat(path.cStr(), &stats), path) { return; }
  if (S_ISDIR(stats.st_mode)) {
    for (auto& file: listDirectory(path)) {
      recursivelyDelete(kj::str(path, "/", file));
    }
    KJ_SYSCALL(rmdir(path.cStr()), path) { break; }
  } else {
    KJ_SYSCALL(unlink(path.cStr()), path) { break; }
  }
}

void recursivelyDeleteAt(int fd, kj::StringPtr path) {
  KJ_REQUIRE(!path.endsWith("/"),
      "refusing to recursively delete directory name with trailing / to reduce risk of "
      "catastrophic empty-string bugs");
  struct stat stats;
  KJ_SYSCALL(fstatat(fd, path.cStr(), &stats, AT_SYMLINK_NOFOLLOW), path) { return; }
  if (S_ISDIR(stats.st_mode)) {
    for (auto& file: listDirectoryAt(fd, path)) {
      recursivelyDeleteAt(fd, kj::str(path, "/", file));
    }
    KJ_SYSCALL(unlinkat(fd, path.cStr(), AT_REMOVEDIR), path) { break; }
  } else {
    KJ_SYSCALL(unlinkat(fd, path.cStr(), 0), path) { break; }
  }
}

void recursivelyCreateParent(kj::StringPtr path) {
  KJ_IF_MAYBE(pos, path.findLast('/')) {
    if (*pos == 0) return;

    kj::String parent = kj::heapString(path.slice(0, *pos));

    bool firstTry = true;
    while (mkdir(parent.cStr(), 0777) < 0) {
      int error = errno;
      if (firstTry && error == ENOENT) {
        recursivelyCreateParent(parent);
        firstTry = false;
      } else if (error == EEXIST) {
        break;
      } else if (error != EINTR) {
        KJ_FAIL_SYSCALL("mkdir(parent)", error, parent);
      }
    }
  }
}

kj::Array<byte> readAllBytes(int fd) {
  kj::FdInputStream input(fd);
  kj::Vector<byte> content;
  for (;;) {
    byte buffer[4096];
    size_t n = input.tryRead(buffer, sizeof(buffer), sizeof(buffer));
    content.addAll(buffer, buffer + n);
    if (n < sizeof(buffer)) {
      // Done!
      break;
    }
  }
  return content.releaseAsArray();
}

kj::String readAll(int fd) {
  kj::FdInputStream input(fd);
  kj::Vector<char> content;
  for (;;) {
    char buffer[4096];
    size_t n = input.tryRead(buffer, sizeof(buffer), sizeof(buffer));
    content.addAll(buffer, buffer + n);
    if (n < sizeof(buffer)) {
      // Done!
      break;
    }
  }
  content.add('\0');
  return kj::String(content.releaseAsArray());
}

kj::String readAll(kj::StringPtr name) {
  return readAll(raiiOpen(name, O_RDONLY));
}

kj::Array<kj::String> splitLines(kj::StringPtr input) {
  size_t lineStart = 0;
  kj::Vector<kj::String> results;
  for (size_t i = 0; i < input.size(); i++) {
    if (input[i] == '\n' || input[i] == '#') {
      bool hasComment = input[i] == '#';
      auto line = trim(input.slice(lineStart, i));
      if (line.size() > 0) {
        results.add(kj::mv(line));
      }
      if (hasComment) {
        // Ignore through newline.
        ++i;
        while (i < input.size() && input[i] != '\n') ++i;
      }
      lineStart = i + 1;
    }
  }

  if (lineStart < input.size()) {
    auto lastLine = trim(input.slice(lineStart));
    if (lastLine.size() > 0) {
      results.add(kj::mv(lastLine));
    }
  }

  return results.releaseAsArray();
}

kj::Vector<kj::ArrayPtr<const char>> split(kj::ArrayPtr<const char> input, char delim) {
  kj::Vector<kj::ArrayPtr<const char>> result;

  size_t start = 0;
  for (size_t i: kj::indices(input)) {
    if (input[i] == delim) {
      result.add(input.slice(start, i));
      start = i + 1;
    }
  }
  result.add(input.slice(start, input.size()));
  return result;
}

kj::Vector<kj::ArrayPtr<const char>> splitSpace(kj::ArrayPtr<const char> input) {
  kj::Vector<kj::ArrayPtr<const char>> result;

  size_t start = 0;
  for (size_t i: kj::indices(input)) {
    if (isspace(input[i])) {
      if (i > start) {
        result.add(input.slice(start, i));
      }
      start = i + 1;
    }
  }
  if (input.size() > start) {
    result.add(input.slice(start, input.size()));
  }
  return result;
}

kj::Maybe<kj::ArrayPtr<const char>> splitFirst(kj::ArrayPtr<const char>& input, char delim) {
  for (size_t i: kj::indices(input)) {
    if (input[i] == delim) {
      auto result = input.slice(0, i);
      input = input.slice(i + 1, input.size());
      return result;
    }
  }
  return nullptr;
}

kj::ArrayPtr<const char> extractHostFromUrl(kj::StringPtr url) {
  while (url.size() > 0 && 'a' <= url[0] && url[0] <= 'z') {
    url = url.slice(1);
  }
  KJ_REQUIRE(url.startsWith("://"), "Base URL does not have a protocol scheme?");
  url = url.slice(3);
  KJ_IF_MAYBE(slashPos, url.findFirst('/')) {
    return url.slice(0, *slashPos);
  } else {
    return url;
  }
}

kj::ArrayPtr<const char> extractProtocolFromUrl(kj::StringPtr url) {
  KJ_IF_MAYBE(colonPos, url.findFirst(':')) {
    return url.slice(0, *colonPos);
  } else {
    KJ_FAIL_REQUIRE("Base URL does not have a protocol scheme.", url);
  }
}

kj::Promise<void> rotateLog(kj::Timer& timer, int logFd, kj::StringPtr path, size_t threshold) {
  struct stat stats;
  KJ_SYSCALL(fstat(logFd, &stats));
  if (stats.st_size >= threshold) {
    // TODO(someday): If .1 exists, we could move it to .2, which we could move to .3, etc. We could
    //   also gzip older logs to save space. But does anyone actually care? Probably not? Note that
    //   if this changes, the lseek() below probably needs to be replaced with something more
    //   sophisticated.
    auto out = raiiOpen(kj::str(path, ".1"), O_WRONLY | O_CREAT | O_TRUNC);

    // `logFd` might be write-only, so we reopen it for read.
    auto in = raiiOpen(path, O_RDONLY);

    // Only copy over the last `threshold` bytes of the log. We do this specifically to help deal
    // with old grains that grew enormous logs before log rotation was introduced -- we'd like them
    // to chop their logs down to size the first time they are opened. Note that this means "log.1"
    // will tend to start mid-line, which is ugly, but it's probably not worth trying to avoid.
    KJ_SYSCALL(lseek(in, stats.st_size - threshold, SEEK_SET));

    // Transfer data using `sendfile()` to avoid unnecessary copies and context switches.
    for (;;) {
      ssize_t n;
      KJ_SYSCALL(n = sendfile(out, in, nullptr, threshold));
      if (n == 0) break;
    }

    // EOF. Quick, truncate before any other log data appears.
    KJ_SYSCALL(ftruncate(logFd, 0));
  }

  return timer.afterDelay(5 * kj::MINUTES).then([=,&timer]() mutable {
    return rotateLog(timer, logFd, path, threshold);
  });
}

// =======================================================================================

bool HeaderWhitelist::matches(kj::StringPtr header) const {
  // Convert to lower-case on stack.
  KJ_STACK_ARRAY(char, buffer, header.size() + 1, 64, 256);
  memcpy(buffer.begin(), header.begin(), buffer.size());
  toLower(buffer);
  header = kj::StringPtr(buffer.begin(), header.size());

  auto iter = patterns.lower_bound(header);
  if (iter != patterns.end() && *iter == header) {
    return true;
  }

  if (iter == patterns.begin()) return false;

  // If there is a prefix that matches, it will be the item immediately before the lower_bound,
  // because the character '*' sorts before all characters that are valid inside headers.
  --iter;
  if (iter->endsWith("*")) {
    // Check if prefix matches.
    auto prefix = iter->slice(0, iter->size() - 1);
    if (header.size() >= prefix.size() &&
        memcmp(header.begin(), prefix.begin(), prefix.size()) == 0) {
      return true;
    }
  }

  return false;
}

// =======================================================================================

Subprocess::Subprocess(Options&& options)
    : name(kj::heapString(options.argv.size() > 0 ? options.argv[0] : options.executable)) {
  KJ_SYSCALL(pid = fork());
  if (pid == 0) {
    KJ_DEFER(_exit(1));  // Do not under any circumstances return from this stack frame!
    KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
      // Reset all signal handlers to default.  (exec() will leave ignored signals ignored, and KJ
      // code likes to ignore e.g. SIGPIPE.)
      // TODO(cleanup):  Is there a better way to do this?
      for (uint i = 0; i < NSIG; i++) {
        ::signal(i, SIG_DFL);  // Only possible error is EINVAL (invalid signum); we don't care.
      }

      // Unblock all signals.  (Yes, the signal mask is inherited over exec...)
      sigset_t sigmask;
      sigemptyset(&sigmask);
      KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigmask, nullptr));

      // Make sure all of the incoming FDs are outside of our map range (except for standard I/O if
      // it is already exactly in the right slot).
      int minFd = STDERR_FILENO + options.moreFds.size() + 1;

      if (options.stdin != STDIN_FILENO) forceFdAbove(options.stdin, minFd);
      if (options.stdout != STDOUT_FILENO) forceFdAbove(options.stdout, minFd);
      if (options.stderr != STDERR_FILENO) forceFdAbove(options.stderr, minFd);

      // Now remap.
      for (auto& fd: options.moreFds) {
        forceFdAbove(fd, minFd);
      }

      if (options.stdin != STDIN_FILENO) {
        KJ_SYSCALL(dup2(options.stdin, STDIN_FILENO));
      }
      if (options.stdout != STDOUT_FILENO) {
        KJ_SYSCALL(dup2(options.stdout, STDOUT_FILENO));
      }
      if (options.stderr != STDERR_FILENO) {
        KJ_SYSCALL(dup2(options.stderr, STDERR_FILENO));
      }

      for (auto i: kj::indices(options.moreFds)) {
        KJ_SYSCALL(dup2(options.moreFds[i], STDERR_FILENO + 1 + i));
      }

      // Drop privileges if requested.
      KJ_IF_MAYBE(g, options.gid) {
        KJ_SYSCALL(setresgid(*g, *g, *g));
      }
      KJ_IF_MAYBE(u, options.uid) {
        KJ_SYSCALL(setresuid(*u, *u, *u));
      }

      // Make the args vector.
      char* argv[options.argv.size() + 1];
      for (auto i: kj::indices(options.argv)) {
        // exec*() is not const-correct. :(
        argv[i] = const_cast<char*>(options.argv[i].cStr());
      }
      argv[options.argv.size()] = nullptr;
      char** argvp = argv;  // lambda can't capture variable-size array

      KJ_IF_MAYBE(e, options.environment) {
        // Make the environment vector.
        char* environ[e->size() + 1];
        for (auto i: kj::indices(*e)) {
          // exec*() is not const-correct. :(
          environ[i] = const_cast<char*>((*e)[i].cStr());
        }
        environ[e->size()] = nullptr;
        char** environp = environ;  // lambda can't capture variable-size array

        if (options.searchPath) {
          KJ_SYSCALL(execvpe(options.executable.cStr(), argvp, environp), options.executable);
        } else {
          KJ_SYSCALL(execve(options.executable.cStr(), argvp, environp), options.executable);
        }
      } else {
        if (options.searchPath) {
          KJ_SYSCALL(execvp(options.executable.cStr(), argvp), options.executable);
        } else {
          KJ_SYSCALL(execv(options.executable.cStr(), argvp), options.executable);
        }
      }

      KJ_UNREACHABLE;
    })) {
      KJ_LOG(FATAL, *exception);
    }
  }
}

Subprocess::Subprocess(kj::Function<int()> func) {
  KJ_SYSCALL(pid = fork());
  if (pid == 0) {
    KJ_DEFER(_exit(1));  // Do not under any circumstances return from this stack frame!

    KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
      _exit(func());
    })) {
      KJ_LOG(FATAL, *exception);
    }
  }
}

Subprocess::~Subprocess() noexcept(false) {
  if (pid != 0) {
    unwindDetector.catchExceptionsIfUnwinding([this]() {
      signal(SIGKILL);
      (void)waitForExitOrSignal();
    });
  }
}

void Subprocess::signal(int signo) {
  if (pid != 0) {
    KJ_SYSCALL(kill(pid, signo), name);
  }
}

void Subprocess::waitForSuccess() {
  int exitCode = waitForExit();
  KJ_ASSERT(exitCode == 0, "child process failed", name, exitCode);
}

int Subprocess::waitForExit() {
  int status = waitForExitOrSignal();
  if (WIFEXITED(status)) {
    return WEXITSTATUS(status);
  } else if (WIFSIGNALED(status)) {
    int signo = WTERMSIG(status);
    KJ_FAIL_ASSERT("child process killed by signal", name, signo, strsignal(signo));
  } else {
    KJ_FAIL_ASSERT("unknown child wait status", name, status);
  }
}

int Subprocess::waitForExitOrSignal() {
  KJ_REQUIRE(pid != 0, "already waited for this child");
  int status;
  KJ_SYSCALL(waitpid(pid, &status, 0));
  KJ_IF_MAYBE(s, subprocessSet) {
    s->alreadyReaped(pid);
  }
  pid = 0;
  return status;
}

void Subprocess::forceFdAbove(int& fd, int minValue) {
  // Force `fd` to have a numeric value of at least `minValue`.

  if (fd < minValue) {
    // We'll need to move this FD to a different slot. fcntl()'s F_DUPFD searches for a slot
    // greater than or equal to some value, which is exactly what we need! We want to set
    // O_CLOEXEC on this new FD because it is NOT the FD that we plan to keep in the child process;
    // we still plan to dup2() it back to the right slot.
    KJ_SYSCALL(fd = fcntl(fd, F_DUPFD_CLOEXEC, minValue));
  }
}

// -----------------------------------------------------------------------------

struct SubprocessSet::WaitMap {
  struct ProcInfo {
    kj::Own<kj::PromiseFulfiller<int>> fulfiller;
    Subprocess* subprocess;
  };

  std::map<pid_t, ProcInfo> pids;
};

SubprocessSet::SubprocessSet(kj::UnixEventPort& eventPort)
    : eventPort(eventPort), waitMap(kj::heap<WaitMap>()),
      waitTask(waitLoop().eagerlyEvaluate([](kj::Exception&& exception) {
        KJ_LOG(FATAL, "subprocess wait loop failed", exception);
        // The server is probably hosed by this. Best to abort.
        abort();
      })) {
  kj::UnixEventPort::captureSignal(SIGCHLD);
}

SubprocessSet::~SubprocessSet() noexcept(false) {}

kj::Promise<void> SubprocessSet::waitForSuccess(Subprocess& subprocess) {
  return waitForExit(subprocess).then([&subprocess](int exitCode) {
    KJ_ASSERT(exitCode == 0, "child process failed", subprocess.name, exitCode);
  });
}

kj::Promise<int> SubprocessSet::waitForExit(Subprocess& subprocess) {
  return waitForExitOrSignal(subprocess).then([&subprocess](int status) {
    if (WIFEXITED(status)) {
      return WEXITSTATUS(status);
    } else if (WIFSIGNALED(status)) {
      int signo = WTERMSIG(status);
      KJ_FAIL_ASSERT("child process killed by signal", subprocess.name, signo, strsignal(signo));
    } else {
      KJ_FAIL_ASSERT("unknown child wait status", subprocess.name, status);
    }
  });
}

kj::Promise<int> SubprocessSet::waitForExitOrSignal(Subprocess& subprocess) {
  auto paf = kj::newPromiseAndFulfiller<int>();
  waitMap->pids.insert(std::make_pair(subprocess.getPid(),
      WaitMap::ProcInfo { kj::mv(paf.fulfiller), &subprocess }));
  subprocess.subprocessSet = *this;
  return paf.promise.then([](int status) {
    return status;
  });
}

kj::Promise<void> SubprocessSet::waitForSuccess(Subprocess&& subprocess) {
  auto heap = kj::heap<Subprocess>(kj::mv(subprocess));
  auto promise = waitForSuccess(*heap);
  return promise.attach(kj::mv(heap));
}
kj::Promise<int> SubprocessSet::waitForExit(Subprocess&& subprocess) {
  auto heap = kj::heap<Subprocess>(kj::mv(subprocess));
  auto promise = waitForExit(*heap);
  return promise.attach(kj::mv(heap));
}
kj::Promise<int> SubprocessSet::waitForExitOrSignal(Subprocess&& subprocess) {
  auto heap = kj::heap<Subprocess>(kj::mv(subprocess));
  auto promise = waitForExitOrSignal(*heap);
  return promise.attach(kj::mv(heap));
}

kj::Promise<void> SubprocessSet::waitLoop() {
  return eventPort.onSignal(SIGCHLD).then([this](auto&&) {
    while (!waitMap->pids.empty()) {
      int status;
      pid_t pid;
      KJ_SYSCALL(pid = waitpid(-1, &status, WNOHANG));
      if (pid == 0) break;

      auto iter = waitMap->pids.find(pid);
      if (iter == waitMap->pids.end()) {
        KJ_LOG(ERROR, "waitpid() returned unexpected PID; is this process running subprocesses "
                      "outside this set?", pid);
      } else {
        iter->second.subprocess->notifyExited(status);
        iter->second.fulfiller->fulfill(kj::mv(status));
        waitMap->pids.erase(iter);
      }
    }
    return waitLoop();
  });
}

void SubprocessSet::alreadyReaped(pid_t pid) {
  waitMap->pids.erase(pid);
}

// =======================================================================================

CapRedirector::CapRedirector(kj::Function<capnp::Capability::Client()> reconnect)
    : target(reconnect()) {
  state.init<Active>(kj::mv(reconnect));
}

CapRedirector::CapRedirector(kj::PromiseFulfillerPair<capnp::Capability::Client> paf)
    : target(kj::mv(paf.promise)) {
  state.init<Passive>(kj::mv(paf.fulfiller));
}

uint CapRedirector::setTarget(capnp::Capability::Client newTarget) {
  KJ_REQUIRE(state.is<Passive>());

  ++iteration;
  target = newTarget;

  // If the previous target was a promise target, fulfill it.
  state.get<Passive>()->fulfill(kj::mv(newTarget));

  return iteration;
}

void CapRedirector::setDisconnected(uint oldIteration) {
  if (iteration == oldIteration) {
    // Our current client was disconnected.
    ++iteration;

    if (state.is<Passive>()) {
      auto paf = kj::newPromiseAndFulfiller<capnp::Capability::Client>();
      target = kj::mv(paf.promise);
      state.get<Passive>() = kj::mv(paf.fulfiller);
    } else {
      target = state.get<Active>()();
    }
  }
}

capnp::Capability::Server::DispatchCallResult CapRedirector::dispatchCall(
    uint64_t interfaceId, uint16_t methodId,
    capnp::CallContext<capnp::AnyPointer, capnp::AnyPointer> context) {
  capnp::AnyPointer::Reader params = context.getParams();
  auto req = target.typelessRequest(interfaceId, methodId, params.targetSize());
  req.set(params);

  auto oldIteration = iteration;

  auto promise = req.send().then([context](auto&& response) mutable -> kj::Promise<void> {
    context.initResults(response.targetSize()).set(response);
    return kj::READY_NOW;
  }, [this,oldIteration](kj::Exception&& e) -> kj::Promise<void> {
    if (e.getType() != kj::Exception::Type::DISCONNECTED) {
      return kj::mv(e);
    }

    // Disconnected. Did we notice already?
    if (iteration > oldIteration) {
      // Yes, so stop here.
      return kj::mv(e);
    }

    // OK, this disconnect is new to us. We need to determine if this disconnected capability
    // is our direct target or something else that was accessed as part of the call. So, send
    // a dummy call to check.
    auto ping = target.typelessRequest(0, 65535, capnp::MessageSize { 4, 0 });
    ping.initAsAnyStruct(0, 0);
    return ping.send().then([](auto&&) -> void {
      KJ_LOG(ERROR, "dummy ping request should have failed with UNIMPLEMENTED");
      // But clearly we are still connected, so don't call setDisconnected()...
    }, [this,oldIteration](kj::Exception&& e2) {
      if (e2.getType() == kj::Exception::Type::DISCONNECTED) {
        // Yep, really disconnected.
        setDisconnected(oldIteration);
      }
    }).then([KJ_MVCAP(e)]() mutable -> kj::Promise<void> {
      return kj::mv(e);
    });
  });

  // We don't need to recognize streaming calls here since we're just forwarding to another
  // capability. The final endpoint will apply stream queueing if appropriate.
  return { kj::mv(promise), false };
}

// =======================================================================================

TwoPartyServerWithClientBootstrap::TwoPartyServerWithClientBootstrap(
  capnp::Capability::Client bootstrapInterface, kj::Own<CapRedirector> redirector)
    : bootstrapInterface(kj::mv(bootstrapInterface)), redirector(kj::mv(redirector)),
      tasks(*this) {}

struct TwoPartyServerWithClientBootstrap::AcceptedConnection {
  kj::Own<kj::AsyncIoStream> connection;
  capnp::TwoPartyVatNetwork network;
  capnp::RpcSystem<capnp::rpc::twoparty::VatId> rpcSystem;

  explicit AcceptedConnection(capnp::Capability::Client bootstrapInterface,
                              kj::Own<kj::AsyncIoStream>&& connectionParam)
      : connection(kj::mv(connectionParam)),
        network(*connection, capnp::rpc::twoparty::Side::SERVER),
        rpcSystem(capnp::makeRpcServer(network, kj::mv(bootstrapInterface))) {}
};

kj::Promise<void> TwoPartyServerWithClientBootstrap::listen(
  kj::Own<kj::ConnectionReceiver>&& listener) {
  return listener->accept()
      .then([this,KJ_MVCAP(listener)](kj::Own<kj::AsyncIoStream>&& connection) mutable {
    auto connectionState = kj::heap<AcceptedConnection>(bootstrapInterface, kj::mv(connection));

    // Update the bootstrap redirector to point at the new connection's bootstrap.
    capnp::MallocMessageBuilder message(8);
    auto vatId = message.getRoot<capnp::rpc::twoparty::VatId>();
    vatId.setSide(capnp::rpc::twoparty::Side::CLIENT);
    uint iteration = redirector->setTarget(connectionState->rpcSystem.bootstrap(vatId));

    // Run the connection until disconnect.
    auto promise = connectionState->network.onDisconnect();
    tasks.add(promise.attach(kj::mv(connectionState), kj::defer([this,iteration]() {
      // Disconnect the redirector when the client disconnects.
      redirector->setDisconnected(iteration);
    })));

    return listen(kj::mv(listener));
  });
}

capnp::Capability::Client TwoPartyServerWithClientBootstrap::getBootstrap() {
  return kj::addRef(*redirector);
}

void TwoPartyServerWithClientBootstrap::taskFailed(kj::Exception&& exception) {
  KJ_LOG(ERROR, exception);
}

}  // namespace sandstorm
