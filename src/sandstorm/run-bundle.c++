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
#include <kj/io.h>
#include <kj/parse/common.h>
#include <kj/parse/char.h>
#include <sodium.h>
#include <capnp/schema.h>
#include <capnp/serialize.h>
#include <sandstorm/bundle.capnp.h>
#include <stdlib.h>
#include <signal.h>
#include <limits.h>
#include <unistd.h>
#include <sys/mount.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/signalfd.h>
#include <sys/wait.h>
#include <sys/sendfile.h>
#include <sched.h>
#include <grp.h>
#include <errno.h>
#include <fcntl.h>
#include <ctype.h>
#include <time.h>
#include <stdio.h>  // rename()
#include <sys/socket.h>
#include <netdb.h>
#include <dirent.h>

#include "version.h"

namespace sandstorm {

typedef unsigned int uint;

static constexpr kj::byte BUNDLE_SIGNING_KEY[crypto_sign_PUBLICKEYBYTES] = {
   12,  79, 127, 209, 170, 119, 107,  49,   2, 136,  32,  97, 103, 181, 111, 215,
  119,  89, 166, 151, 132,  39, 228, 187, 229, 159,  11,  43, 148, 237,  25,  26
};

constexpr const char* EXEC_END_ARGS = nullptr;

kj::String trim(kj::ArrayPtr<const char> slice) {
  while (slice.size() > 0 && isspace(slice[0])) {
    slice = slice.slice(1, slice.size());
  }
  while (slice.size() > 0 && isspace(slice[slice.size() - 1])) {
    slice = slice.slice(0, slice.size() - 1);
  }

  return kj::heapString(slice);
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

kj::AutoCloseFd raiiOpen(kj::StringPtr name, int flags, mode_t mode = 0666) {
  int fd;
  KJ_SYSCALL(fd = open(name.cStr(), flags, mode), name);
  return kj::AutoCloseFd(fd);
}

kj::AutoCloseFd openTemporary(kj::StringPtr near) {
  // Creates a temporary file in the same directory as the file specified by "near", immediately
  // unlinks it, and then returns the file descriptor,  which will be open for both read and write.

  // TODO(someday):  Use O_TMPFILE?  New in Linux 3.11.

  int fd;
  auto name = kj::str(near, ".XXXXXX");
  KJ_SYSCALL(fd = mkostemp(name.begin(), O_CLOEXEC));
  kj::AutoCloseFd result(fd);
  KJ_SYSCALL(unlink(name.cStr()));
  return result;
}

kj::Array<kj::String> listDirectory(kj::StringPtr dirname) {
  DIR* dir = opendir(dirname.cStr());
  if (dir == nullptr) {
    KJ_FAIL_SYSCALL("opendir", errno, dirname);
  }
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
        KJ_FAIL_SYSCALL("readdir", error, dirname);
      }
    }

    kj::StringPtr name = entry->d_name;
    if (name != "." && name != "..") {
      entries.add(kj::heapString(entry->d_name));
    }
  }

  return entries.releaseAsArray();
}

void recursivelyDelete(kj::StringPtr path) {
  // Delete the given path, recursively if it is a directory.
  //
  // Since this may be used in KJ_DEFER to delete temporary directories, all exceptions are
  // recoverable (won't throw if already unwinding).

  struct stat stats;
  KJ_SYSCALL(stat(path.cStr(), &stats), path) { return; }
  if (S_ISDIR(stats.st_mode)) {
    for (auto& file: listDirectory(path)) {
      recursivelyDelete(kj::str(path, "/", file));
    }
    KJ_SYSCALL(rmdir(path.cStr()), path) { break; }
  } else {
    KJ_SYSCALL(unlink(path.cStr()), path) { break; }
  }
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

kj::Array<kj::String> splitLines(kj::String input) {
  // Split the input into lines, trimming whitespace, and ignoring blank lines or lines that start
  // with #.

  size_t lineStart = 0;
  kj::Vector<kj::String> results;
  for (auto i: kj::indices(input)) {
    if (input[i] == '\n') {
      input[i] = '\0';
      auto line = trim(input.slice(lineStart, i));
      if (line.size() > 0 && !line.startsWith("#")) {
        results.add(kj::mv(line));
      }
      lineStart = i + 1;
    }
  }

  return results.releaseAsArray();
}

namespace lowercaseChannel {
  constexpr auto dev KJ_UNUSED = bundle::Channel::DEV;
  constexpr auto custom KJ_UNUSED = bundle::Channel::CUSTOM;
}

// We use SIGALRM to timeout waitpid()s.
static bool alarmed = false;
void alarmHandler(int) {
  alarmed = true;
}
void registerAlarmHandler() {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = &alarmHandler;
  KJ_SYSCALL(sigaction(SIGALRM, &action, nullptr));
}

// =======================================================================================
// id(1) handling
//
// We can't use getpwnam(), etc. in a static binary, so we shell out to id(1) instead.
// This is to set credentials to our user account before we start the server.

namespace idParser {
// A KJ parser for the output of id(1).

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wglobal-constructors"

namespace p = kj::parse;
using Input = p::IteratorInput<char, const char*>;

template <char delimiter, typename SubParser>
auto delimited(SubParser& subParser) -> decltype(auto) {
  // Create a parser that parses several instances of subParser separated by the given delimiter.

  typedef p::OutputType<SubParser, Input> Element;
  return p::transform(p::sequence(subParser,
      p::many(p::sequence(p::exactChar<delimiter>(), subParser))),
      [](Element&& first, kj::Array<Element>&& rest) {
    auto result = kj::heapArrayBuilder<Element>(rest.size() + 1);
    result.add(kj::mv(first));
    for (auto& e: rest) result.add(kj::mv(e));
    return result.finish();
  });
}

constexpr auto nameNum = p::sequence(p::integer, p::discard(p::optional(
    p::sequence(p::exactChar<'('>(), p::identifier, p::exactChar<')'>()))));

struct Assignment {
  kj::String name;
  kj::Array<uint64_t> values;
};

auto assignment = p::transform(
    p::sequence(p::identifier, p::exactChar<'='>(), delimited<','>(nameNum)),
    [](kj::String&& name, kj::Array<uint64_t>&& ids) {
  return Assignment { kj::mv(name), kj::mv(ids) };
});

auto parser = p::sequence(delimited<' '>(assignment), p::discardWhitespace, p::endOfInput);

#pragma GCC diagnostic pop

}  // namespace idParser

struct UserIds {
  uid_t uid = 0;
  gid_t gid = 0;
  kj::Array<gid_t> groups;
};

kj::Maybe<UserIds> getUserIds(kj::StringPtr name) {
  // Convert a user or group name to the equivalent ID number.  Set `flag` to "-u" for username,
  // "-g" for group name.
  //
  // We can't use getpwnam() in a statically-linked binary, so we shell out to id(1).  lol.

  int fds[2];
  KJ_SYSCALL(pipe2(fds, O_CLOEXEC));

  pid_t child;
  KJ_SYSCALL(child = fork());
  if (child == 0) {
    KJ_SYSCALL(dup2(fds[1], STDOUT_FILENO));
    KJ_SYSCALL(execlp("id", "id", name.cStr(), EXEC_END_ARGS));
    KJ_UNREACHABLE;
  }

  close(fds[1]);
  KJ_DEFER(close(fds[0]));

  auto idOutput = readAll(fds[0]);

  int status;
  KJ_SYSCALL(waitpid(child, &status, 0));
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    return nullptr;
  }

  idParser::Input input(idOutput.begin(), idOutput.end());
  KJ_IF_MAYBE(assignments, idParser::parser(input)) {
    UserIds result;
    for (auto& assignment: *assignments) {
      if (assignment.name == "uid") {
        KJ_ASSERT(assignment.values.size() == 1, "failed to parse output of id(1)", idOutput);
        result.uid = assignment.values[0];
      } else if (assignment.name == "gid") {
        KJ_ASSERT(assignment.values.size() == 1, "failed to parse output of id(1)", idOutput);
        result.gid = assignment.values[0];
      } else if (assignment.name == "groups") {
        result.groups = KJ_MAP(g, assignment.values) -> gid_t { return g; };
      }
    }

    KJ_ASSERT(result.uid != -1, "id(1) didn't return uid?", idOutput);
    KJ_ASSERT(result.gid != -1, "id(1) didn't return gid?", idOutput);
    if (result.groups.size() == 0) {
      result.groups = kj::heapArray<gid_t>(1);
      result.groups[0] = result.gid;
    }

    return kj::mv(result);
  } else {
    KJ_FAIL_ASSERT("failed to parse output of id(1)", idOutput, input.getBest() - idOutput.begin());
  }
}

// =======================================================================================
// HTTP gets
//
// Crappy HTTP GET implementation.  Only supports the narrow circumstances expected from the
// update server:
// - Always status code 200.
// - Never chunked nor compressed.
//
// We could use libcurl or shell out to real curl, but we'd have to include curl in the bundle at
// it has a bazillion dependencies.

class HttpGetStream {
public:
  HttpGetStream(kj::StringPtr host, kj::StringPtr path)
      : rawInput(startHttpGet(host, path)),
        input(rawInput) {
    auto firstLine = readLine();
    KJ_ASSERT(firstLine.startsWith("HTTP/1."));

    auto status = firstLine.slice(KJ_ASSERT_NONNULL(firstLine.findFirst(' ')) + 1);
    if (!status.startsWith("200 ")) {
      KJ_FAIL_ASSERT("unexpected http status", status);
    }

    // Skip headers.
    for (;;) {
      auto line = readLine();
      if (line.size() == 0) break;

      toLower(line);
      KJ_ASSERT(!line.startsWith("transfer-encoding:"),
          "Transfer-Encoding not supported, but server should never use it.");
      KJ_ASSERT(!line.startsWith("content-encoding:"),
          "Content-Encoding not supported, but server should never use it.");
    }
  }

  kj::String readLine() {
    kj::Vector<char> buffer(128);

    for (;;) {
      auto bytes = input.tryGetReadBuffer();
      if (bytes.size() == 0) break;  // EOF

      auto chars = kj::arrayPtr(reinterpret_cast<const char*>(bytes.begin()), bytes.size());
      for (auto i: kj::indices(chars)) {
        if (chars[i] == '\n') {
          buffer.addAll(chars.begin(), chars.begin() + i);
          input.skip(i + 1);
          break;
        }
      }

      buffer.addAll(chars);
      input.skip(bytes.size());
    }

    if (buffer.size() > 0 && buffer[buffer.size() - 1] == '\r') {
      buffer.removeLast();
    }

    buffer.add('\0');
    return kj::String(buffer.releaseAsArray());
  }

  kj::Array<kj::byte> readAll() {
    kj::Vector<kj::byte> result;
    for (;;) {
      auto buffer = input.tryGetReadBuffer();
      if (buffer.size() == 0) {
        break;
      }
      result.addAll(buffer);
      input.skip(result.size());

      // Protect against forged large payloads.
      KJ_ASSERT(result.size() < (1u << 16));
    }

    return result.releaseAsArray();
  }

  kj::ArrayPtr<const kj::byte> nextBuffer(size_t lastBufferSize) {
    input.skip(lastBufferSize);
    return input.tryGetReadBuffer();
  }

private:
  kj::FdInputStream rawInput;
  kj::BufferedInputStreamWrapper input;

  static kj::AutoCloseFd startHttpGet(kj::StringPtr host, kj::StringPtr path) {
    auto sock = connectToHost(host, "http");

    kj::FdOutputStream output(kj::implicitCast<int>(sock));
    auto request = kj::str(
        "GET ", path, " HTTP/1.1\r\n"
        "Host: ", host, "\r\n"
        "Connection: close\r\n"
        "\r\n");
    output.write(request.begin(), request.size());

    return sock;
  }

  static kj::AutoCloseFd connectToHost(kj::StringPtr host, kj::StringPtr service) {
    struct addrinfo hints;
    memset(&hints, 0, sizeof(hints));
    hints.ai_flags = AI_V4MAPPED | AI_ADDRCONFIG;
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;

    struct addrinfo* results;

    int gaiResult = getaddrinfo(host.cStr(), "http", &hints, &results);
    if (gaiResult != 0) {
      KJ_FAIL_ASSERT("getaddrinfo failed", gai_strerror(gaiResult));
    }

    KJ_DEFER(freeaddrinfo(results));

    int error = 0;
    for (auto addr = results; addr != nullptr; addr = addr->ai_next) {
      int sock;
      KJ_SYSCALL(sock = socket(addr->ai_family, addr->ai_socktype, addr->ai_protocol));
      kj::AutoCloseFd ownedSock(sock);
      if (connect(sock, addr->ai_addr, addr->ai_addrlen) == 0) {
        return ownedSock;
      }

      if (error == 0) {
        error = errno;
      }
    }

    KJ_FAIL_SYSCALL("connect", error, host, service);
  }
};

// =======================================================================================

class RunBundleMain {
  // Main class for the Sandstorm bundle runner.  This is a convenience tool for running the
  // Sandstorm binary bundle, which is a packaged chroot environment containing everything needed
  // to run a Sandstorm server.  Just unpack and run!

  struct Config;

public:
  RunBundleMain(kj::ProcessContext& context): context(context) {
    // Make sure we didn't inherit a weird signal mask from the parent process.
    clearSignalMask();
  }

  kj::MainFunc getMain() {
    static const char* VERSION = "Sandstorm version " SANDSTORM_VERSION;
    return kj::MainBuilder(context, VERSION,
            "Runs the Sandstorm chroot bundle as a daemon process as the given user. "
            "(This binary must start as root.)")
        .addSubCommand("start",
            [this]() {
              return kj::MainBuilder(context, VERSION, "Start the Sandstorm server (default).")
                  .callAfterParsing(KJ_BIND_METHOD(*this, start))
                  .build();
            },
            "Start the sandstorm server.")
        .addSubCommand("stop",
            [this]() {
              return kj::MainBuilder(context, VERSION, "Stop the Sandstorm server.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, stop))
                  .build();
            },
            "Stop the sandstorm server.")
        .addSubCommand("status",
            [this]() {
              return kj::MainBuilder(context, VERSION, "Check if Sandstorm is running.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, status))
                  .build();
            },
            "Check if Sandstorm is running. Prints the pid and exits successfully if so; "
            "exits with an error otherwise.")
        .addSubCommand("restart-frontend",
            [this]() {
              return kj::MainBuilder(context, VERSION, "Restart Sandstorm front-end.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, restartFrontend))
                  .build();
            },
            "Restarts the Sandstorm front-end, without restarting the database. May cause less "
            "downtime than a full restart would.")
        .addSubCommand("mongo",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                  "Run MongoDB shell, connecting to the an already-running Sandstorm server.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, mongo))
                  .build();
            },
            "Run MongoDB shell.")
        .addSubCommand("update",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                      "Update the Sandstorm platform to a new version. If <bundle> is provided "
                      "(something like sandstorm-1234.tar.xz) it is used as the update. "
                      "Otherwise, we securely check the web for an update.")
                  .expectOptionalArg("<bundle>", KJ_BIND_METHOD(*this, setUpdateFile))
                  .callAfterParsing(KJ_BIND_METHOD(*this, update))
                  .build();
            },
            "Update the Sandstorm platform.")
        .addSubCommand("continue",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                      "For internal use only:  Continue running Sandstorm after an update.")
                  .addOptionWithArg({"pidfile"}, KJ_BIND_METHOD(*this, setContinuePidfile),
                                    "<fd>", "FD of the (already open and locked) pidfile.")
                  .addOptionWithArg({"uid"}, KJ_BIND_METHOD(*this, setContinueUid),
                                    "<uid>", "Server user ID.")
                  .addOptionWithArg({"gid"}, KJ_BIND_METHOD(*this, setContinueGid),
                                    "<gid>", "Server group ID.")
                  .addOptionWithArg({"groups"}, KJ_BIND_METHOD(*this, setContinueGroups),
                                    "<gid1>,<gid2>,...", "Server supplementary groups.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, continue_))
                  .build();
            },
            "For internal use only.")
        .build();
  }

  kj::MainBuilder::Validity start() {
    enterChroot();

    const Config config = readConfig("/sandstorm.conf", true);

    // Check / lock the pidfile.
    auto pidfile = raiiOpen("/var/pid/sandstorm.pid", O_RDWR | O_CREAT, 0660);
    {
      struct flock lock;
      memset(&lock, 0, sizeof(lock));
      lock.l_type = F_WRLCK;
      lock.l_whence = SEEK_SET;
      lock.l_start = 0;
      lock.l_len = 0;  // entire file
      if (fcntl(pidfile, F_SETLK, &lock) < 0) {
        int error = errno;
        if (error == EACCES || error == EAGAIN) {
          context.exitInfo(kj::str("Sandstorm is already running.  PID = ", readAll(pidfile)));
        } else {
          KJ_FAIL_SYSCALL("fcntl(pidfile, F_SETLK)", error);
        }
      }

      // It's ours.  Truncate for now so we can write in the new PID later.
      KJ_SYSCALL(ftruncate(pidfile, 0));

      // Make sure ownership is correct.
      KJ_SYSCALL(fchown(pidfile, config.uids.uid, config.uids.gid));
    }

    // Unshare PID namespace so that daemon process becomes the root process of its own PID
    // namespace and therefore if it dies the whole namespace is killed.
    KJ_SYSCALL(unshare(CLONE_NEWPID));

    // Daemonize ourselves.
    pid_t mainPid;  // PID of the main process as seen *outside* the PID namespace.
    {
      int pipeFds[2];
      KJ_SYSCALL(pipe2(pipeFds, O_CLOEXEC));
      kj::AutoCloseFd pipeIn(pipeFds[0]), pipeOut(pipeFds[1]);

      KJ_SYSCALL(mainPid = fork());
      if (mainPid != 0) {
        // Tell the child process its own PID, since being in a PID namespace its own getpid() will
        // unhelpfully return 1.
        pipeIn = nullptr;
        kj::FdOutputStream(kj::mv(pipeOut)).write(&mainPid, sizeof(mainPid));

        // Write the pidfile before exiting.
        {
          auto pidstr = kj::str(mainPid, '\n');
          kj::FdOutputStream((int)pidfile).write(pidstr.begin(), pidstr.size());
        }

        // Exit success.
        context.exitInfo(kj::str("server started; PID = ", mainPid));
        return true;
      }

      // Read our (global) PID in from the parent process.
      pipeOut = nullptr;
      kj::FdInputStream(kj::mv(pipeIn)).read(&mainPid, sizeof(mainPid));
    }

    // Since we unshared the PID namespace, the first fork() should have produced pid 1 in the
    // new namespace.  That means that if this pid ever exits, everything under it dies.  That's
    // perfect!  Otherwise we'd have to carefully kill node and mongo separately.
    KJ_ASSERT(getpid() == 1, "unshare(CLONE_NEWPID) didn't do what I expected.", getpid());

    // Lock the pidfile and make sure it still belongs to us.
    //
    // We need to wait for the parent process to release its lock, so we use F_SETLKW.
    // However, if another Sandstorm server is started simultaneously and manages to steal
    // ownership, we want to detect this and exit, so we take a shared (read-only) lock.
    {
      struct flock lock;
      memset(&lock, 0, sizeof(lock));
      lock.l_type = F_RDLCK;
      lock.l_whence = SEEK_SET;
      lock.l_start = 0;
      lock.l_len = 0;  // entire file
      KJ_SYSCALL(fcntl(pidfile, F_SETLKW, &lock));

      // Verify that we still own the file.
      KJ_SYSCALL(lseek(pidfile, 0, SEEK_SET));
      pid_t pidfilePid = KJ_ASSERT_NONNULL(parseUInt(trim(readAll(pidfile)), 10));
      if (pidfilePid != mainPid) {
        context.exitInfo(kj::str(
            "Oops, Sandstorm PID ", pidfilePid, " just started. "
            "PID ", mainPid, " exiting in deference."));
      }
    }

    pidfileFd = pidfile;
    return continueWithConfig(config);
  }

  kj::MainBuilder::Validity continue_() {
    if (getpid() != 1) {
      return "This command is only for internal use.";
    }

    if (continueUids.uid == 0 || pidfileFd < 0) {
      return "Some required parameters were missing.";
    }

    if (continueUids.groups.size() == 0) {
      continueUids.groups = kj::heapArray<gid_t>(1);
      continueUids.groups[0] = continueUids.gid;
    }

    Config config = readConfig("/sandstorm.conf", false);
    config.uids = kj::mv(continueUids);
    return continueWithConfig(config);
  }

  kj::MainBuilder::Validity continueWithConfig(const Config& config) {
    pid_t updaterPid = startUpdater(config);

    // Set pidfile to close-on-exec now that we're in the child proc.
    KJ_SYSCALL(fcntl(pidfileFd, F_SETFD, FD_CLOEXEC));

    // For later use when killing children.
    registerAlarmHandler();

    // We can mount /proc now that we're in the new pid namespace.
    KJ_SYSCALL(mount("proc", "proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, ""));

    umask(0007);

    // Redirect stdio.
    {
      auto logFd = raiiOpen("/var/log/sandstorm.log", O_WRONLY | O_APPEND | O_CREAT, 0660);
      KJ_SYSCALL(fchown(logFd, config.uids.uid, config.uids.gid));
      KJ_SYSCALL(dup2(logFd, STDOUT_FILENO));
      KJ_SYSCALL(dup2(logFd, STDERR_FILENO));
    }
    {
      auto nullFd = raiiOpen("/dev/null", O_RDONLY);
      KJ_SYSCALL(dup2(nullFd, STDIN_FILENO));
    }

    // Detach from controlling terminal and make ourselves session leader.
    KJ_SYSCALL(setsid());

    // Set up signal mask to catch events that should lead to shutdown.
    sigset_t sigmask;
    KJ_SYSCALL(sigemptyset(&sigmask));
    KJ_SYSCALL(sigaddset(&sigmask, SIGTERM));
    KJ_SYSCALL(sigaddset(&sigmask, SIGCHLD));
    KJ_SYSCALL(sigaddset(&sigmask, SIGHUP));
    KJ_SYSCALL(sigaddset(&sigmask, SIGUSR2));
    KJ_SYSCALL(sigprocmask(SIG_BLOCK, &sigmask, nullptr));

    // Receive signals on a signalfd.
    int sigfd;
    KJ_SYSCALL(sigfd = signalfd(-1, &sigmask, SFD_CLOEXEC));

    context.warning("** Starting MongoDB...");
    pid_t mongoPid = startMongo(config);
    int64_t mongoStartTime = getTime();

    context.warning("** Mongo started; now starting front-end...");
    pid_t nodePid = startNode(config);
    int64_t nodeStartTime = getTime();

    for (;;) {
      // Wait for a signal -- any signal.
      struct signalfd_siginfo siginfo;
      KJ_SYSCALL(read(sigfd, &siginfo, sizeof(siginfo)));

      if (siginfo.ssi_signo == SIGCHLD) {
        // Some child exited.  If it's Mongo or Node we have a problem, but it could also be some
        // grandchild that was orphaned and thus reparented to the PID namespace's init process,
        // which is us.

        // Reap zombies until there are no more.
        bool mongoDied = false;
        bool nodeDied = false;
        bool updaterDied = false;
        for (;;) {
          int status;
          pid_t deadPid = waitpid(-1, &status, WNOHANG);
          if (deadPid <= 0) {
            // No more zombies.
            break;
          } else if (deadPid == mongoPid) {
            mongoDied = true;
          } else if (deadPid == nodePid) {
            nodeDied = true;
          } else if (deadPid == updaterPid) {
            updaterDied = true;
          }
        }

        // Deal with mongo or node dying.
        if (mongoDied) {
          maybeWaitAfterChildDeath("MongoDB", mongoStartTime);
          mongoPid = startMongo(config);
          mongoStartTime = getTime();
        } else if (nodeDied) {
          maybeWaitAfterChildDeath("Front-end", nodeStartTime);
          nodePid = startNode(config);
          nodeStartTime = getTime();
        } else if (updaterDied) {
          if (access("/versions/next", F_OK) == 0) {
            restartForUpdate(config, nodePid, mongoPid);
            KJ_UNREACHABLE;
          } else {
            updaterPid = startUpdater(config);
          }
        }
      } else {
        if (siginfo.ssi_signo == SIGHUP) {
          context.warning("** SIGHUP ** Restarting front-end **");
          killChild("Front-end", nodePid);
          nodePid = startNode(config);
          nodeStartTime = getTime();
        } else if (siginfo.ssi_signo == SIGUSR2) {
          if (access("/versions/next", F_OK) == 0) {
            if (updaterPid != 0) {
              KJ_SYSCALL(kill(updaterPid, SIGKILL));
            }
            restartForUpdate(config, nodePid, mongoPid);
            KJ_UNREACHABLE;
          }
        } else {
          // SIGTERM or something.
          context.warning("** SIGTERM ** Shutting down");
          killChild("Front-end", nodePid);
          killChild("MongoDB", mongoPid);
          context.exitInfo("** Exiting");
        }
      }
    }
  }

  kj::MainBuilder::Validity stop() {
    registerAlarmHandler();

    kj::AutoCloseFd pidfile = nullptr;
    KJ_IF_MAYBE(pf, openPidfileOutsideChroot()) {
      pidfile = kj::mv(*pf);
    } else {
      context.exitInfo("Sandstorm is not running.");
    }

    pid_t pid;
    KJ_IF_MAYBE(p, getRunningPid(pidfile)) {
      pid = *p;
    } else {
      context.exitInfo("Sandstorm is not running.");
    }

    context.warning(kj::str("Waiting for PID ", pid, " to terminate..."));
    KJ_SYSCALL(kill(pid, SIGTERM));

    // Timeout if not dead within 10 seconds.
    uint timeout = 10;
    KJ_SYSCALL(alarm(timeout));

    // Take write lock on pidfile as a way to wait for exit.
    struct flock lock;
    memset(&lock, 0, sizeof(lock));
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    lock.l_start = 0;
    lock.l_len = 0;  // entire file

    for (;;) {
      if (fcntl(pidfile, F_SETLKW, &lock) >= 0) {
        // Success.
        break;
      }

      int error = errno;
      if (error == EINTR) {
        if (alarmed) {
          context.warning(kj::str("Did not terminate after ", timeout, " seconds; killing..."));
          KJ_SYSCALL(kill(pid, SIGKILL));
          alarmed = false;
        } else {
          // Ignore signal.
        }
      } else {
        KJ_FAIL_SYSCALL("fcntl(pidfile, F_SETLKW)", error);
      }
    }

    context.exitInfo("Sandstorm server stopped.");
  }

  kj::MainBuilder::Validity status() {
    KJ_IF_MAYBE(pid, getRunningPid()) {
      context.exitInfo(kj::str("Sandstorm is running; PID = ", *pid));
    } else {
      context.exitError("Sandstorm is not running.");
    }
  }

  kj::MainBuilder::Validity restartFrontend() {
    KJ_IF_MAYBE(pid, getRunningPid()) {
      KJ_SYSCALL(kill(*pid, SIGHUP));
      context.exit();
    } else {
      context.exitError("Sandstorm is not running.");
    }
  }

  kj::MainBuilder::Validity mongo() {
    // Verify that Sandstorm is running.
    if (getRunningPid() == nullptr) {
      context.exitError("Sandstorm is not running.");
    }

    // We'll run under the chroot.
    enterChroot();

    const Config config = readConfig("/sandstorm.conf", true);

    // Mount /proc, because Mongo likes it.
    KJ_SYSCALL(mount("proc", "proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, ""));

    // Don't run as root.
    dropPrivs(config.uids);

    // OK, run the Mongo client!
    KJ_SYSCALL(execl("/bin/mongo", "/bin/mongo",
                     kj::str("127.0.0.1:", config.mongoPort, "/meteor").cStr(), EXEC_END_ARGS));
    KJ_UNREACHABLE;
  }

  kj::MainBuilder::Validity update() {
    if (updateFile == nullptr) {
      enterChroot();
      if (!checkForUpdates("manual")) {
        context.exit();
      }
    } else {
      auto fd = raiiOpen(updateFile, O_RDONLY);
      enterChroot();
      unpackUpdate(kj::mv(fd));
    }

    KJ_IF_MAYBE(pid, getRunningPidInsideChroot()) {
      context.warning("Update ready, but Sandstorm is running. Asking it to restart...");
      KJ_SYSCALL(kill(*pid, SIGUSR2));

      for (uint i = 0; i < 10; i++) {
        sleep(1);
        if (access("/versions/next", F_OK) == 0) {
          context.exitInfo("Update complete.");
          return true;
        }
      }

      context.exitError("Update was not accepted after 10 seconds. It may take later?");
    } else {
      swapVersion();
      context.exitInfo("Update complete.");
    }
  }

private:
  kj::ProcessContext& context;

  struct Config {
    uint port = 3000;
    uint mongoPort = 3001;
    UserIds uids;
    kj::String bindIp = kj::str("127.0.0.1");
    kj::String rootUrl = nullptr;
    kj::String mailUrl = nullptr;
    bool autoUpdate = false;
  };

  kj::String updateFile;
  int pidfileFd = -1;
  UserIds continueUids;

  kj::String getRootDir() {
    char buf[PATH_MAX + 1];
    size_t len;
    KJ_SYSCALL(len = readlink("/proc/self/exe", buf, sizeof(buf) - 1));
    buf[len] = '\0';

    uint numSlashes = 0;
    for (char* ptr = buf + len; ptr >= buf; ptr--) {
      if (*ptr == '/') {
        ++numSlashes;
        if (numSlashes == 1) {
          // Strip off the last component of the path (the filename).
          *ptr = '\0';
          len = ptr - buf;
        } else if (numSlashes == 3) {
          // Strip off "/versions/sandstorm-nnnn".
          if (kj::StringPtr(ptr).startsWith("/versions/sandstorm-")) {
            *ptr = '\0';
            len = ptr - buf;
          }
          break;
        }
      }
    }

    if (len == 0) {
      // Replace empty string with "/".
      buf[0] = '/';
      buf[1] = '\0';
      len = 1;
    }

    auto guess = kj::heapString(buf);

    // Verify that we got it right.
    KJ_SYSCALL(access(kj::str(guess, "/sandstorm").cStr(), F_OK),
        "couldn't figure out root directory of sandstorm bundle", guess);
    KJ_SYSCALL(access(kj::str(guess, "/sandstorm.conf").cStr(), F_OK),
        "couldn't figure out root directory of sandstorm bundle", guess);

    return kj::mv(guess);
  }

  void checkOwnedByRoot(kj::StringPtr path, kj::StringPtr title) {
    if (access(path.cStr(), F_OK) != 0) {
      context.exitError(kj::str(title, " not found.  Did you run setup.sh?"));
    }

    struct stat stats;
    KJ_SYSCALL(stat(path.cStr(), &stats));
    if (stats.st_uid != 0) {
      context.exitError(kj::str(title, " not owned by root.  Did you run setup.sh?"));
    }
  }

  kj::Maybe<kj::AutoCloseFd> openPidfileOutsideChroot() {
    auto dir = getRootDir();
    auto pidfileName = kj::str(dir, "/var/pid/sandstorm.pid");
    if (access(pidfileName.cStr(), F_OK) < 0) {
      return nullptr;
    }
    return raiiOpen(pidfileName, O_RDWR);
  }

  kj::AutoCloseFd openPidfileInsideChroot() {
    if (access("/var/pid/sandstorm.pid", F_OK) < 0) {
      return nullptr;
    }
    return raiiOpen("/var/pid/sandstorm.pid", O_RDWR);
  }

  kj::Maybe<pid_t> getRunningPid() {
    return getRunningPid(openPidfileOutsideChroot());
  }

  kj::Maybe<pid_t> getRunningPidInsideChroot() {
    return getRunningPid(openPidfileInsideChroot());
  }

  kj::Maybe<pid_t> getRunningPid(kj::Maybe<kj::AutoCloseFd> pidfile) {
    KJ_IF_MAYBE(pf, pidfile) {
      return getRunningPid(*pf);
    } else {
      return nullptr;
    }
  }

  kj::Maybe<pid_t> getRunningPid(kj::AutoCloseFd& pidfile) {
    struct flock lock;
    memset(&lock, 0, sizeof(lock));
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    lock.l_start = 0;
    lock.l_len = 0;  // entire file
    KJ_SYSCALL(fcntl(pidfile, F_GETLK, &lock));

    if (lock.l_type == F_UNLCK) {
      return nullptr;
    }

    // The pidfile is locked, therefore someone is using it.
    pid_t lockingPid = lock.l_pid;

    // Let's also read the content of the file and make sure it matches.
    pid_t pidfilePid;
    KJ_IF_MAYBE(p, parseUInt(trim(readAll(pidfile)), 10)) {
      pidfilePid = *p;
    } else {
      pidfilePid = -1;
    }

    if (lockingPid != pidfilePid) {
      // We probably caught it just as it was starting up.  People probably shouldn't be telling
      // it to shut down in these circumstances anyway.
      return nullptr;
    }

    return lockingPid;
  }

  int64_t getTime() {
    struct timespec ts;
    KJ_SYSCALL(clock_gettime(CLOCK_MONOTONIC, &ts));
    return ts.tv_sec * 1000000000ll + ts.tv_nsec;
  }

  void enterChroot() {
    if (getuid() != 0) {
      context.exitError(
          "You must run this program as root, so that it can chroot.  The actual live server "
          "will not run as root.");
    }

    // Determine the directory containing the executable.
    auto dir = getRootDir();

    // Verify ownership is intact.
    checkOwnedByRoot(kj::str(dir, "/sandstorm.conf"), "Config file");
    checkOwnedByRoot(kj::str(dir, "/sandstorm"), "Executable");
    checkOwnedByRoot(dir, "Bundle directory");

    // If `dir` is empty, the executable is already in the root directory.  Otherwise, we want to
    // set up a chroot environment.
    if (dir.size() != 0) {
      // Unshare the mount namespace, so we can create some private bind mounts.
      KJ_SYSCALL(unshare(CLONE_NEWNS));

      // To really unshare the mount namespace, we also have to make sure all mounts are private.
      // The parameters here were derived by strace'ing `mount --make-rprivate /`.  AFAICT the flags
      // are undocumented.  :(
      KJ_SYSCALL(mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr));

      // Bind /dev into our chroot environment.
      KJ_SYSCALL(mount("/dev", kj::str(dir, "/dev").cStr(), nullptr, MS_BIND, nullptr));

      // Mount a tmpfs at /etc and copy over necessary config files from the host.
      KJ_SYSCALL(mount("tmpfs", kj::str(dir, "/etc").cStr(), "tmpfs",
                       MS_NOATIME | MS_NOSUID | MS_NOEXEC,
                       kj::str("size=2m,nr_inodes=128,mode=755,uid=0,gid=0").cStr()));
      copyEtc(dir);

      // OK, enter the chroot.
      KJ_SYSCALL(chroot(dir.cStr()));
      KJ_SYSCALL(chdir("/"));
    }

    // Set up path.
    KJ_SYSCALL(setenv("PATH", "/usr/bin:/bin", true));
    KJ_SYSCALL(setenv("LD_LIBRARY_PATH", "/usr/local/lib:/usr/lib:/lib", true));
  }

  void dropPrivs(const UserIds& uids) {
    KJ_SYSCALL(setresgid(uids.gid, uids.gid, uids.gid));
    KJ_SYSCALL(setgroups(uids.groups.size(), uids.groups.begin()));
    KJ_SYSCALL(setresuid(uids.uid, uids.uid, uids.uid));
  }

  void clearSignalMask() {
    sigset_t sigset;
    KJ_SYSCALL(sigemptyset(&sigset));
    KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigset, nullptr));
  }

  void copyEtc(kj::StringPtr dir) {
    auto files = splitLines(readAll(kj::str(dir, "/etc.list")));

    // Now copy over each file.
    for (auto& file: files) {
      if (access(file.cStr(), R_OK) == 0) {
        auto in = raiiOpen(file, O_RDONLY);
        auto out = raiiOpen(kj::str(dir, file), O_WRONLY | O_CREAT | O_EXCL);
        ssize_t n;
        do {
          KJ_SYSCALL(n = sendfile(out, in, nullptr, 1 << 20));
        } while (n > 0);
      }
    }
  }

  Config readConfig(kj::StringPtr path, bool parseUids) {
    // Read and return the config file.
    //
    // If parseUids is true, we initialize `uids` from SERVER_USER.  This requires shelling
    // out to id(1).  If false, we ignore SERVER_USER.

    Config config;
    bool sawUser = false;

    auto lines = splitLines(readAll(path));
    for (auto& line: lines) {
      auto equalsPos = KJ_ASSERT_NONNULL(line.findFirst('='), "Invalid config line", line);
      auto key = trim(line.slice(0, equalsPos));
      auto value = trim(line.slice(equalsPos + 1));

      if (key == "SERVER_USER") {
        sawUser = true;
        if (parseUids) {
          KJ_IF_MAYBE(u, getUserIds(value)) {
            config.uids = kj::mv(*u);
            KJ_REQUIRE(config.uids.uid != 0, "Sandstorm cannot run as root.");
          } else {
            KJ_FAIL_REQUIRE("invalid config value SERVER_USER", value);
          }
        }
      } else if (key == "PORT") {
        KJ_IF_MAYBE(p, parseUInt(value, 10)) {
          config.port = *p;
        } else {
          KJ_FAIL_REQUIRE("invalid config value PORT", value);
        }
      } else if (key == "MONGO_PORT") {
        KJ_IF_MAYBE(p, parseUInt(value, 10)) {
          config.mongoPort = *p;
        } else {
          KJ_FAIL_REQUIRE("invalid config value MONGO_PORT", value);
        }
      } else if (key == "BIND_IP") {
        config.bindIp = kj::mv(value);
      } else if (key == "BASE_URL") {
        config.rootUrl = kj::mv(value);
      } else if (key == "MAIL_URL") {
        config.mailUrl = kj::mv(value);
      } else if (key == "AUTO_UPDATE") {
        auto lower = kj::heapString(value);
        toLower(lower);
        config.autoUpdate = lower == "yes" || lower == "true";
      }
    }

    KJ_REQUIRE(sawUser, "config missing SERVER_USER");

    return config;
  }

  pid_t startMongo(const Config& config) {
    pid_t outerPid;
    KJ_SYSCALL(outerPid = fork());
    if (outerPid == 0) {
      clearSignalMask();
      dropPrivs(config.uids);
      KJ_SYSCALL(execl("/bin/mongod", "/bin/mongod", "--fork",
          "--bind_ip", "127.0.0.1", "--port", kj::str(config.mongoPort).cStr(),
          "--dbpath", "/var/mongo", "--logpath", "/var/log/mongo.log",
          "--pidfilepath", "/var/pid/mongo.pid",
          "--noauth", "--nohttpinterface", "--noprealloc", "--nopreallocj", "--smallfiles",
          EXEC_END_ARGS));
      KJ_UNREACHABLE;
    }

    // Wait for mongod to return, meaning the database is up.  Then get its real pid via the
    // pidfile.
    int status;
    KJ_SYSCALL(waitpid(outerPid, &status, 0));
    return KJ_ASSERT_NONNULL(parseUInt(trim(readAll("/var/pid/mongo.pid")), 10));
  }

  pid_t startNode(const Config& config) {
    pid_t result;
    KJ_SYSCALL(result = fork());
    if (result == 0) {
      clearSignalMask();
      dropPrivs(config.uids);
      KJ_SYSCALL(setenv("PORT", kj::str(config.port).cStr(), true));
      KJ_SYSCALL(setenv("MONGO_URL",
          kj::str("mongodb://127.0.0.1:", config.mongoPort, "/meteor").cStr(), true));
      KJ_SYSCALL(setenv("BIND_IP", config.bindIp.cStr(), true));
      if (config.mailUrl != nullptr) {
        KJ_SYSCALL(setenv("MAIL_URL", config.mailUrl.cStr(), true));
      }
      if (config.rootUrl == nullptr) {
        if (config.port == 80) {
          KJ_SYSCALL(setenv("ROOT_URL", kj::str("http://", config.bindIp).cStr(), true));
        } else {
          KJ_SYSCALL(setenv("ROOT_URL",
              kj::str("http://", config.bindIp, ":", config.port).cStr(), true));
        }
      } else {
        KJ_SYSCALL(setenv("ROOT_URL", config.rootUrl.cStr(), true));
      }
      KJ_SYSCALL(execl("/bin/node", "/bin/node", "main.js", EXEC_END_ARGS));
      KJ_UNREACHABLE;
    }

    return result;
  }

  void maybeWaitAfterChildDeath(kj::StringPtr title, int64_t startTime) {
    if (getTime() - startTime < 10ll * 1000 * 1000 * 1000) {
      context.exitError(kj::str(
          "** ", title, " died immediately after starting.\n"
          "** Sleeping for a bit before trying again..."));

      // Sleep for 10 seconds to avoid burning resources on a restart loop.
      usleep(10 * 1000 * 1000);
    } else {
      context.exitError(kj::str("** ", title, " died! Restarting it..."));
    }
  }

  void killChild(kj::StringPtr title, pid_t pid) {
    int status;

    KJ_SYSCALL(kill(pid, SIGTERM));

    alarmed = false;
    uint timeout = 5;
    KJ_SYSCALL(alarm(timeout));

    for (;;) {
      if (waitpid(pid, &status, 0) >= 0) {
        KJ_SYSCALL(alarm(0));
        return;
      }

      int error = errno;
      if (error == EINTR) {
        if (alarmed) {
          // Termination timed out.  Kill hard.
          context.warning(kj::str(
              title, " did not terminate after ", timeout, " seconds; killing."));
          KJ_SYSCALL(kill(pid, SIGKILL));
          alarmed = false;
        } else {
          // Some other signal; ignore.
        }
      } else {
        KJ_FAIL_SYSCALL("waitpid()", error, title);
      }
    }
  }

  bool checkForUpdates(kj::StringPtr type) {
    KJ_ASSERT(SANDSTORM_BUILD > 0, "Updates not supported for trunk builds.");

    constexpr auto updateChannel = lowercaseChannel::SANDSTORM_CHANNEL;

    kj::Array<capnp::word> verifiedUpdateInfoBuffer = nullptr;
    kj::ArrayPtr<capnp::word> verifiedUpdateInfo;

    {
      // GET updates.sandstorm.io/$channel?from=$version&type=[manual|auto]
      //     -> result is nacl-signed UpdateInfo (bundle.capnp)
      auto channelName = capnp::Schema::from<bundle::Channel>()
          .getEnumerants()[static_cast<uint>(updateChannel)].getProto().getName();
      context.warning("Checking for updates...");
      HttpGetStream updateCheck("updates.sandstorm.io",
          kj::str("/", channelName, "?from=", SANDSTORM_BUILD, "&type=", type));
      auto content = updateCheck.readAll();

      // Check signature.
      verifiedUpdateInfoBuffer = kj::heapArray<capnp::word>(
          content.size() / sizeof(capnp::word) + 1);
      unsigned long long length;
      int verifyResult = crypto_sign_open(
          reinterpret_cast<kj::byte*>(verifiedUpdateInfoBuffer.begin()), &length,
          content.begin(), content.size(), BUNDLE_SIGNING_KEY);
      KJ_ASSERT(verifyResult == 0, "Signature check failed.");

      verifiedUpdateInfo = verifiedUpdateInfo.slice(0, length / sizeof(capnp::word));
    }

    // Parse UpdateInfo.
    capnp::FlatArrayMessageReader message(verifiedUpdateInfo);
    auto updateInfo = message.getRoot<bundle::UpdateInfo>();

    KJ_ASSERT(updateInfo.getChannel() == updateChannel &&
              updateInfo.getFromMinBuild() <= SANDSTORM_BUILD &&
              updateInfo.getBuild() >= SANDSTORM_BUILD,
              "Received inappropriate UpdateInfo; replay attack?");
    if (updateInfo.getBuild() == SANDSTORM_BUILD) {
      context.warning("No update available.");
      return false;
    }

    // Start http request to download bundle.
    auto host = "dl.sandstorm.io";
    auto remotePath = kj::str("/sandstorm-", updateInfo.getBuild(), ".tar.xz");
    context.warning(kj::str("Fetching: ", host, remotePath));
    HttpGetStream bundle(host, remotePath);

    // Open temporary output file.
    auto outFd = openTemporary("/versions/next");
    kj::FdOutputStream out(kj::implicitCast<int>(outFd));

    // Prepare to hash it.
    crypto_hash_sha256_state hashState;
    crypto_hash_sha256_init(&hashState);

    // Do the transfer.
    kj::ArrayPtr<const kj::byte> buffer;
    size_t totalSize = 0;
    for (;;) {
      buffer = bundle.nextBuffer(buffer.size());
      if (buffer.size() == 0) break;
      totalSize += buffer.size();
      KJ_ASSERT(totalSize <= updateInfo.getSize(), "Bundle file has wrong size.");

      crypto_hash_sha256_update(&hashState, buffer.begin(), buffer.size());
      out.write(buffer.begin(), buffer.size());
    }
    KJ_ASSERT(totalSize == updateInfo.getSize(), "Bundle file has wrong size.");

    // Check the hash.
    kj::byte actualHash[crypto_hash_sha256_BYTES];
    crypto_hash_sha256_final(&hashState, actualHash);
    KJ_ASSERT(updateInfo.getHash().size() == crypto_hash_sha256_BYTES);
    if (memcmp(updateInfo.getHash().begin(), actualHash, crypto_hash_sha256_BYTES) != 0) {
      KJ_FAIL_ASSERT("Downloaded bundle hash did not match expected.");
    }

    // Verification succeeded.  Send to tar.
    context.warning("Update downoaded and verified. Unpacking...");
    KJ_SYSCALL(lseek(outFd, 0, SEEK_SET));
    unpackUpdate(kj::mv(outFd), updateInfo.getBuild());

    return true;
  }

  void unpackUpdate(kj::AutoCloseFd bundleFd, uint expectedBuild = 0) {
    char tmpdir[] = "/versions/unpack.XXXXXX";
    KJ_ASSERT(mkdtemp(tmpdir) == tmpdir);
    KJ_DEFER(recursivelyDelete(tmpdir));

    pid_t child;
    KJ_SYSCALL(child = fork());
    if (child == 0) {
      KJ_SYSCALL(dup2(bundleFd, STDIN_FILENO));
      KJ_SYSCALL(chdir(tmpdir));
      KJ_SYSCALL(execlp("tar", "tar", "Jx", EXEC_END_ARGS));
      KJ_UNREACHABLE;
    }

    int status;
    KJ_SYSCALL(waitpid(child, &status, 0));
    KJ_ASSERT(WIFEXITED(status) && WEXITSTATUS(status) == 0, "untar bundle failed");

    auto dirList = listDirectory(tmpdir);
    KJ_ASSERT(dirList.size() == 1, "invalid update bundle");

    kj::StringPtr name = dirList[0];
    KJ_ASSERT(name.startsWith("sandstorm-"), "invalid update bundle");

    uint build = KJ_ASSERT_NONNULL(parseUInt(name.slice(strlen("sandstorm-")), 10),
                                   "invalid update bundle");
    if (expectedBuild != 0) {
      KJ_ASSERT(build == expectedBuild, "downloaded bundle's build number didn't match expected");
    }

    if (rename(kj::str(tmpdir, "/", name).cStr(), kj::str("/versions/", name).cStr()) < 0) {
      int error = errno;
      if (error == EEXIST) {
        context.warning("It looks like this version was downloaded previously.");
      } else {
        KJ_FAIL_SYSCALL("rename(download, target)", error);
      }
    }

    // Make sure that root directory symlinks exist corresponding to all files in the new update.
    // Note that the symlinks point to versions/current even though we haven't updated that to point
    // to the new version yet.  That's fine; if the symlinks are new, then the old version isn't
    // using them anyway.
    for (auto& file: listDirectory(kj::str("/versions/", name))) {
      if (symlink(kj::str("/versions/current/", file).cStr(), kj::str("/", file).cStr()) < 0) {
        int error = errno;
        if (error != EEXIST) {
          context.error(kj::str(
              "symlink(/verisons/current/", file, ", /", file, ") failed: ", strerror(error)));
        }
      }
    }

    // Atomically update "next" to point to the new version.  If multiple updates happened
    // concurrently somehow, then another process might be renaming "next" to "current" as we speak.
    // It doesn't matter which version they get, because we'll send another signal to request
    // another update either way.
    auto tmpLink = kj::str(tmpdir, ".lnk");
    KJ_SYSCALL(symlink(name.cStr(), tmpLink.cStr()));
    KJ_SYSCALL(rename(tmpLink.cStr(), "/versions/next"));
  }

  void swapVersion() {
    KJ_SYSCALL(rename("/versions/next", "/versions/current"));
  }

  pid_t startUpdater(const Config& config) {
    if (config.autoUpdate && lowercaseChannel::SANDSTORM_CHANNEL == bundle::Channel::DEV) {
      pid_t pid = fork();
      if (pid == 0) {
        close(pidfileFd);
        doUpdateLoop();
      }
      return pid;
    } else {
      return 0;
    }
  }

  void doUpdateLoop() KJ_NORETURN {
    // This is the updater process.  Run in a loop.
    auto log = raiiOpen("/var/log/updater.log", O_WRONLY | O_APPEND | O_CREAT);
    KJ_SYSCALL(dup2(log, STDOUT_FILENO));
    KJ_SYSCALL(dup2(log, STDERR_FILENO));

    // Wait 10 minutes before the first update attempt just to make sure the server isn't going
    // to be shut down right away.
    uint n = 600;
    while (n > 0) n = sleep(n);

    // Distinguish between these 10-minute requests and long-lived servers.
    kj::StringPtr type = "startup";

    for (;;) {
      // Print time.
      time_t now;
      time(&now);
      context.warning(kj::str("** Time: ", ctime(&now)));

      // Check for updates.
      if (checkForUpdates(type)) {
        // Exit so that the update can be applied.
        context.exit();
      }

      // Wait a day.
      n = 86400;
      while (n > 0) n = sleep(n);
      type = "daily";
    }
  }

  void restartForUpdate(const Config& config, pid_t nodePid, pid_t mongoPid) KJ_NORETURN {
    context.warning("** Restarting to apply update **");
    killChild("Front-end", nodePid);
    killChild("MongoDB", mongoPid);
    swapVersion();

    // We need to remove FD_CLOEXEC from the pidfile FD so that it survives the exec.
    KJ_SYSCALL(fcntl(pidfileFd, F_SETFD, 0));

    // Exec the new version with our magic "continue".
    KJ_SYSCALL(execl("/sandstorm", "continue",
        kj::str("--pidfile=", pidfileFd).cStr(),
        kj::str("--uid=", config.uids.uid).cStr(),
        kj::str("--gid=", config.uids.gid).cStr(),
        kj::str("--groups=", kj::strArray(config.uids.groups, ",")).cStr(),
        EXEC_END_ARGS));
    KJ_UNREACHABLE;
  }

  // ---------------------------------------------------------------------------

  kj::MainBuilder::Validity setUpdateFile(kj::StringPtr arg) {
    if (access(arg.cStr(), F_OK) == 0) {
      updateFile = kj::heapString(arg);
      return true;
    } else {
      return "file not found";
    }
  }

  kj::MainBuilder::Validity setContinuePidfile(kj::StringPtr arg) {
    KJ_IF_MAYBE(fd, parseUInt(arg, 10)) {
      pidfileFd = *fd;
      return true;
    } else {
      return "expected integer";
    }
  }

  kj::MainBuilder::Validity setContinueUid(kj::StringPtr arg) {
    KJ_IF_MAYBE(i, parseUInt(arg, 10)) {
      continueUids.uid = *i;
      return true;
    } else {
      return "expected integer";
    }
  }

  kj::MainBuilder::Validity setContinueGid(kj::StringPtr arg) {
    KJ_IF_MAYBE(i, parseUInt(arg, 10)) {
      continueUids.gid = *i;
      return true;
    } else {
      return "expected integer";
    }
  }

  kj::MainBuilder::Validity setContinueGroups(kj::StringPtr arg) {
    kj::Vector<gid_t> groups;

    while (arg.size() > 0) {
      kj::ArrayPtr<const char> slice;
      KJ_IF_MAYBE(pos, arg.findFirst(',')) {
        slice = arg.slice(0, *pos);
        arg = arg.slice(*pos + 1);
      } else {
        slice = arg;
        arg = nullptr;
      }

      KJ_IF_MAYBE(i, parseUInt(kj::heapString(slice), 10)) {
        groups.add(*i);
      } else {
        return "expected integer";
      }
    }

    continueUids.groups = groups.releaseAsArray();
    return true;
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::RunBundleMain)
