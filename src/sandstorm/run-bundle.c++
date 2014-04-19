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
#include <sys/prctl.h>
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

kj::AutoCloseFd prepareMonitoringLoop() {
  // Prepare to run a loop where we monitor some children and also receive signals.  Returns a
  // signalfd.

  // Set up signal mask to catch events that should lead to shutdown.
  sigset_t sigmask;
  KJ_SYSCALL(sigemptyset(&sigmask));
  KJ_SYSCALL(sigaddset(&sigmask, SIGTERM));
  KJ_SYSCALL(sigaddset(&sigmask, SIGCHLD));
  KJ_SYSCALL(sigaddset(&sigmask, SIGHUP));
  KJ_SYSCALL(sigprocmask(SIG_BLOCK, &sigmask, nullptr));

  // Receive signals on a signalfd.
  int sigfd;
  KJ_SYSCALL(sigfd = signalfd(-1, &sigmask, SFD_CLOEXEC));
  return kj::AutoCloseFd(sigfd);
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

class CurlRequest {
public:
  explicit CurlRequest(kj::StringPtr url): url(kj::heapString(url)) {
    int pipeFds[2];
    KJ_SYSCALL(pipe(pipeFds));
    kj::AutoCloseFd pipeInput(pipeFds[0]), pipeOutput(pipeFds[1]);

    KJ_SYSCALL(pid = fork());
    if (pid == 0) {
      KJ_SYSCALL(dup2(pipeOutput, STDOUT_FILENO));
      pipeInput = nullptr;
      pipeOutput = nullptr;

      KJ_SYSCALL(execlp("curl", "curl", isatty(STDERR_FILENO) ? "-f" : "-fs",
                        url.cStr(), EXEC_END_ARGS), url);
      KJ_UNREACHABLE;
    } else {
      pipeFd = kj::mv(pipeInput);
    }
  }

  ~CurlRequest() {
    if (pid == 0) return;

    // Close the pipe first, in case the child is waiting for that.
    pipeFd = nullptr;

    int status;
    KJ_SYSCALL(waitpid(pid, &status, 0)) { return; }
    if (WIFEXITED(status)) {
      int exitCode = WEXITSTATUS(status);
      if (exitCode != 0) {
        KJ_FAIL_ASSERT("curl failed", url, exitCode) { return; }
      }
    } else if (WIFSIGNALED(status)) {
      int signalNumber = WTERMSIG(status);
      KJ_FAIL_ASSERT("curl crashed", url, signalNumber) { return; }
    } else {
      KJ_FAIL_ASSERT("curl failed", url) { return; }
    }
  }

  int getPipe() { return pipeFd; }

  KJ_DISALLOW_COPY(CurlRequest);

private:
  kj::AutoCloseFd pipeFd;
  pid_t pid;
  kj::String url;
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
    umask(0022);
  }

  kj::MainFunc getMain() {
    static const char* VERSION = "Sandstorm version " SANDSTORM_VERSION;
    return kj::MainBuilder(context, VERSION,
            "Controls the Sandstorm server.\n\n"
            "Something not working? Check the logs in SANDSTORM_HOME/var/log.")
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
              return kj::MainBuilder(context, VERSION,
                      "Check if Sandstorm is running. Prints the pid and exits successfully if so; "
                      "exits with an error otherwise.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, status))
                  .build();
            },
            "Check if Sandstorm is running.")
        .addSubCommand("restart",
            [this]() {
              return kj::MainBuilder(context, VERSION, "Restart Sandstorm server.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, restart))
                  .build();
            },
            "Restart Sandstorm server.")
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
                      "Update the Sandstorm platform to a new version. If <release> is provided "
                      "and specifies a bundle file (something like sandstorm-1234.tar.xz) it is "
                      "used as the update. If <release> is a channel name, e.g. \"dev\", we "
                      "securely check the web for an update. If <release> is not provided, we "
                      "use the channel specified in the config file.")
                  .expectOptionalArg("<release>", KJ_BIND_METHOD(*this, setUpdateFile))
                  .callAfterParsing(KJ_BIND_METHOD(*this, update))
                  .build();
            },
            "Update the Sandstorm platform.")
        .addSubCommand("continue",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                      "For internal use only:  Continue running Sandstorm after an update.")
                  .expectArg("<pidfile-fd>", KJ_BIND_METHOD(*this, continue_))
                  .build();
            },
            "For internal use only.")
        .build();
  }

  kj::MainBuilder::Validity start() {
    if (getuid() != 0) {
      return "You must run this program as root, so that it can chroot.  The actual live server "
             "will not run as root.";
    }

    changeToInstallDir();
    const Config config = readConfig();

    // Check / lock the pidfile.
    auto pidfile = raiiOpen("../var/pid/sandstorm.pid", O_RDWR | O_CREAT | O_CLOEXEC, 0660);
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
        context.exitInfo(kj::str("Sandstorm started. PID = ", mainPid));
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

    // Redirect stdio.
    {
      auto logFd = raiiOpen("../var/log/sandstorm.log", O_WRONLY | O_APPEND | O_CREAT, 0660);
      KJ_SYSCALL(fchown(logFd, config.uids.uid, config.uids.gid));
      KJ_SYSCALL(dup2(logFd, STDOUT_FILENO));
      KJ_SYSCALL(dup2(logFd, STDERR_FILENO));
    }
    {
      auto nullFd = raiiOpen("/dev/null", O_RDONLY);
      KJ_SYSCALL(dup2(nullFd, STDIN_FILENO));
    }

    // Write time to log.
    time_t now;
    time(&now);
    context.warning(kj::str("** Starting Sandstorm at: ", ctime(&now)));

    // Detach from controlling terminal and make ourselves session leader.
    KJ_SYSCALL(setsid());

    runUpdateMonitor(config, pidfile);
  }

  kj::MainBuilder::Validity continue_(kj::StringPtr pidfileFdStr) {
    if (getpid() != 1) {
      return "This command is only for internal use.";
    }

    int pidfile = KJ_ASSERT_NONNULL(parseUInt(pidfileFdStr, 10));

    // Make sure the pidfile is close-on-exec.
    KJ_SYSCALL(fcntl(pidfile, F_SETFD, FD_CLOEXEC));

    changeToInstallDir();
    Config config = readConfig();
    runUpdateMonitor(config, pidfile);
  }

  kj::MainBuilder::Validity stop() {
    changeToInstallDir();

    registerAlarmHandler();

    kj::AutoCloseFd pidfile = nullptr;
    KJ_IF_MAYBE(pf, openPidfile()) {
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
    changeToInstallDir();

    KJ_IF_MAYBE(pid, getRunningPid()) {
      context.exitInfo(kj::str("Sandstorm is running; PID = ", *pid));
    } else {
      context.exitError("Sandstorm is not running.");
    }
  }

  kj::MainBuilder::Validity restart() {
    changeToInstallDir();

    KJ_IF_MAYBE(pid, getRunningPid()) {
      KJ_SYSCALL(kill(*pid, SIGHUP));
      context.exitError("Restart request sent.");
      context.exit();
    } else {
      context.exitError("Sandstorm is not running.");
    }
  }

  kj::MainBuilder::Validity mongo() {
    if (getuid() != 0) {
      return "You must run this program as root, so that it can chroot.  The actual live server "
             "will not run as root.";
    }

    changeToInstallDir();

    // Verify that Sandstorm is running.
    if (getRunningPid() == nullptr) {
      context.exitError("Sandstorm is not running.");
    }

    const Config config = readConfig();

    // We'll run under the chroot.
    enterChroot();

    // Don't run as root.
    dropPrivs(config.uids);

    // OK, run the Mongo client!
    KJ_SYSCALL(execl("/bin/mongo", "/bin/mongo",
                     kj::str("127.0.0.1:", config.mongoPort, "/meteor").cStr(), EXEC_END_ARGS));
    KJ_UNREACHABLE;
  }

  kj::MainBuilder::Validity update() {
    if (getuid() != 0) {
      return "You must run this program as root.";
    }

    changeToInstallDir();

    const Config config = readConfig();

    if (updateFile == nullptr) {
      if (config.updateChannel == nullptr) {
        return "You must specify a channel.";
      }

      if (!checkForUpdates(config.updateChannel, "manual")) {
        context.exit();
      }
    } else {
      if (config.updateChannel != nullptr) {
        return "You currently have auto-updates enabled. Please disable it before updating "
               "manually, otherwise you'll just be switched back at the next update. Set "
               "UPDATE_CHANNEL to \"none\" to disable. Or, if you want to manually apply "
               "the latest update from the configured channel, run `sandstorm update` with "
               "no argument.";
      }

      // If the parameter consists only of lower-case letters, treat it as a channel name,
      // otherwise treat it as a file name. Any reasonable update file should end in .tar.xz
      // and therefore not be all letters.
      bool isFile = false;
      for (char c: updateFile) {
        if (c < 'a' || c > 'z') {
          isFile = true;
          break;
        }
      }

      if (isFile) {
        unpackUpdate(raiiOpen(updateFile, O_RDONLY));
      } else if (!checkForUpdates(updateFile, "manual")) {
        context.exit();
      }
    }

    KJ_IF_MAYBE(pid, getRunningPid()) {
      KJ_SYSCALL(kill(*pid, SIGHUP));
      context.exitInfo("Update complete; restarting Sandstorm.");
    } else {
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
    kj::String updateChannel = nullptr;
  };

  kj::String updateFile;

  bool changedDir = false;

  void changeToInstallDir() {
    char exeNameBuf[PATH_MAX + 1];
    size_t len;
    KJ_SYSCALL(len = readlink("/proc/self/exe", exeNameBuf, sizeof(exeNameBuf) - 1));
    exeNameBuf[len] = '\0';
    kj::StringPtr exeName(exeNameBuf, len);
    auto dir = kj::heapString(exeName.slice(0, KJ_ASSERT_NONNULL(exeName.findLast('/'))));
    KJ_SYSCALL(chdir(dir.cStr()));
    changedDir = true;
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

  kj::Maybe<kj::AutoCloseFd> openPidfile() {
    KJ_REQUIRE(changedDir);
    kj::StringPtr pidfileName = "../var/pid/sandstorm.pid";
    if (access(pidfileName.cStr(), F_OK) < 0) {
      return nullptr;
    }
    return raiiOpen(pidfileName, O_RDWR);
  }

  kj::Maybe<pid_t> getRunningPid() {
    KJ_IF_MAYBE(pf, openPidfile()) {
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
    KJ_REQUIRE(changedDir);

    // Verify ownership is intact.
    checkOwnedByRoot("..", "Install directory");
    checkOwnedByRoot(".", "Version intsall directory");
    checkOwnedByRoot("sandstorm", "Executable");
    checkOwnedByRoot("../sandstorm.conf", "Config file");

    // Unshare the mount namespace, so we can create some private bind mounts.
    KJ_SYSCALL(unshare(CLONE_NEWNS));

    // Mount /proc in the chroot.
    KJ_SYSCALL(mount("proc", "proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, ""));

    // To really unshare the mount namespace, we also have to make sure all mounts are private.
    // The parameters here were derived by strace'ing `mount --make-rprivate /`.  AFAICT the flags
    // are undocumented.  :(
    KJ_SYSCALL(mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr));

    // Bind var -> ../var, so that all versions share the same var.
    KJ_SYSCALL(mount("../var", "var", nullptr, MS_BIND, nullptr));

    // Bind /dev into our chroot environment.
    KJ_SYSCALL(mount("/dev", "dev", nullptr, MS_BIND, nullptr));

    // Mount a tmpfs at /tmp
    KJ_SYSCALL(mount("tmpfs", "tmp", "tmpfs",
                     MS_NOATIME | MS_NOSUID | MS_NOEXEC,
                     kj::str("size=8m,nr_inodes=1k,mode=777,uid=0,gid=0").cStr()));

    // Mount a tmpfs at /etc and copy over necessary config files from the host.
    KJ_SYSCALL(mount("tmpfs", "etc", "tmpfs",
                     MS_NOATIME | MS_NOSUID | MS_NOEXEC,
                     kj::str("size=2m,nr_inodes=128,mode=755,uid=0,gid=0").cStr()));
    copyEtc();

    // OK, enter the chroot.
    KJ_SYSCALL(chroot("."));
    KJ_SYSCALL(chdir("/"));

    // Set up path.
    KJ_SYSCALL(setenv("PATH", "/usr/bin:/bin", true));
    KJ_SYSCALL(setenv("LD_LIBRARY_PATH", "/usr/local/lib:/usr/lib:/lib", true));
  }

  void dropPrivs(const UserIds& uids) {
    KJ_SYSCALL(setresgid(uids.gid, uids.gid, uids.gid));
    KJ_SYSCALL(setgroups(uids.groups.size(), uids.groups.begin()));
    KJ_SYSCALL(setresuid(uids.uid, uids.uid, uids.uid));
    umask(0007);
  }

  void clearSignalMask() {
    sigset_t sigset;
    KJ_SYSCALL(sigemptyset(&sigset));
    KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigset, nullptr));
  }

  void copyEtc() {
    auto files = splitLines(readAll("etc.list"));

    // Now copy over each file.
    for (auto& file: files) {
      if (access(file.cStr(), R_OK) == 0) {
        auto in = raiiOpen(file, O_RDONLY);
        auto out = raiiOpen(kj::str(".", file), O_WRONLY | O_CREAT | O_EXCL);
        ssize_t n;
        do {
          KJ_SYSCALL(n = sendfile(out, in, nullptr, 1 << 20));
        } while (n > 0);
      }
    }
  }

  Config readConfig() {
    // Read and return the config file.
    //
    // If parseUids is true, we initialize `uids` from SERVER_USER.  This requires shelling
    // out to id(1).  If false, we ignore SERVER_USER.

    KJ_REQUIRE(changedDir);

    Config config;

    auto lines = splitLines(readAll("../sandstorm.conf"));
    for (auto& line: lines) {
      auto equalsPos = KJ_ASSERT_NONNULL(line.findFirst('='), "Invalid config line", line);
      auto key = trim(line.slice(0, equalsPos));
      auto value = trim(line.slice(equalsPos + 1));

      if (key == "SERVER_USER") {
        KJ_IF_MAYBE(u, getUserIds(value)) {
          config.uids = kj::mv(*u);
          KJ_REQUIRE(config.uids.uid != 0, "Sandstorm cannot run as root.");
        } else {
          KJ_FAIL_REQUIRE("invalid config value SERVER_USER", value);
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
      } else if (key == "UPDATE_CHANNEL") {
        if (value == "none") {
          config.updateChannel = nullptr;
        } else {
          config.updateChannel = kj::mv(value);
        }
      }
    }

    KJ_REQUIRE(config.uids.uid != 0, "config missing SERVER_USER");

    return config;
  }

  void runUpdateMonitor(const Config& config, int pidfile) KJ_NORETURN {
    // Run the update monitor process.  This process runs two subprocesses:  the sandstorm server
    // and the auto-updater.

    cleanupOldVersions();

    auto sigfd = prepareMonitoringLoop();

    pid_t updaterPid = startUpdater(config, false);

    pid_t sandstormPid = fork();
    if (sandstormPid == 0) {
      runServerMonitor(config);
      KJ_UNREACHABLE;
    }

    for (;;) {
      // Wait for a signal -- any signal.
      struct signalfd_siginfo siginfo;
      KJ_SYSCALL(read(sigfd, &siginfo, sizeof(siginfo)));

      if (siginfo.ssi_signo == SIGCHLD) {
        // Some child exited.

        // Reap zombies until there are no more.
        bool updaterDied = false;
        bool updaterSucceeded = false;
        bool sandstormDied = false;
        for (;;) {
          int status;
          pid_t deadPid = waitpid(-1, &status, WNOHANG);
          if (deadPid <= 0) {
            // No more zombies.
            break;
          } else if (deadPid == updaterPid) {
            updaterDied = true;
            updaterSucceeded = WIFEXITED(status) && WEXITSTATUS(status) == 0;
          } else if (deadPid == sandstormPid) {
            sandstormDied = true;
          }
        }

        if (updaterSucceeded) {
          context.warning("** Restarting to apply update");
          killChild("Server Monitor", sandstormPid);
          restartForUpdate(pidfile);
          KJ_UNREACHABLE;
        } else if (updaterDied) {
          context.warning("** Updater died; restarting it");
          updaterPid = startUpdater(config, true);
        } else if (sandstormDied) {
          context.exitError("** Server monitor died. Aborting.");
          KJ_UNREACHABLE;
        }
      } else {
        // Kill updater if it is running.
        if (updaterPid != 0) {
          KJ_SYSCALL(kill(updaterPid, SIGKILL));
        }

        // Shutdown server.
        KJ_SYSCALL(kill(sandstormPid, SIGTERM));
        int status;
        KJ_SYSCALL(waitpid(sandstormPid, &status, 0));

        // Handle signal.
        if (siginfo.ssi_signo == SIGHUP) {
          context.warning("** Restarting");
          restartForUpdate(pidfile);
        } else {
          // SIGTERM or something.
          context.exitInfo("** Exiting");
        }
        KJ_UNREACHABLE;
      }
    }
  }

  kj::MainBuilder::Validity runServerMonitor(const Config& config) KJ_NORETURN {
    // Run the server monitor, which runs node and mongo and deals with them dying.

    enterChroot();

    // For later use when killing children with timeout.
    registerAlarmHandler();

    // MongoDB forks a subprocess but we want to be its reaper.
    KJ_SYSCALL(prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0));

    auto sigfd = prepareMonitoringLoop();

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
        }
      } else {
        // SIGTERM or something.
        context.warning("** Shutting down due to signal");
        killChild("Front-end", nodePid);
        killChild("MongoDB", mongoPid);
        context.exit();
      }
    }
  }

  pid_t startMongo(const Config& config) {
    pid_t outerPid;
    KJ_SYSCALL(outerPid = fork());
    if (outerPid == 0) {
      dropPrivs(config.uids);
      clearSignalMask();

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

    KJ_ASSERT(WIFEXITED(status) && WEXITSTATUS(status) == 0,
        "MongoDB failed on startup. Check var/log/mongo.log.");

    return KJ_ASSERT_NONNULL(parseUInt(trim(readAll("/var/pid/mongo.pid")), 10));
  }

  pid_t startNode(const Config& config) {
    pid_t result;
    KJ_SYSCALL(result = fork());
    if (result == 0) {
      dropPrivs(config.uids);
      clearSignalMask();

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
      KJ_SYSCALL(setenv("METEOR_SETTINGS", kj::str(
          "{\"public\":{\"build\":", SANDSTORM_BUILD, "}}").cStr(), true));
      KJ_SYSCALL(execl("/bin/node", "/bin/node", "main.js", EXEC_END_ARGS));
      KJ_UNREACHABLE;
    }

    return result;
  }

  void maybeWaitAfterChildDeath(kj::StringPtr title, int64_t startTime) {
    if (getTime() - startTime < 10ll * 1000 * 1000 * 1000) {
      context.warning(kj::str(
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

  bool checkForUpdates(kj::StringPtr channel, kj::StringPtr type) {
    KJ_ASSERT(SANDSTORM_BUILD > 0, "Updates not supported for trunk builds.");

    // GET install.sandstorm.io/$channel?from=$oldBuild&type=[manual|startup|daily]
    //     -> result is build number
    context.warning(kj::str("Checking for updates on channel ", channel, "..."));

    kj::String buildStr;

    {
      CurlRequest updateCheck(
          kj::str("https://install.sandstorm.io/", channel,
                  "?from=", SANDSTORM_BUILD, "&type=", type));
      buildStr = readAll(updateCheck.getPipe());
    }

    uint targetBuild = KJ_ASSERT_NONNULL(parseUInt(trim(buildStr), 10));

    if (targetBuild <= SANDSTORM_BUILD) {
      context.warning("No update available.");
      return false;
    }

    // Start http request to download bundle.
    auto url = kj::str("https://dl.sandstorm.io/", channel, "/sandstorm-", targetBuild, ".tar.xz");
    context.warning(kj::str("Downloading: ", url));
    auto download = kj::heap<CurlRequest>(url);
    int fd = download->getPipe();
    unpackUpdate(fd, kj::mv(download), targetBuild);
    return true;
  }

  void unpackUpdate(int bundleFd, kj::Maybe<kj::Own<CurlRequest>> curlRequest = nullptr,
                    uint expectedBuild = 0) {
    char tmpdir[] = "../downloading.XXXXXX";
    if (mkdtemp(tmpdir) != tmpdir) {
      KJ_FAIL_SYSCALL("mkdtemp", errno);
    }
    KJ_DEFER(recursivelyDelete(tmpdir));

    pid_t tarPid = fork();
    if (tarPid == 0) {
      KJ_SYSCALL(dup2(bundleFd, STDIN_FILENO));
      KJ_SYSCALL(chdir(tmpdir));
      KJ_SYSCALL(execlp("tar", "tar", "Jxo", EXEC_END_ARGS));
      KJ_UNREACHABLE;
    }

    // Make sure to report CURL status before tar status.
    curlRequest = nullptr;

    int tarStatus;
    KJ_SYSCALL(waitpid(tarPid, &tarStatus, 0));
    KJ_ASSERT(WIFEXITED(tarStatus) && WEXITSTATUS(tarStatus) == 0, "tar failed");

    auto files = listDirectory(tmpdir);
    KJ_ASSERT(files.size() == 1, "Expected tar file to contain only one item.");
    KJ_ASSERT(files[0].startsWith("sandstorm-"), "Expected tar file to contain sandstorm-$BUILD.");

    uint targetBuild = KJ_ASSERT_NONNULL(parseUInt(files[0].slice(strlen("sandstorm-")), 10));

    if (expectedBuild != 0) {
      KJ_ASSERT(targetBuild == expectedBuild,
          "Downloaded bundle did not contain the build number we expecetd.");
    }

    auto targetDir = kj::str("../", files[0]);
    if (access(targetDir.cStr(), F_OK) != 0) {
      KJ_SYSCALL(rename(kj::str(tmpdir, '/', files[0]).cStr(), targetDir.cStr()));
    }

    // Setup "latest" symlink, atomically.
    auto tmpLink = kj::str("../latest.", targetBuild);
    unlink(tmpLink.cStr());  // just in case; ignore failure
    KJ_SYSCALL(symlink(kj::str("sandstorm-", targetBuild).cStr(), tmpLink.cStr()));
    KJ_SYSCALL(rename(tmpLink.cStr(), "../latest"));
  }

  pid_t startUpdater(const Config& config, bool isRetry) {
    if (config.updateChannel == nullptr) {
      context.warning("WARNING: Auto-updates are disabled by config.");
      return 0;
    } else {
      pid_t pid = fork();
      if (pid == 0) {
        doUpdateLoop(config.updateChannel, isRetry);
        KJ_UNREACHABLE;
      }
      return pid;
    }
  }

  void doUpdateLoop(kj::StringPtr channel, bool isRetry) KJ_NORETURN {
    // This is the updater process.  Run in a loop.
    auto log = raiiOpen("../var/log/updater.log", O_WRONLY | O_APPEND | O_CREAT);
    KJ_SYSCALL(dup2(log, STDOUT_FILENO));
    KJ_SYSCALL(dup2(log, STDERR_FILENO));

    // Wait 10 minutes before the first update attempt just to make sure the server isn't going
    // to be shut down right away.  (On a retry, wait an hour so we don't overwhelm the servers
    // when a broken package is posted.)
    uint n = isRetry ? 3600 : 600;
    while (n > 0) n = sleep(n);

    // The 10-minute request is called "startup" while subsequent daily requests are called "daily".
    // We signal retries separately so that the server can monitor for flapping clients.
    kj::StringPtr type = isRetry ? "retry" : "startup";

    for (;;) {
      // Print time.
      time_t start = time(nullptr);
      context.warning(kj::str("** Time: ", ctime(&start)));

      // Check for updates.
      if (checkForUpdates(channel, type)) {
        // Exit so that the update can be applied.
        context.exitInfo("** Successfully updated; restarting.");
      }

      // Wait a day.  We actually wait 10 minutes at a time, then check if a day has passed, to
      // capture cases where the system was suspended.
      for (;;) {
        n = 600;
        while (n > 0) n = sleep(n);
        if (time(nullptr) - start >= 86400) break;
      }

      n = 86400;
      while (n > 0) n = sleep(n);
      type = "daily";
    }
  }

  void restartForUpdate(int pidfileFd) KJ_NORETURN {
    // Change pidfile to not close on exec, since we want it to live through the following exec!
    KJ_SYSCALL(fcntl(pidfileFd, F_SETFD, 0));

    // Exec the new version with our magic "continue".
    KJ_SYSCALL(execl("../latest/sandstorm", "../latest/sandstorm",
                     "continue", kj::str(pidfileFd).cStr(), EXEC_END_ARGS));
    KJ_UNREACHABLE;
  }

  void cleanupOldVersions() {
    for (auto& file: listDirectory("..")) {
      if (file.startsWith("sandstorm-")) {
        KJ_IF_MAYBE(build, parseUInt(file.slice(strlen("sandstorm-")), 10)) {
          // build 0 is special -- it usually indicates a custom build.  So don't delete that.
          // Also don't delete this build or newer builds.
          if (*build > 0 && *build < SANDSTORM_BUILD) {
            KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
              recursivelyDelete(kj::str("../", file));
            })) {
              context.warning(kj::str("couldn't delete old build ", file, ": ",
                                      exception->getDescription()));
            }
          }
        }
      }
    }
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
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::RunBundleMain)
