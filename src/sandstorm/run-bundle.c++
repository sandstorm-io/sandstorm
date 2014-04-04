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
#include <sched.h>
#include <grp.h>
#include <errno.h>
#include <fcntl.h>

namespace sandstorm {

typedef unsigned int uint;

kj::Maybe<uint> parseUInt(kj::StringPtr s, int base) {
  char* end;
  uint result = strtoul(s.cStr(), &end, base);
  if (s.size() == 0 || *end != '\0') {
    return nullptr;
  }
  return result;
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
    KJ_SYSCALL(execlp("id", "id", flag, name.cStr(), (const char*)nullptr));
    KJ_UNREACHABLE;
  }

  close(fds[1]);

  KJ_DEFER(close(fds[0]));

  char buffer[257];

  size_t n = kj::FdInputStream(fds[0]).tryRead(buffer, sizeof(buffer) - 1, sizeof(buffer) - 1);
  while (n > 0 && buffer[n-1] == '\n') --n;
  buffer[n] = '\0';

  return parseUInt(buffer, 10);
}

class RunBundleMain {
  // Main class for the Sandstorm bundle runner.  This is a convenience tool for running the
  // Sandstorm binary bundle, which is a packaged chroot environment containing everything needed
  // to run a Sandstorm server.  Just unpack and run!

public:
  RunBundleMain(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version 0.0",
                           "Runs the Sandstorm chroot bundle as a daemon process as the "
                           "given user. (This binary must start as root.)")
        .addOptionWithArg({'p', "port"}, KJ_BIND_METHOD(*this, setPort), "<port>",
                          "Set the port number for the main web server. Default: 3000.")
        .addOptionWithArg({'q', "mongo-port"}, KJ_BIND_METHOD(*this, setMongoPort), "<port>",
                          "Set the port number for MongoDB. Default: 3001.")
        .addOptionWithArg({'i', "bind-ip"}, KJ_BIND_METHOD(*this, setBindIp), "<ip>",
                          "Set IP address to which to export the HTTP interface. Set to "
                          "0.0.0.0 to expose on all interfaces. Default: 127.0.0.1")
        .addOptionWithArg({'u', "root-url"}, KJ_BIND_METHOD(*this, setRootUrl), "<http-url>",
                          "Set the URL which users will enter into the address bar to visit "
                          "this server. Default: http://<bind-ip>:<port>")
        .addOptionWithArg({'M', "mail-url"}, KJ_BIND_METHOD(*this, setMailUrl), "<smtp-url>",
                          "Set the mail URL, e.g. smtp://user:pass@hostname:port. If not "
                          "provided, you will not be able to send e-mail invites nor password "
                          "reset mails.")
        .addOption({'m', "mongo"}, KJ_BIND_METHOD(*this, setRunMongo),
                   "Don't start a server. Instead, run the mongo client tool connected to the "
                   "existing server's database.")
        .expectArg("<user>", KJ_BIND_METHOD(*this, setUser))
        .callAfterParsing(KJ_BIND_METHOD(*this, run))
        .build();
  }

  bool setRunMongo() {
    runMongo = true;
    return true;
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

  kj::MainBuilder::Validity setBindIp(kj::StringPtr arg) {
    bindIp = arg;
    return true;
  }

  kj::MainBuilder::Validity setRootUrl(kj::StringPtr arg) {
    rootUrl = arg;
    return true;
  }

  kj::MainBuilder::Validity setMailUrl(kj::StringPtr arg) {
    mailUrl = arg;
    return true;
  }

  // =====================================================================================
  // Flag handlers

  kj::MainBuilder::Validity run() {
    if (getuid() != 0) {
      context.exitError(
          "You must run this program as root, so that it can chroot.  It will drop priveleges "
          "before starting the server.");
    }

    // Make sure we didn't inherit a weird signal mask from the parent process.
    sigset_t sigset;
    KJ_SYSCALL(sigemptyset(&sigset));
    KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigset, nullptr));

    // Determine the directory containing the executable.
    char exeNameBuf[PATH_MAX + 1];
    size_t len;
    KJ_SYSCALL(len = readlink("/proc/self/exe", exeNameBuf, sizeof(exeNameBuf) - 1));
    exeNameBuf[len] = '\0';
    kj::StringPtr exeName = exeNameBuf;
    auto dir = kj::heapString(exeName.slice(0, KJ_ASSERT_NONNULL(exeName.findLast('/'))));

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

      // OK, enter the chroot.
      KJ_SYSCALL(chroot(dir.cStr()));
      KJ_SYSCALL(chdir("/"));
    }

    // Set up path.
    KJ_SYSCALL(setenv("PATH", "/usr/bin:/bin", true));
    KJ_SYSCALL(setenv("LD_LIBRARY_PATH", "/usr/local/lib:/usr/lib:/lib", true));

    constexpr const char* END_ARGS = nullptr;

    if (runMongo) {
      // Go ahead and run mongo client now.
      dropPrivs();
      KJ_SYSCALL(execl("/bin/mongo", "/bin/mongo",
                       kj::str("127.0.0.1:", mongoPort).cStr(), END_ARGS));
      KJ_UNREACHABLE;
    }

    // Not running mongo client.  Continue.

    // Unshare PID namespace so that daemon process becomes the root process of its own PID
    // namespace and therefore if it dies the whole namespace is killed.
    KJ_SYSCALL(unshare(CLONE_NEWPID));

    // Daemonize ourselves.
    {
      pid_t mainPid;
      KJ_SYSCALL(mainPid = fork());
      if (mainPid != 0) {
        context.exitInfo(kj::str("server started; PID = ", mainPid));
        return true;
      }
    }

    // We can mount /proc now that we're in the new pid namespace.
    KJ_SYSCALL(mount("proc", "proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, ""));

    dropPrivs();
    umask(0007);

    // TODO(soon): pidfile

    // Redirect stdio.
    {
      int logFd;
      KJ_SYSCALL(logFd = open("/var/log/sandstorm.log", O_WRONLY | O_APPEND | O_CREAT, 0660));
      KJ_DEFER(close(logFd));
      KJ_SYSCALL(dup2(logFd, STDOUT_FILENO));
      KJ_SYSCALL(dup2(logFd, STDERR_FILENO));
    }
    {
      int nullFd;
      KJ_SYSCALL(nullFd = open("/dev/null", O_RDONLY));
      KJ_DEFER(close(nullFd));
      KJ_SYSCALL(dup2(nullFd, STDIN_FILENO));
    }

    // Since we unshared the PID namespace, the first fork() should have produced pid 1 in the
    // new namespace.  That means that if this pid ever exits, everything under it dies.  That's
    // perfect!  Otherwise we'd have to carefully kill node and mongo separately.
    KJ_ASSERT(getpid() == 1, "unshare(CLONE_NEWPID) didn't do what I expected.", getpid());

    // Detach from controlling terminal and make ourselves session leader.
    KJ_SYSCALL(setsid());

    // Set up signal mask to catch events that should lead to shutdown.
    sigset_t sigmask;
    KJ_SYSCALL(sigemptyset(&sigmask));
    KJ_SYSCALL(sigaddset(&sigmask, SIGTERM));
    KJ_SYSCALL(sigaddset(&sigmask, SIGINT));
    KJ_SYSCALL(sigaddset(&sigmask, SIGCHLD));
    KJ_SYSCALL(sigaddset(&sigmask, SIGHUP));
    KJ_SYSCALL(sigprocmask(SIG_BLOCK, &sigmask, nullptr));

    // Receive signals on a signalfd.
    int sigfd;
    KJ_SYSCALL(sigfd = signalfd(-1, &sigmask, SFD_CLOEXEC));

    context.warning("** Starting MongoDB...");

    // Start mongod.
    pid_t mongoPid;
    KJ_SYSCALL(mongoPid = fork());
    if (mongoPid == 0) {
      KJ_SYSCALL(execl("/bin/mongod", "/bin/mongod", "--fork",
          "--bind_ip", "127.0.0.1", "--port", kj::str(mongoPort).cStr(),
          "--dbpath", "/var/mongo", "--logpath", "/var/log/mongo.log",
          "--pidfilepath", "/var/pid/mongo.pid",
          "--noauth", "--nohttpinterface", "--noprealloc", "--nopreallocj", "--smallfiles",
          END_ARGS));
      KJ_UNREACHABLE;
    }

    // Wait for mongod to return, meaning the database is up.  Then get its real pid via the
    // pidfile.
    {
      int status;
      KJ_SYSCALL(waitpid(mongoPid, &status, 0));

      int pidfile;
      KJ_SYSCALL(pidfile = open("/var/pid/mongo.pid", O_RDONLY));
      KJ_DEFER(close(pidfile));
      char buffer[128];
      size_t n = kj::FdInputStream(pidfile).tryRead(buffer, sizeof(buffer)-1, sizeof(buffer)-1);
      while (n > 0 && buffer[n-1] == '\n') --n;
      buffer[n] = '\0';
      mongoPid = KJ_ASSERT_NONNULL(parseUInt(buffer, 10));
    }

    context.warning("** Mongo started; now starting Meteor...");

    for (;;) {
      // Start node.
      pid_t nodePid;
      KJ_SYSCALL(nodePid = fork());
      if (nodePid == 0) {
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
        KJ_SYSCALL(execl("/bin/node", "/bin/node", "main.js", END_ARGS));
        KJ_UNREACHABLE;
      }

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
          if (deadPid < 0) {
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
          // Without Mongo, we're nothing.  Just bail out and let the OS clean up.
          // TODO(soon):  We should probably try to restart, but watch out for repeating errors.
          context.exitError("** MongoDB died! Aborting!");
        } else if (nodeDied) {
          // We could try restarting node, but it could be a recurring failure.  For now, we
          // exit, but we want to do so cleanly.
          // TODO(soon):  We should probably try to restart, but watch out for repeating errors.
          break;
        }
      } else {
        if (siginfo.ssi_signo == SIGHUP) {
          context.warning("** SIGHUP ** Restarting Meteor **");
        } else {
          // SIGTERM or something.
          context.warning("** Got termination signal; shutting down");
        }

        int status;
        KJ_SYSCALL(kill(nodePid, SIGTERM));
        KJ_SYSCALL(waitpid(nodePid, &status, 0));

        if (siginfo.ssi_signo != SIGHUP) {
          break;
        }
      }
    }

    // Send SIGTERM to Mongo so it can close cleanly.
    int status;
    KJ_SYSCALL(kill(mongoPid, SIGTERM));
    KJ_SYSCALL(waitpid(mongoPid, &status, 0));

    context.warning("** Exiting");

    context.exit();
  }

private:
  kj::ProcessContext& context;

  uint port = 3000;
  uint mongoPort = 3001;
  uid_t uid = -1;
  gid_t gid = -1;
  bool runMongo = false;
  kj::StringPtr bindIp = "127.0.0.1";
  kj::StringPtr rootUrl = nullptr;
  kj::StringPtr mailUrl = nullptr;

  void dropPrivs() {
    KJ_SYSCALL(setresgid(gid, gid, gid));
    KJ_SYSCALL(setgroups(1, &gid));
    KJ_SYSCALL(setresuid(uid, uid, uid));
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::RunBundleMain)
