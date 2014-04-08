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

#ifndef SANDSTORM_VERSION
#define SANDSTORM_VERSION "(unknown)"
#endif

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

kj::Maybe<uint> nameToId(const char* flag, kj::StringPtr name) {
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
    KJ_SYSCALL(execlp("id", "id", flag, name.cStr(), EXEC_END_ARGS));
    KJ_UNREACHABLE;
  }

  close(fds[1]);
  KJ_DEFER(close(fds[0]));

  return parseUInt(trim(readAll(fds[0])), 10);
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

class RunBundleMain {
  // Main class for the Sandstorm bundle runner.  This is a convenience tool for running the
  // Sandstorm binary bundle, which is a packaged chroot environment containing everything needed
  // to run a Sandstorm server.  Just unpack and run!

public:
  RunBundleMain(kj::ProcessContext& context): context(context) {}

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
        .build();
  }

  kj::MainBuilder::Validity start() {
    enterChroot();

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
      KJ_SYSCALL(fchown(pidfile, uid, gid));
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

    // For later use when killing children.
    registerAlarmHandler();

    // Set pidfile to close-on-exec now that we're in the child proc.
    KJ_SYSCALL(fcntl(pidfile, F_SETFD, FD_CLOEXEC));

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

    // We can mount /proc now that we're in the new pid namespace.
    KJ_SYSCALL(mount("proc", "proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, ""));

    // Make sure sandstorm-supervisor is setuid-root before we drop privs.
    KJ_SYSCALL(chown("/bin/sandstorm-supervisor", 0, gid));
    KJ_SYSCALL(chmod("/bin/sandstorm-supervisor", S_ISUID | 0770));

    dropPrivs();
    umask(0007);

    // Redirect stdio.
    {
      auto logFd = raiiOpen("/var/log/sandstorm.log", O_WRONLY | O_APPEND | O_CREAT, 0660);
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
    KJ_SYSCALL(sigprocmask(SIG_BLOCK, &sigmask, nullptr));

    // Receive signals on a signalfd.
    int sigfd;
    KJ_SYSCALL(sigfd = signalfd(-1, &sigmask, SFD_CLOEXEC));

    context.warning("** Starting MongoDB...");
    pid_t mongoPid = startMongo();
    int64_t mongoStartTime = getTime();

    context.warning("** Mongo started; now starting front-end...");
    pid_t nodePid = startNode();
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
          mongoPid = startMongo();
          mongoStartTime = getTime();
        } else if (nodeDied) {
          maybeWaitAfterChildDeath("Front-end", nodeStartTime);
          nodePid = startNode();
          nodeStartTime = getTime();
        }
      } else {
        if (siginfo.ssi_signo == SIGHUP) {
          context.warning("** SIGHUP ** Restarting front-end **");
          killChild("Front-end", nodePid);
          nodePid = startNode();
          nodeStartTime = getTime();
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

    pid_t pid = getRunningPid();
    context.warning(kj::str("Waiting for PID ", pid, " to terminate..."));
    KJ_SYSCALL(kill(pid, SIGTERM));

    // Timeout if not dead within 10 seconds.
    uint timeout = 10;
    KJ_SYSCALL(alarm(timeout));

    auto pidfile = openPidfileOutsideChroot();

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
    pid_t pid = getRunningPid();
    context.exitInfo(kj::str("Sandstorm is running; PID = ", pid));
  }

  kj::MainBuilder::Validity restartFrontend() {
    KJ_SYSCALL(kill(getRunningPid(), SIGHUP));
    context.exit();
  }

  kj::MainBuilder::Validity mongo() {
    // Verify that Sandstorm is running.
    getRunningPid();

    // We'll run under the chroot.
    enterChroot();

    // Mount /proc, because Mongo likes it.
    KJ_SYSCALL(mount("proc", "proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, ""));

    // Don't run as root.
    dropPrivs();

    // OK, run the Mongo client!
    KJ_SYSCALL(execl("/bin/mongo", "/bin/mongo",
                     kj::str("127.0.0.1:", mongoPort, "/meteor").cStr(), EXEC_END_ARGS));
    KJ_UNREACHABLE;
  }

private:
  kj::ProcessContext& context;

  uint port = 3000;
  uint mongoPort = 3001;
  uid_t uid = -1;
  gid_t gid = -1;
  kj::String bindIp = kj::str("127.0.0.1");
  kj::String rootUrl = nullptr;
  kj::String mailUrl = nullptr;

  kj::String getRootDir() {
    char exeNameBuf[PATH_MAX + 1];
    size_t len;
    KJ_SYSCALL(len = readlink("/proc/self/exe", exeNameBuf, sizeof(exeNameBuf) - 1));
    exeNameBuf[len] = '\0';
    kj::StringPtr exeName(exeNameBuf, len);
    return kj::heapString(exeName.slice(0, KJ_ASSERT_NONNULL(exeName.findLast('/'))));
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

  kj::AutoCloseFd openPidfileOutsideChroot() {
    auto dir = getRootDir();
    auto pidfileName = kj::str(dir, "/var/pid/sandstorm.pid");
    if (access(pidfileName.cStr(), F_OK) < 0) {
      context.exitError("Sandstorm is not running.");
    }
    return raiiOpen(pidfileName, O_RDWR);
  }

  pid_t getRunningPid() {
    auto pidfile = openPidfileOutsideChroot();

    struct flock lock;
    memset(&lock, 0, sizeof(lock));
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    lock.l_start = 0;
    lock.l_len = 0;  // entire file
    KJ_SYSCALL(fcntl(pidfile, F_GETLK, &lock));

    if (lock.l_type == F_UNLCK) {
      context.exitError("Sandstorm is not running.");
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
      context.exitError(
          "Sandstorm is not running, or is just starting up (race condition; try again).");
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
          "You must run this program as root, so that it can chroot.  It will drop priveleges "
          "shortly after chrooting.");
    }

    // Make sure we didn't inherit a weird signal mask from the parent process.
    clearSignalMask();

    // Determine the directory containing the executable.
    auto dir = getRootDir();

    // Verify ownership is intact.
    checkOwnedByRoot(kj::str(dir, "/sandstorm.conf"), "Config file");
    checkOwnedByRoot(kj::str(dir, "/sandstorm"), "Executable");
    checkOwnedByRoot(dir, "Bundle directory");

    // Load the config.
    readConfig(kj::str(dir, "/sandstorm.conf"));

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
                       kj::str("size=2m,nr_inodes=1k,mode=770,uid=", uid, ",gid=", gid).cStr()));
      copyEtc(dir);

      // OK, enter the chroot.
      KJ_SYSCALL(chroot(dir.cStr()));
      KJ_SYSCALL(chdir("/"));
    }

    // Set up path.
    KJ_SYSCALL(setenv("PATH", "/usr/bin:/bin", true));
    KJ_SYSCALL(setenv("LD_LIBRARY_PATH", "/usr/local/lib:/usr/lib:/lib", true));
  }

  void dropPrivs() {
    KJ_SYSCALL(setresgid(gid, gid, gid));
    KJ_SYSCALL(setgroups(1, &gid));
    KJ_SYSCALL(setresuid(uid, uid, uid));
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
      auto in = raiiOpen(file, O_RDONLY);
      auto out = raiiOpen(kj::str(dir, file), O_WRONLY | O_CREAT | O_EXCL);
      ssize_t n;
      do {
        KJ_SYSCALL(n = sendfile(out, in, nullptr, 1 << 20));
      } while (n > 0);
    }
  }

  void readConfig(kj::StringPtr path) {
    auto lines = splitLines(readAll(path));
    for (auto& line: lines) {
      auto equalsPos = KJ_ASSERT_NONNULL(line.findFirst('='), "Invalid config line", line);
      auto key = trim(line.slice(0, equalsPos));
      auto value = trim(line.slice(equalsPos + 1));

      if (key == "SERVER_USER") {
        setUser(value);
      } else if (key == "PORT") {
        setPort(value);
      } else if (key == "MONGO_PORT") {
        setMongoPort(value);
      } else if (key == "BIND_IP") {
        bindIp = kj::mv(value);
      } else if (key == "BASE_URL") {
        rootUrl = kj::mv(value);
      } else if (key == "MAIL_URL") {
        mailUrl = kj::mv(value);
      }
    }
  }

  pid_t startMongo() {
    pid_t outerPid;
    KJ_SYSCALL(outerPid = fork());
    if (outerPid == 0) {
      clearSignalMask();
      KJ_SYSCALL(execl("/bin/mongod", "/bin/mongod", "--fork",
          "--bind_ip", "127.0.0.1", "--port", kj::str(mongoPort).cStr(),
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

  pid_t startNode() {
    pid_t result;
    KJ_SYSCALL(result = fork());
    if (result == 0) {
      clearSignalMask();
      KJ_SYSCALL(setenv("PORT", kj::str(port).cStr(), true));
      KJ_SYSCALL(setenv("MONGO_URL", kj::str("mongodb://127.0.0.1:", mongoPort, "/meteor").cStr(), true));
      KJ_SYSCALL(setenv("BIND_IP", bindIp.cStr(), true));
      if (mailUrl != nullptr) {
        KJ_SYSCALL(setenv("MAIL_URL", mailUrl.cStr(), true));
      }
      if (rootUrl == nullptr) {
        if (port == 80) {
          KJ_SYSCALL(setenv("ROOT_URL", kj::str("http://", bindIp).cStr(), true));
        } else {
          KJ_SYSCALL(setenv("ROOT_URL", kj::str("http://", bindIp, ":", port).cStr(), true));
        }
      } else {
        KJ_SYSCALL(setenv("ROOT_URL", rootUrl.cStr(), true));
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

  kj::MainBuilder::Validity setPort(kj::StringPtr arg) {
    KJ_IF_MAYBE(p, parseUInt(arg, 10)) {
      port = *p;
      return true;
    } else {
      return "invalid port number";
    }
  }

  kj::MainBuilder::Validity setMongoPort(kj::StringPtr arg) {
    KJ_IF_MAYBE(p, parseUInt(arg, 10)) {
      mongoPort = *p;
      return true;
    } else {
      return "invalid port number";
    }
  }

  kj::MainBuilder::Validity setUser(kj::StringPtr arg) {
    KJ_IF_MAYBE(u, parseUInt(arg, 10)) {
      uid = *u;
      return true;
    } else KJ_IF_MAYBE(u2, nameToId("-u", arg)) {
      // TODO(soon):  We could be fancy and use id without a flag and parse the output...  this
      //   would get us the complete list of groups.
      uid = *u2;
      gid = KJ_ASSERT_NONNULL(nameToId("-g", arg));
      return true;
    } else {
      return "invalid user name";
    }
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::RunBundleMain)
