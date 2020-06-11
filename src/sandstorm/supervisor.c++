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

#include "supervisor.h"

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/async-io.h>
#include <kj/async-unix.h>
#include <kj/io.h>
#include <capnp/rpc-twoparty.h>
#include <capnp/rpc.capnp.h>
#include <capnp/membrane.h>
#include <unistd.h>
#include <netinet/in.h> // needs to be included before sys/capability.h
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/time.h>
#include <sys/wait.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/capability.h>
#include <sys/ptrace.h>
#include <sys/syscall.h>
#include <linux/sockios.h>
#include <linux/route.h>
#include <sandstorm/ip_tables.h>  // created by Makefile from <linux/netfilter_ipv4/ip_tables.h>
#include <linux/netfilter/nf_nat.h>
#include <fcntl.h>
#include <errno.h>
#include <stdlib.h>
#include <limits.h>
#include <sched.h>
#include <dirent.h>
#include <pwd.h>
#include <grp.h>
#include <sys/inotify.h>
#include <map>
#include <unordered_map>
#include <execinfo.h>
#include <linux/netlink.h>
#include <linux/rtnetlink.h>
#include <sys/eventfd.h>
#include <sys/resource.h>
#include <sandstorm/cgroup2.h>

// We need to define these constants before libseccomp has a chance to inject bogus
// values for them. See https://github.com/seccomp/libseccomp/issues/27
#ifndef __NR_seccomp
#define __NR_seccomp 317
#endif
#ifndef __NR_bpf
#define __NR_bpf 321
#endif
#ifndef __NR_userfaultfd
#define __NR_userfaultfd 323
#endif
#include <seccomp.h>

#include <sandstorm/grain.capnp.h>
#include <sandstorm/supervisor.capnp.h>

#include "version.h"
#include "send-fd.h"
#include "util.h"

// In case kernel headers are old.
#ifndef PR_SET_NO_NEW_PRIVS
#define PR_SET_NO_NEW_PRIVS 38
#endif

namespace sandstorm {

// =======================================================================================
// Directory size watcher

class DiskUsageWatcher: private kj::TaskSet::ErrorHandler {
  // Class which watches a directory tree, counts up the total disk usage, and fires events when
  // it changes. Uses inotify. Which turns out to be... harder than it should be.

public:
  DiskUsageWatcher(kj::UnixEventPort& eventPort, kj::Timer& timer, SandstormCore::Client core)
      : eventPort(eventPort), timer(timer), core(kj::mv(core)), tasks(*this) {}

  kj::Promise<void> init() {
    // Start watching the current directory.

    // Note: this function is also called to restart watching from scratch when the inotify event
    //   queue overflows (hopefully rare).

    int fd;
    KJ_SYSCALL(fd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC));
    inotifyFd = kj::AutoCloseFd(fd);

    // Note that because we create the FdObserver before creating any watches, we don't have
    // to worry about the possibility that we missed an event between creation of the fd and
    // creation of the FdObserver.
    observer = kj::heap<kj::UnixEventPort::FdObserver>(eventPort, inotifyFd,
        kj::UnixEventPort::FdObserver::OBSERVE_READ);

    totalSize = 0;
    watchMap.clear();
    pendingWatches.add(nullptr);  // root directory
    return readLoop();
  }

private:
  kj::UnixEventPort& eventPort;
  kj::Timer& timer;
  SandstormCore::Client core;
  kj::AutoCloseFd inotifyFd;
  kj::Own<kj::UnixEventPort::FdObserver> observer;
  uint64_t totalSize;
  uint64_t reportedSize = kj::maxValue;
  bool reportInFlight = false;

  struct ChildInfo {
    kj::String name;
    uint64_t size;
  };
  struct WatchInfo {
    kj::String path;  // null = root directory
    std::map<kj::StringPtr, ChildInfo> childSizes;
  };
  std::unordered_map<int, WatchInfo> watchMap;
  // Maps inotify watch descriptors to info about what is being watched.

  kj::Vector<kj::String> pendingWatches;
  // Directories we would like to watch, but we can't add watches on them just yet because we need
  // to finish processing a list of events received from inotify before we mess with the watch
  // descriptor table.

  kj::TaskSet tasks;

  void addPendingWatches() {
    // Start watching everything that has been added to the pendingWatches list.

    // We treat pendingWatches as a stack here in order to get DFS traversal of the directory tree.
    while (pendingWatches.size() > 0) {
      auto path = kj::mv(pendingWatches.end()[-1]);
      pendingWatches.removeLast();
      addWatch(kj::mv(path));
    }
  }

  void addWatch(kj::String&& path) {
    // Start watching `path`. This is idempotent -- it's safe to watch the same path multiple
    // times.

    static const uint32_t FLAGS =
        IN_CREATE | IN_DELETE | IN_MODIFY | IN_MOVED_FROM | IN_MOVED_TO |
        IN_DONT_FOLLOW | IN_ONLYDIR | IN_EXCL_UNLINK;

    for (;;) {
      const char* pathPtr = path == nullptr ? "." : path.cStr();
      int wd = inotify_add_watch(inotifyFd, pathPtr,
          FLAGS | IN_DONT_FOLLOW | IN_EXCL_UNLINK);

      if (wd >= 0) {
        WatchInfo& watchInfo = watchMap[wd];

        // Update the watch map. Note that it's possible that inotify_add_watch() returned a
        // pre-existing watch descriptor, if we tried to add a watch on a directory we're
        // already watching. This can happen in various race conditions. Replacing the path is
        // actually exactly what we want to do in these cases anyway.
        watchInfo.path = kj::mv(path);

        // In the case that we are reusing an existing watch descriptor, we want to clear out the
        // existing contents as they may be stale due to, again, race conditions.
        for (auto& child: watchInfo.childSizes) {
          totalSize -= child.second.size;
        }
        watchInfo.childSizes.clear();

        // Now repopulate the children by listing the directory.
        DIR* dir = opendir(pathPtr);
        if (dir != nullptr) {
          KJ_DEFER(closedir(dir));
          for (;;) {
            errno = 0;
            struct dirent* entry = readdir(dir);
            if (entry == nullptr) {
              int error = errno;
              if (error == 0) {
                break;
              } else {
                KJ_FAIL_SYSCALL("readdir", error, pathPtr);
              }
            }

            kj::StringPtr name = entry->d_name;
            if (name != "." && name != "..") {
              childEvent(watchInfo, name);
            }
          }
        }

        return;
      }

      // Error occurred.
      int error = errno;
      switch (error) {
        case EINTR:
          // Keep trying.
          break;

        case ENOENT:
        case ENOTDIR:
          // Apparently there is no longer a directory at this path. Perhaps it was deleted.
          // No matter.
          return;

        case ENOSPC:
          // No more inotify watches available.
          // TODO(someday): Revert to some sort of polling mode? For now, fall through to error
          //   case.
        default:
          KJ_FAIL_SYSCALL("inotify_add_watch", error, path);
      }
    }
  }

  kj::Promise<void> readLoop() {
    addPendingWatches();
    maybeReportSize();
    return observer->whenBecomesReadable().then([this]() {
      alignas(uint64_t) kj::byte buffer[4096];

      for (;;) {
        ssize_t n;
        KJ_NONBLOCKING_SYSCALL(n = read(inotifyFd, buffer, sizeof(buffer)));

        if (n < 0) {
          // EAGAIN; try again later.
          return readLoop();
        }

        KJ_ASSERT(n > 0, "inotify EOF?");

        kj::byte* pos = buffer;
        while (n > 0) {
          // Split off one event.
          auto event = reinterpret_cast<struct inotify_event*>(pos);
          size_t eventSize = sizeof(struct inotify_event) + event->len;
          KJ_ASSERT(eventSize <= n, "inotify returned partial event?");
          KJ_ASSERT(eventSize % sizeof(size_t) == 0, "inotify event not aligned?");
          n -= eventSize;
          pos += eventSize;

          if (event->mask & IN_Q_OVERFLOW) {
            // Queue overflow; start over from scratch.
            inotifyFd = nullptr;
            KJ_LOG(WARNING, "inotify event queue overflow; restarting watch from scratch");
            return init();
          }

          auto iter = watchMap.find(event->wd);
          KJ_ASSERT(iter != watchMap.end(), "inotify gave unknown watch descriptor?");

          if (event->mask & (IN_CREATE | IN_DELETE | IN_MODIFY | IN_MOVE)) {
            childEvent(iter->second, event->name);
          }

          if (event->mask & IN_IGNORED) {
            // This watch descriptor is being removed, probably because it was deleted.

            // There shouldn't be any children left, but if there are, go ahead and un-count them.
            for (auto& child: iter->second.childSizes) {
              totalSize -= child.second.size;
            }

            watchMap.erase(iter);
          }
        }
      }
    });
  }

  void childEvent(WatchInfo& watchInfo, kj::StringPtr name) {
    // Called to update the child table when we receive an inotify event with the given name.

    // OK, we received notification that something happened to the child named `name`.
    // Unfortunately, we don't have any idea how long ago this event happened. Worse, any
    // number of other events may have occurred since this one was generated. For example,
    // the event may have been on a file that has subsequently been deleted, and maybe even
    // recreated as a different kind of node. If we lstat() it, we get information about
    // what is currently on disk, not whatever generated this event.
    //
    // Therefore, the inotify event mask is mostly useless. We can only use the event as a hint
    // that something happened at this child. We have to compare what we know about the child
    // vs. what we knew in the past to determine what has changed. Note that if inotify
    // provided a `struct stat` along with the event then we wouldn't have this problem!

    auto usage = getDiskUsage(watchInfo.path, name);
    totalSize += usage.bytes;

    auto iter = watchInfo.childSizes.find(name);
    if (usage.bytes == 0) {
      // There is no longer a child by this name on disk. Remove whatever is in the map.
      if (iter != watchInfo.childSizes.end()) {
        totalSize -= iter->second.size;
        watchInfo.childSizes.erase(iter);
      }
    } else if (iter == watchInfo.childSizes.end()) {
      // There is a child by this name on disk, but not in the map. Add it.
      ChildInfo newChild = { kj::heapString(name), usage.bytes };
      kj::StringPtr namePtr = newChild.name;
      KJ_ASSERT(watchInfo.childSizes.insert(std::make_pair(namePtr, kj::mv(newChild))).second);
    } else {
      // There is a child by this name on disk and in the map. Check for a change in size.
      totalSize -= iter->second.size;
      iter->second.size = usage.bytes;
    }

    maybeReportSize();

    // If the child is a directory, plan to start watching it later. Note that IN_MODIFY events
    // are not generated for subdirectories (only files), so if we got an event on a directory it
    // must be create, move to, move from, or delete. In the latter two cases, the node wouldn't
    // exist anymore, so usage.isDir would be false. So, we know this directory is either
    // newly-created or newly moved in from elsewhere. In the creation case, we clearly need to
    // start watching the directory. In the moved-in case, we are probably already watching the
    // directory, however it is necessary to redo the watch because the path has changed and the
    // directory state may have become inconsistent in the time that the path was wrong.
    if (usage.isDir) {
      // We can't actually add the new watch now because we need to process the remaining
      // events from the last read() in order to make sure we're caught up with inotify's
      // state.
      pendingWatches.add(kj::mv(usage.path));
    }
  }

  struct DiskUsage {
    kj::String path;
    uint64_t bytes;
    bool isDir;
  };

  DiskUsage getDiskUsage(kj::StringPtr parent, kj::StringPtr name) {
    // Get the disk usage of the given file within the given parent directory. This is not exactly
    // the file size; it also includes estimates of storage overhead, such as rounding up to the
    // block size. If the file no longer exists, its size is reported as zero.

    kj::String path = parent == nullptr ? kj::heapString(name) : kj::str(parent, '/', name);
    for (;;) {
      struct stat stats;
      if (lstat(path.cStr(), &stats) >= 0) {
        // Success.

        DiskUsage result;
        result.path = kj::mv(path);
        result.isDir = S_ISDIR(stats.st_mode);

        // Count blocks, not length, because what we care about is allocated space.
        result.bytes = stats.st_blocks * 512;

        if (stats.st_nlink != 0) {
          // Note: sometimes the link count actually is zero; it often is, for example, during
          // `git init`, which rapidly creates and deletes some temporary files.

          // Divide by link count so that files with many hardlinks aren't overcounted.
          result.bytes /= stats.st_nlink;
        }

        return result;
      }

      // There was an error.
      int error = errno;
      switch (error) {
        case EINTR:
          // continue loop
          break;
        case ENOENT:   // File no longer exists...
        case ENOTDIR:  // ... and a parent directory was replaced.
          return {kj::mv(path), 0, false};
        default:
          // Default
          KJ_FAIL_SYSCALL("lstat", error, path);
      }
    }
  }

  void maybeReportSize() {
    // Don't send multiple reports at once. When the first one finishes we'll send another one if
    // the size has changed in the meantime.
    if (reportInFlight) return;

    // If the last reported size is still correct, don't report.
    if (reportedSize == totalSize) return;

    reportInFlight = true;

    // Wait 500ms before reporting to gather other changes.
    tasks.add(timer.afterDelay(500 * kj::MILLISECONDS)
        .then([this]() -> kj::Promise<void> {
      auto req = core.reportGrainSizeRequest();
      uint64_t sizeBeingReported = totalSize;
      req.setBytes(sizeBeingReported);

      return req.send().then([this,sizeBeingReported](auto) -> void {
        reportInFlight = false;
        reportedSize = sizeBeingReported;

        // If the size has changed further, initiate a new report.
        maybeReportSize();
      }, [this](kj::Exception&& e) {
        reportInFlight = false;

        if (e.getType() == kj::Exception::Type::DISCONNECTED) {
          // SandstormCore disconnected. Due to our CoreRedirector logic, it will restore itself
          // eventually, and in fact further calls to SandstormCore should block until than
          // happens. So, initiate a new report immediately.
          maybeReportSize();
        } else {
          // Some other error. Propagate.
          kj::throwFatalException(kj::mv(e));
        }
      });
    }));
  }

  void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(ERROR, exception);
  }
};

// =======================================================================================
// Termination handling:  Must kill child if parent terminates.
//
// We also terminate automatically if we don't receive any keep-alives in a 5-minute interval.

pid_t childPid = 0;
bool keepAlive = true;
uint32_t wakelockCount = 0;

void logSafely(const char* text) {
  // Log a message in an async-signal-safe way.

  while (text[0] != '\0') {
    ssize_t n = write(STDERR_FILENO, text, strlen(text));
    if (n < 0) return;
    text += n;
  }
}

#define SANDSTORM_LOG(text) \
  logSafely("** SANDSTORM SUPERVISOR: " text "\n")

void killChild() {
  if (childPid != 0) {
    kill(childPid, SIGKILL);
    childPid = 0;
  }

  // We don't have to waitpid() because when we exit the child will be adopted by init which will
  // automatically reap it.
}

[[noreturn]] void killChildAndExit(int status) {
  killChild();

  // TODO(cleanup):  Decide what exit status is supposed to mean.  Maybe it should just always be
  //   zero?
  _exit(status);
}

void signalHandler(int signo) {
  switch (signo) {
    case SIGALRM:
      if (keepAlive) {
        SANDSTORM_LOG("Grain still in use; staying up for now.");
        keepAlive = false;
        return;
      } else if (wakelockCount > 0) {
        SANDSTORM_LOG("Grain has been backgrounded; staying up for now.");
        return;
      }
      SANDSTORM_LOG("Grain no longer in use; shutting down.");
      killChildAndExit(0);

    case SIGINT:
    case SIGTERM:
      SANDSTORM_LOG("Grain supervisor terminated by signal.");
      killChildAndExit(0);

    default:
      // Some signal that should cause death.
      SANDSTORM_LOG("Grain supervisor crashed due to signal.");

//      // uncomment if trace is needed, but note that this is not really signal-safe.
//      {
//        void* trace[16];
//        uint n = backtrace(trace, 16);
//        KJ_LOG(ERROR, kj::strArray(kj::arrayPtr(trace, n), " "));
//      }

      killChildAndExit(1);
  }
}

int DEATH_SIGNALS[] = {
  // All signals that by default terminate the process.
  SIGHUP, SIGINT, SIGQUIT, SIGILL, SIGABRT, SIGFPE, SIGSEGV, SIGTERM, SIGUSR1, SIGUSR2, SIGBUS,
  SIGPOLL, SIGPROF, SIGSYS, SIGTRAP, SIGVTALRM, SIGXCPU, SIGXFSZ, SIGSTKFLT, SIGPWR
};

void registerSignalHandlers() {
  // Create a sigaction that runs our signal handler with all signals blocked.  Our signal handler
  // completes (or exits) quickly anyway, so let's not try to deal with it being interruptable.
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = &signalHandler;
  sigfillset(&action.sa_mask);

  // SIGALRM will fire every 1.5 minutes and will kill us if no keepalive was received in that
  // time.
  KJ_SYSCALL(sigaction(SIGALRM, &action, nullptr));

  // Other death signals simply kill us immediately.
  for (int signo: kj::ArrayPtr<int>(DEATH_SIGNALS)) {
    KJ_SYSCALL(sigaction(signo, &action, nullptr));
  }

  // Set up the SIGALRM timer to check every 1.5 minutes whether we're idle. If we haven't received
  // a keep-alive request in a 1.5-minute period, we kill ourselves. The client normally sends
  // keep-alives every minute. Note that it's not the end of the world if we miss one; the server
  // will transparently start back up on the next request from the client.
  // Note that this is not inherited over fork.
  struct itimerval timer;
  memset(&timer, 0, sizeof(timer));
  timer.it_interval.tv_sec = 90;
  timer.it_value.tv_sec = 90;
  KJ_SYSCALL(setitimer(ITIMER_REAL, &timer, nullptr));
}

// =======================================================================================

SupervisorMain::SupervisorMain(kj::ProcessContext& context)
    : context(context), systemConnector(&DEFAULT_CONNECTOR_INSTANCE) {
  // Make sure we didn't inherit a weird signal mask from the parent process.  Gotta do this as
  // early as possible so as not to confuse KJ code that deals with signals.
  sigset_t sigset;
  KJ_SYSCALL(sigemptyset(&sigset));
  KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigset, nullptr));
}

kj::MainFunc SupervisorMain::getMain() {
  return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                         "Runs a Sandstorm grain supervisor for the grain <grain-id>, which is "
                         "an instance of app <app-id>.  Executes <command> inside the grain "
                         "sandbox.")
      .addOptionWithArg({"uid"}, KJ_BIND_METHOD(*this, setUid), "<uid>",
                        "Use setuid sandbox rather than userns. Must start as root, but swiches "
                        "to <uid> to run the app.")
      .addOptionWithArg({"pkg"}, KJ_BIND_METHOD(*this, setPkg), "<path>",
                        "Set directory containing the app package.  "
                        "Defaults to '$SANDSTORM_HOME/var/sandstorm/apps/<app-name>'.")
      .addOptionWithArg({"var"}, KJ_BIND_METHOD(*this, setVar), "<path>",
                        "Set directory where grain's mutable persistent data will be stored.  "
                        "Defaults to '$SANDSTORM_HOME/var/sandstorm/grains/<grain-id>'.")
      .addOptionWithArg({'e', "env"}, KJ_BIND_METHOD(*this, addEnv), "<name>=<val>",
                        "Set the environment variable <name> to <val> inside the sandbox.  Note "
                        "that *no* environment variables are set by default.")
      .addOption({"proc"}, [this]() { setMountProc(true); return true; },
                 "Mount procfs inside the sandbox.  For security reasons, this is NOT "
                 "RECOMMENDED during normal use, but it may be useful for debugging.")
      .addOption({"stdio"}, [this]() { keepStdio = true; return true; },
                 "Don't redirect the sandbox's stdio.  Useful for debugging.")
      .addOption({"dev"}, [this]() { devmode = true; return true; },
                 "Allow some system calls useful for debugging which are blocked in production.")
      .addOption({"seccomp-dump-pfc"}, [this]() { seccompDumpPfc = true; return true; },
                 "Dump libseccomp PFC output.")
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

void SupervisorMain::setIsNew(bool isNew) {
  this->isNew = isNew;
}

void SupervisorMain::setMountProc(bool mountProc) {
  if (mountProc) {
    context.warning("WARNING: --proc is dangerous.  Only use it when debugging code you trust.");
  }
  this->mountProc = mountProc;
}

kj::MainBuilder::Validity SupervisorMain::setAppName(kj::StringPtr name) {
  if (name == nullptr || name.findFirst('/') != nullptr) {
    return "Invalid app name.";
  }
  appName = kj::heapString(name);
  return true;
}

kj::MainBuilder::Validity SupervisorMain::setGrainId(kj::StringPtr id) {
  if (id == nullptr || id.findFirst('/') != nullptr) {
    return "Invalid grain id.";
  }
  grainId = kj::heapString(id);
  return true;
}

kj::MainBuilder::Validity SupervisorMain::setPkg(kj::StringPtr path) {
  pkgPath = realPath(kj::heapString(path));
  return true;
}

kj::MainBuilder::Validity SupervisorMain::setVar(kj::StringPtr path) {
  varPath = realPath(kj::heapString(path));
  return true;
}

kj::MainBuilder::Validity SupervisorMain::setUid(kj::StringPtr arg) {
  KJ_IF_MAYBE(u, parseUInt(arg, 10)) {
    if (getuid() != 0) {
      return "must start as root to use --uid";
    }
    if (*u == 0) {
      return "can't run sandbox as root";
    }
    KJ_SYSCALL(seteuid(*u));
    sandboxUid = *u;
    return true;
  } else {
    return "UID must be a number";
  }
}

kj::MainBuilder::Validity SupervisorMain::addEnv(kj::StringPtr arg) {
  environment.add(kj::heapString(arg));
  return true;
}

kj::MainBuilder::Validity SupervisorMain::addCommandArg(kj::StringPtr arg) {
  command.add(kj::heapString(arg));
  return true;
}

// =====================================================================================

kj::MainBuilder::Validity SupervisorMain::run() {
  setupSupervisor();

  // Exits if another supervisor is still running in this sandbox.
  systemConnector->checkIfAlreadyRunning();

  if (sandboxUid == nullptr) {
    SANDSTORM_LOG("Starting up grain. Sandbox type: userns");
  } else {
    SANDSTORM_LOG("Starting up grain. Sandbox type: privileged");
  }

  registerSignalHandlers();

  // Create eventfd that we'll use to block app startup until we've received an RPC requiring
  // it. This is a hack to allow serving files out of the app's www directory without starting
  // the app.
  int _startEventFd;
  KJ_SYSCALL(_startEventFd = eventfd(0, EFD_CLOEXEC));
  kj::AutoCloseFd startEventFd(_startEventFd);

  // Allocate the API socket.
  int fds[2];
  KJ_SYSCALL(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, fds));

  // Now time to run the start command, in a further chroot.
  KJ_SYSCALL(childPid = fork());
  if (childPid == 0) {
    // We're in the child.
    KJ_SYSCALL(close(fds[0]));  // just to be safe, even though it's CLOEXEC.
    runChild(fds[1], kj::mv(startEventFd));
  } else {
    // We're in the supervisor.
    KJ_DEFER(killChild());
    KJ_SYSCALL(close(fds[1]));
    runSupervisor(fds[0], kj::mv(startEventFd));
  }
}

// =====================================================================================

void SupervisorMain::bind(kj::StringPtr src, kj::StringPtr dst, unsigned long flags) {
  // Contrary to the documentation of MS_BIND claiming this is no longer the case after 2.6.26,
  // mountflags are ignored on the initial bind.  We have to issue a subsequent remount to set
  // them.
  KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr, MS_BIND, nullptr), src, dst);
  KJ_SYSCALL(mount(src.cStr(), dst.cStr(), nullptr,
                   MS_BIND | MS_REMOUNT | MS_NOSUID | flags, nullptr),
      src, dst);
}

kj::String SupervisorMain::realPath(kj::StringPtr path) {
  char* cResult = realpath(path.cStr(), nullptr);
  if (cResult == nullptr) {
    int error = errno;
    if (error != ENOENT) {
      KJ_FAIL_SYSCALL("realpath", error, path);
    }

    // realpath() fails if the target doesn't exist, but our goal here is just to convert a
    // relative path to absolute whether it exists or not. So try resolving the parent instead.
    KJ_IF_MAYBE(slashPos, path.findLast('/')) {
      if (*slashPos == 0) {
        // Path is e.g. "/foo". The root directory obviously exists.
        return kj::heapString(path);
      } else {
        return kj::str(realPath(kj::heapString(path.slice(0, *slashPos))),
                       path.slice(*slashPos));
      }
    } else {
      // Path is a relative path with only one component.
      char* cwd = getcwd(nullptr, 0);
      KJ_DEFER(free(cwd));
      if (cwd[0] == '/' && cwd[1] == '\0') {
        return kj::str('/', path);
      } else {
        return kj::str(cwd, '/', path);
      }
    }
  }
  auto result = kj::heapString(cResult);
  free(cResult);
  return result;
}

// =====================================================================================

void SupervisorMain::setupSupervisor() {
  {
    // Put ourselves in a cgroup:
    auto pid = getpid();
    auto cgroupName = kj::str("grain-", grainId);
    Cgroup("/run/cgroup2")
      .getOrMakeChild(cgroupName)
      .addPid(pid);
  }

  // Enable no_new_privs so that once we drop privileges we can never regain them through e.g.
  // execing a suid-root binary.  Sandboxed apps should not need that.
  KJ_SYSCALL(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));

  closeFds();
  setResourceLimits();
  checkPaths();
  unshareOuter();
  setupFilesystem();
  setupStdio();

  // Note:  permanentlyDropSuperuser() is performed post-fork; see comment in function def.
}

void SupervisorMain::closeFds() {
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

  int saveFd = systemConnector->getSaveFd().orDefault(0);

  for (int fd: fds) {
    if (fd != saveFd) {
      // Ignore close errors -- we don't care, as long as the file is closed.  (Also, one close()
      // will always return EBADF because it's the directory FD closed in closedir().)
      close(fd);
    }
  }
}

void SupervisorMain::setResourceLimits() {
  struct rlimit limit;
  memset(&limit, 0, sizeof(limit));
  limit.rlim_cur = 1024;
  limit.rlim_max = 4096;
  KJ_SYSCALL(setrlimit(RLIMIT_NOFILE, &limit));
}

void SupervisorMain::checkPaths() {
  // Create or verify the pkg, var, and tmp directories.

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
  if (mkdir(kj::str("/tmp/sandstorm-grain").cStr(), 0770) < 0) {
    int error = errno;
    if (error != EEXIST) {
      KJ_FAIL_SYSCALL("mkdir(\"/tmp/sandstorm-grain\")", error);
    }
  }

  // Create the log file while we're still non-superuser.
  int logfd;
  KJ_SYSCALL(logfd = open(kj::str(varPath, "/log").cStr(),
      O_WRONLY | O_APPEND | O_CLOEXEC | O_CREAT, 0600));
  KJ_SYSCALL(close(logfd));
}

void SupervisorMain::writeSetgroupsIfPresent(const char *contents) {
  KJ_IF_MAYBE(fd, raiiOpenIfExists("/proc/self/setgroups", O_WRONLY | O_CLOEXEC)) {
    kj::FdOutputStream(kj::mv(*fd)).write(contents, strlen(contents));
  }
}

void SupervisorMain::writeUserNSMap(const char *type, kj::StringPtr contents) {
  kj::FdOutputStream(raiiOpen(kj::str("/proc/self/", type, "_map").cStr(), O_WRONLY | O_CLOEXEC))
      .write(contents.begin(), contents.size());
}

void SupervisorMain::unshareOuter() {
  if (sandboxUid == nullptr) {
    // Use user namespaces.
    pid_t uid = getuid(), gid = getgid();

    // Unshare all of the namespaces except network.  Note that unsharing the pid namespace is a
    // little odd in that it doesn't actually affect this process, but affects later children
    // created by it.
    KJ_SYSCALL(unshare(CLONE_NEWUSER | CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWPID));

    // Map ourselves as 1000:1000, since it costs nothing to mask the uid and gid.
    uid_t fakeUid = 1000;
    gid_t fakeGid = 1000;

    if (devmode) {
      // "Randomize" the UID and GID in dev mode. This catches app bugs where the app expects the
      // UID or GID to be always 1000, which is not true of servers that use the privileged sandbox
      // rather than the userns sandbox. (The "randomization" algorithm here is only meant to
      // appear random to a human. The funny-looking numbers are just arbitrary primes chosen
      // without much thought.)
      time_t now = time(nullptr);
      fakeUid = now * 4721 % 2000 + 1;
      fakeGid = now * 2791 % 2000 + 1;
    }

    writeSetgroupsIfPresent("deny\n");
    writeUserNSMap("uid", kj::str(fakeUid, " ", uid, " 1\n"));
    writeUserNSMap("gid", kj::str(fakeGid, " ", gid, " 1\n"));
  } else {
    // Use root privileges instead of user namespaces.

    // We need to raise our privileges to call unshare(), and to perform other setup that occurs
    // after unshare().
    KJ_SYSCALL(seteuid(0));

    // Unshare all of the namespaces except network.  Note that unsharing the pid namespace is a
    // little odd in that it doesn't actually affect this process, but affects later children
    // created by it.
    KJ_SYSCALL(unshare(CLONE_NEWNS | CLONE_NEWIPC | CLONE_NEWUTS | CLONE_NEWPID));
  }

  // To really unshare the mount namespace, we also have to make sure all mounts are private.
  // See the "SHARED SUBTREES" section of mount_namespaces(7) and the section "Changing the
  // propagation type of an existing mount" in mount(2). Cliffsnotes version: MS_PRIVATE sets
  // the "target" argument (in this case "/") to private, and MS_REC applies this recursively.
  // All other arguments are ignored.
  KJ_SYSCALL(mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr));

  // Set a dummy host / domain so the grain can't see the real one.  (unshare(CLONE_NEWUTS) means
  // these settings only affect this process and its children.)
  KJ_SYSCALL(sethostname("sandbox", 7));
  KJ_SYSCALL(setdomainname("sandbox", 7));
}

void SupervisorMain::makeCharDeviceNode(
    const char *name, const char* realName, int major, int minor) {
  // Creating a real device node with mknod won't work on any current kernel, and we're
  // currently stuck with the filesystem being nodev, so even if mknod were to work, the
  // resulting device node wouldn't function.
  auto dst = kj::str("dev/", name);
  KJ_SYSCALL(mknod(dst.cStr(), S_IFREG | 0666, 0));
  KJ_SYSCALL(mount(kj::str("/dev/", realName).cStr(), dst.cStr(), nullptr, MS_BIND, nullptr));
}

void mountTmpFs(const char *name, const char *dest) {
    KJ_SYSCALL(mount(name, dest, "tmpfs",
                     MS_NOSUID | MS_NODEV,
                     "size=16m,nr_inodes=4k,mode=770"));
}

void SupervisorMain::setupFilesystem() {
  // The root of our mount namespace will be the app package itself.  We optionally create
  // tmp, dev, and var.  tmp is an ordinary tmpfs.  dev is a read-only tmpfs that contains
  // a few safe device nodes.  var is the 'var/sandbox' directory inside the grain.
  //
  // Now for the tricky part: the supervisor needs to be able to see a little bit more.
  // In particular, it needs to be able to see the entire directory designated for the grain,
  // whereas the app only sees the "sandbox" subdirectory. We arrange for the the supervisor's
  // special directory to be ".", even though it's not mounted anywhere.

  // Set up the supervisor's directory. We immediately detach it from the mount tree, only
  // keeping a file descriptor, which we can later access via fchdir(). This prevents the
  // supervisor dir from being accessible to the app.
  bind(varPath, "/tmp/sandstorm-grain", MS_NODEV | MS_NOEXEC);
  auto supervisorDir = raiiOpen("/tmp/sandstorm-grain", O_RDONLY | O_DIRECTORY | O_CLOEXEC);
  KJ_SYSCALL(umount2("/tmp/sandstorm-grain", MNT_DETACH));

  // Bind the app package to "sandbox", which will be the grain's root directory.
  bind(pkgPath, "/tmp/sandstorm-grain", MS_NODEV | MS_RDONLY);

  // Change to that directory.
  KJ_SYSCALL(chdir("/tmp/sandstorm-grain"));

  // Optionally bind var, tmp, dev if the app requests it by having the corresponding directories
  // in the package.
  if (access("tmp", F_OK) == 0) {
    // Create a new tmpfs for this run.  We don't use a shared one or just /tmp for two reasons:
    // 1) tmpfs has no quota control, so a shared instance could be DoS'd by any one grain, or
    //    just used to effectively allocate more RAM than the grain is allowed.
    // 2) When we exit, the mount namespace disappears and the tmpfs is thus automatically
    //    unmounted.  No need for careful cleanup, and no need to implement a risky recursive
    //    delete.
    mountTmpFs("sandstorm-tmp", "tmp");
  }
  if (access("dev", F_OK) == 0) {
    KJ_SYSCALL(mount("sandstorm-dev", "dev", "tmpfs",
                     MS_NOATIME | MS_NOSUID | MS_NOEXEC | MS_NODEV,
                     "size=1m,nr_inodes=16,mode=755"));
    makeCharDeviceNode("null", "null", 1, 3);
    makeCharDeviceNode("zero", "zero", 1, 5);
    makeCharDeviceNode("random", "urandom", 1, 9);
    makeCharDeviceNode("urandom", "urandom", 1, 9);

    // Create /dev/shm so shm_open() and friends work. Note that even though /dev
    // is already a tmpfs, we need to mount a separate tmpfs for /dev/shm, because
    // the former will be read-only.
    //
    // TODO: it might be nice to have /dev/shm and /tmp share the same partition,
    // so we don't have to strictly separate their storage capacity. We could mount
    // a single tmpfs somewhere invisible, create subdirectories, and then bind-mount
    // them to their final destinations.
    KJ_SYSCALL(mkdir("dev/shm", 0700));
    mountTmpFs("sandstorm-shm", "dev/shm");

    KJ_SYSCALL(mount("dev", "dev", nullptr,
                     MS_REMOUNT | MS_BIND | MS_NOEXEC | MS_NOSUID | MS_NODEV | MS_RDONLY,
                     nullptr));
  }
  if (access("var", F_OK) == 0) {
    bind(kj::str(varPath, "/sandbox"), "var", MS_NODEV);
  }
  if (access("proc/cpuinfo", F_OK) == 0) {
    // Map in the real cpuinfo.
    bind("/proc/cpuinfo", "proc/cpuinfo", MS_NOSUID | MS_NOEXEC | MS_NODEV);
  }

  // Grab a reference to the old root directory.
  auto oldRootDir = raiiOpen("/", O_RDONLY | O_DIRECTORY | O_CLOEXEC);

  // Keep /proc around if requested.
  if (mountProc) {
    if (access("proc", F_OK) == 0) {
      // Mount it to retain permission to mount it.  This mount will be associated with the
      // wrong pid namespce.  We'll fix it after forking.  We have to bind it: we can't mount
      // a new copy because we don't have the appropriate permission on the active pid ns.
      KJ_SYSCALL(mount("/proc", "proc", nullptr, MS_BIND | MS_REC, nullptr));
    } else {
      mountProc = false;
    }
  }


  // OK, everything is bound, so we can pivot_root.
  KJ_SYSCALL(syscall(SYS_pivot_root, "/tmp/sandstorm-grain", "/tmp/sandstorm-grain"));

  // We're now in a very strange state: our root directory is the grain directory,
  // but the old root is mounted on top of the grain directory.  As far as I can tell,
  // there is no simple way to unmount the old root, since "/" and "/." both refer to the
  // grain directory.  Fortunately, we kept a reference to the old root.
  KJ_SYSCALL(fchdir(oldRootDir));
  KJ_SYSCALL(umount2(".", MNT_DETACH));
  KJ_SYSCALL(fchdir(supervisorDir));

  // Now "." is the grain's storage directory and "/" is the sandbox directory, i.e.
  // "/" == "./sandbox". Yes, this means the root directory is _below_ the current directory.
  // Crazy.
}

void SupervisorMain::setupStdio() {
  // Make sure stdin is /dev/null and set stderr to go to a log file.

  if (!keepStdio) {
    // We want to replace stdin with /dev/null because even if there is no input on stdin, it
    // could inadvertently be an FD with other powers.  For example, it might be a TTY, in which
    // case you could write to it or otherwise mess with the terminal.
    int devNull;
    KJ_SYSCALL(devNull = open("/dev/null", O_RDONLY | O_CLOEXEC));
    KJ_SYSCALL(dup2(devNull, STDIN_FILENO));
    KJ_SYSCALL(close(devNull));

    // We direct stderr to a log file for debugging purposes.
    // TODO(soon):  Rotate logs.
    int log;
    KJ_SYSCALL(log = open("log", O_WRONLY | O_APPEND | O_CLOEXEC));
    KJ_SYSCALL(dup2(log, STDERR_FILENO));
    KJ_SYSCALL(close(log));
  }

  // We will later make stdout a copy of stderr specifically for the sandboxed process.  In the
  // supervisor, stdout is how we tell our parent that we're ready to receive connections.
}

void SupervisorMain::setupSeccomp() {
  // Install a rudimentary seccomp blacklist.
  // TODO(security): Change this to a whitelist.

  scmp_filter_ctx ctx = seccomp_init(SCMP_ACT_ALLOW);
  if (ctx == nullptr)
    KJ_FAIL_SYSCALL("seccomp_init", 0);  // No real error code
  KJ_DEFER(seccomp_release(ctx));

#define CHECK_SECCOMP(call)                   \
  do {                                        \
    if (auto result = (call)) {               \
      KJ_FAIL_SYSCALL(#call, -result);        \
    }                                         \
  } while (0)

  // Native code only for now, so there are no seccomp_arch_add calls.

  // Redundant, but this is standard and harmless.
  CHECK_SECCOMP(seccomp_attr_set(ctx, SCMP_FLTATR_CTL_NNP, 1));

  // It's easy to inadvertently issue an x32 syscall (e.g. syscall(-1)).  Such syscalls
  // should fail, but there's no need to kill the issuer.
  CHECK_SECCOMP(seccomp_attr_set(ctx, SCMP_FLTATR_ACT_BADARCH, SCMP_ACT_ERRNO(ENOSYS)));

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wmissing-field-initializers"  // SCMP_* macros produce these
  // Disable some things that seem scary.
  if (!devmode) {
    // ptrace is scary
    CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ptrace), 0));
  } else {
    // Try to be somewhat safe with ptrace in dev mode.  Note that the ability to modify
    // orig_ax using ptrace allows a complete seccomp bypass.
    CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ptrace), 1,
      SCMP_A0(SCMP_CMP_EQ, PTRACE_POKEUSER)));
    CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ptrace), 1,
      SCMP_A0(SCMP_CMP_EQ, PTRACE_SETREGS)));
    CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ptrace), 1,
      SCMP_A0(SCMP_CMP_EQ, PTRACE_SETFPREGS)));
    CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(ptrace), 1,
      SCMP_A0(SCMP_CMP_EQ, PTRACE_SETREGSET)));
  }

  // Restrict the set of allowable network protocol families
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_GE, AF_NETLINK + 1)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_AX25)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_IPX)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_APPLETALK)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_NETROM)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_BRIDGE)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_ATMPVC)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_X25)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_ROSE)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_DECnet)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_NETBEUI)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_SECURITY)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EAFNOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A0(SCMP_CMP_EQ, AF_KEY)));

  // Disallow DCCP sockets due to Linux CVE-2017-6074.
  //
  // The `type` parameter to `socket()` can have SOCK_NONBLOCK and SOCK_CLOEXEC bitwise-or'd in,
  // so we need to mask those out for our check. The kernel defines a constant SOCK_TYPE_MASK
  // as 0x0f, but this constant doesn't appear to be in the headers, so we specify by hand.
  //
  // TODO(security): We should probably disallow everything except SOCK_STREAM and SOCK_DGRAM but
  //   I don't totally get how to write such conditionals with libseccomp. We should really dump
  //   libseccomp and write in BPF assembly, which is frankly much easier to understand.
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPROTONOSUPPORT), SCMP_SYS(socket), 1,
     SCMP_A1(SCMP_CMP_MASKED_EQ, 0x0f, SOCK_DCCP)));

  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(add_key), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(request_key), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(keyctl), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(syslog), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(uselib), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(personality), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(acct), 0));

  // 16-bit code is unnecessary in the sandbox, and modify_ldt is a historic source
  // of interesting information leaks.
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(modify_ldt), 0));

  // Despite existing at a 64-bit syscall, set_thread_area is only useful
  // for 32-bit programs.  64-bit programs use arch_prctl instead.
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(set_thread_area), 0));

  // Disable namespaces. Nested sandboxing could be useful but the attack surface is large.
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(unshare), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(mount), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(pivot_root), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(quotactl), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EPERM), SCMP_SYS(clone), 1,
      SCMP_A0(SCMP_CMP_MASKED_EQ, CLONE_NEWUSER, CLONE_NEWUSER)));

  // AIO is scary.
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_setup), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_destroy), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_getevents), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_submit), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(io_cancel), 0));

  // Scary vm syscalls
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(remap_file_pages), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(mbind), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(get_mempolicy), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(set_mempolicy), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(migrate_pages), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(move_pages), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(vmsplice), 0));

  // Scary futex operations
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(set_robust_list), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(get_robust_list), 0));

  // Utterly terrifying profiling operations
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(perf_event_open), 0));

  // Don't let apps specify their own seccomp filters, since seccomp filters are literally programs
  // that run in-kernel (albeit with a very limited instruction set).
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(EINVAL), SCMP_SYS(prctl), 1,
      SCMP_A0(SCMP_CMP_EQ, PR_SET_SECCOMP)));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(seccomp), 0));
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(bpf), 0));

  // New syscalls that don't seem useful to Sandstorm apps therefore we will disallow them.
  // TODO(cleanup): Can we somehow specify "disallow all calls greater than N" to preemptively
  //   disable things until we've reviewed them?
  CHECK_SECCOMP(seccomp_rule_add(ctx, SCMP_ACT_ERRNO(ENOSYS), SCMP_SYS(userfaultfd), 0));

  // TOOD(someday): See if we can get away with turning off mincore, madvise, sysinfo etc.

  // TODO(someday): Turn off POSIX message queues and other such esoteric features.

  if (seccompDumpPfc) {
    seccomp_export_pfc(ctx, 1);
  }

  CHECK_SECCOMP(seccomp_load(ctx));

#pragma GCC diagnostic pop
#undef CHECK_SECCOMP
}

void SupervisorMain::unshareNetwork() {
  // Unshare the network and set up a new loopback device.

  // Enter new network namespace.
  KJ_SYSCALL(unshare(CLONE_NEWNET));

  // Create a socket for our ioctls.
  int fd;
  KJ_SYSCALL(fd = socket(AF_INET, SOCK_DGRAM, IPPROTO_IP));
  KJ_DEFER(close(fd));

  // Bring up the loopback device.
  {
    // Set the address of "lo".
    struct ifreq ifr;
    memset(&ifr, 0, sizeof(ifr));
    strcpy(ifr.ifr_ifrn.ifrn_name, "lo");
    struct sockaddr_in* addr = reinterpret_cast<struct sockaddr_in*>(&ifr.ifr_ifru.ifru_addr);
    addr->sin_family = AF_INET;
    addr->sin_addr.s_addr = htonl(0x7F000001);  // 127.0.0.1
    KJ_SYSCALL(ioctl(fd, SIOCSIFADDR, &ifr));

    // Set flags to enable "lo".
    memset(&ifr.ifr_ifru, 0, sizeof(ifr.ifr_ifru));
    ifr.ifr_ifru.ifru_flags = IFF_LOOPBACK | IFF_UP | IFF_RUNNING;
    KJ_SYSCALL(ioctl(fd, SIOCSIFFLAGS, &ifr));
  }
}

void SupervisorMain::maybeFinishMountingProc() {
  // Mount proc if it was requested.  Note that this must take place after fork() to get the
  // correct pid namespace.  We must keep a copy of proc mounted at all times; otherwise we
  // lose the privilege of mounting proc.

  if (mountProc) {
    auto oldProc = raiiOpen("proc", O_RDONLY | O_DIRECTORY | O_CLOEXEC);

    // This puts the new proc onto the namespace root, which is mostly inaccessible.
    KJ_SYSCALL(mount("proc", "/", nullptr, MS_MOVE, nullptr));

    // Now mount the new proc in the right place.
    KJ_SYSCALL(mount("proc", "proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, nullptr));

    // And get rid of the old one.
    KJ_SYSCALL(fchdir(oldProc));
    KJ_SYSCALL(umount2(".", MNT_DETACH));
    KJ_SYSCALL(chdir("/"));
  }
}

void SupervisorMain::permanentlyDropSuperuser() {
  KJ_IF_MAYBE(ruid, sandboxUid) {
    // setuid() to non-zero implicitly drops capabilities.
    KJ_SYSCALL(setresuid(*ruid, *ruid, *ruid));
  } else {
    // Drop all Linux "capabilities".  (These are Linux/POSIX "capabilities", which are not true
    // object-capabilities, hence the quotes.)
    //
    // This unfortunately must be performed post-fork (in both parent and child), because the child
    // needs to do one final unshare().

    struct __user_cap_header_struct hdr;
    struct __user_cap_data_struct data[2];
    hdr.version = _LINUX_CAPABILITY_VERSION_3;
    hdr.pid = 0;
    memset(data, 0, sizeof(data));  // All capabilities disabled!
    KJ_SYSCALL(capset(&hdr, data));
  }

  // Sandstorm data is private.  Don't let other users see it.  But, do grant full access to the
  // group.  The idea here is that you might have a dedicated sandstorm-sandbox user account but
  // define a special "sandstorm-admin" group which includes that account as well as a real user
  // who should have direct access to the data.
  umask(0007);
}

void SupervisorMain::enterSandbox() {
  // Fully enter the sandbox.  Called only by the child process.
  KJ_SYSCALL(chdir("/"));

  // Unshare the network, creating a new loopback interface.
  unshareNetwork();

  // Mount proc if --proc was passed.
  maybeFinishMountingProc();

  // Now actually drop all credentials.
  permanentlyDropSuperuser();

  // Use seccomp to disable dangerous syscalls. We do this last so that we can disable things
  // that we just used above, like unshare() or setuid().
  setupSeccomp();
}

// =====================================================================================

void SupervisorMain::DefaultSystemConnector::checkIfAlreadyRunning() const {
  // Attempt to connect to any existing supervisor and call keepAlive().  If successful, we
  // don't want to start a new instance; we should use the existing instance.

  // TODO(soon):  There's a race condition if two supervisors are started up in rapid succession.
  //   We could maybe avoid that with some filesystem locking.  It's currently unlikely to happen
  //   in practice because it would require sending a request to the shell server to open the
  //   grain, then restarting the shell server, then opening the grain again, all before the
  //   first supervisor finished starting.  Or, I suppose, running two shell servers and trying
  //   to open the same grain in both at once.

  auto ioContext = kj::setupAsyncIo();

  // Connect to the client.
  auto addr = ioContext.provider->getNetwork().parseAddress("unix:socket")
      .wait(ioContext.waitScope);
  kj::Own<kj::AsyncIoStream> connection;
  KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
    connection = addr->connect().wait(ioContext.waitScope);
  })) {
    // Failed to connect.  Assume socket is stale.
    return;
  }

  // Set up RPC.
  capnp::TwoPartyVatNetwork vatNetwork(*connection, capnp::rpc::twoparty::Side::CLIENT);
  auto client = capnp::makeRpcClient(vatNetwork);

  // Restore the default capability (the Supervisor interface).
  capnp::MallocMessageBuilder message;
  auto hostId = message.initRoot<capnp::rpc::twoparty::VatId>();
  hostId.setSide(capnp::rpc::twoparty::Side::SERVER);
  Supervisor::Client cap = client.bootstrap(hostId).castAs<Supervisor>();

  // Call keepAlive().
  auto promise = cap.keepAliveRequest().send();
  KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
    promise.wait(ioContext.waitScope);
  })) {
    // Failed to keep-alive.  Supervisor must have died just as we were connecting to it.  Go
    // ahead and start a new one.
    return;
  }

  // We successfully connected and keepalived the existing supervisor, so we can exit.  The
  // caller is expecting us to write to stdout when the stocket is ready, so do that anyway.
  KJ_SYSCALL(write(STDOUT_FILENO, "Already running...\n", strlen("Already running...\n")));
  _exit(0);
  KJ_UNREACHABLE;
}

// =====================================================================================

[[noreturn]] void SupervisorMain::runChild(int apiFd, kj::AutoCloseFd startEventFd) {
  // We are the child.

  enterSandbox();

  // Wait until we get the signal to start. (It's important to do this after entering the sandbox
  // so that the parent process has permission to send SIGKILL to the child even in
  // privileged-mode.)
  uint64_t dummy;
  KJ_SYSCALL(read(startEventFd, &dummy, sizeof(dummy)));

  // Reset all signal handlers to default.  (exec() will leave ignored signals ignored, and KJ
  // code likes to ignore e.g. SIGPIPE.)
  // TODO(cleanup):  Is there a better way to do this?
  for (uint i = 0; i < NSIG; i++) {
    signal(i, SIG_DFL);  // Only possible error is EINVAL (invalid signum); we don't care.
  }

  // Unblock all signals.  (Yes, the signal mask is inherited over exec...)
  sigset_t sigmask;
  sigemptyset(&sigmask);
  KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigmask, nullptr));

  // Make sure the API socket is on FD 3.
  if (apiFd == 3) {
    // Socket end already has correct fd.  Unset CLOEXEC.
    KJ_SYSCALL(fcntl(apiFd, F_SETFD, 0));
  } else {
    // dup socket to correct fd.
    KJ_SYSCALL(dup2(apiFd, 3));
    KJ_SYSCALL(close(apiFd));
  }

  // Redirect stdout to stderr, so that our own stdout serves one purpose:  to notify the parent
  // process when we're ready to accept connections.  We previously directed stderr to a log file.
  KJ_SYSCALL(dup2(STDERR_FILENO, STDOUT_FILENO));

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
};

// -----------------------------------------------------------------------------
// Persistence and requirements management

class RequirementsMembranePolicy;
class ChildTokenMembranePolicy;

SystemPersistent::Client newIncomingSaveHandler(AppPersistent<>::Client&& cap,
                                                kj::Own<RequirementsMembranePolicy> membrane,
                                                SandstormCore::Client sandstormCore);

class RevokerImpl final: public Handle::Server {
public:
  explicit RevokerImpl(kj::Own<kj::PromiseFulfiller<void>> fulfiller)
      : fulfiller(kj::mv(fulfiller)) {}
  ~RevokerImpl() noexcept(false) {
    fulfiller->reject(KJ_EXCEPTION(DISCONNECTED, "capability has been revoked"));
  }

private:
  kj::Own<kj::PromiseFulfiller<void>> fulfiller;
};

class RequirementsMembranePolicy final: public capnp::MembranePolicy, public kj::Refcounted {
  // A MembranePolicy that revokes when some MembraneRequirements are no longer held.

public:
  explicit RequirementsMembranePolicy(SandstormCore::Client sandstormCore)
      : sandstormCore(kj::mv(sandstormCore)) {}
  // Create root policy, which only needs to translate save/restore calls.

  RequirementsMembranePolicy(
      SandstormCore::Client sandstormCore,
      capnp::List<MembraneRequirement>::Reader requirements,
      kj::Promise<void> revoked,
      SystemPersistent::RevocationObserver::Client observer,
      kj::Own<RequirementsMembranePolicy> parent)
      : sandstormCore(kj::mv(sandstormCore)),
        childInfo(ChildInfo {
          newOwnCapnp(requirements),
          parent->mergeRevoked(kj::mv(revoked)).fork(),
          kj::mv(observer),
          kj::mv(parent)
        }) {}

  kj::Maybe<capnp::Capability::Client> inboundCall(
      uint64_t interfaceId, uint16_t methodId, capnp::Capability::Client target) override {
    // Don't shut down as long as we're receiving inbound calls.
    sandstorm::keepAlive = true;

    if (interfaceId == capnp::typeId<capnp::Persistent<>>() ||
        interfaceId == capnp::typeId<SystemPersistent>()) {
      return newIncomingSaveHandler(kj::mv(target).castAs<AppPersistent<>>(),
                                    kj::addRef(*this), sandstormCore);
    } else if (interfaceId == capnp::typeId<AppPersistent<>>()) {
      KJ_UNIMPLEMENTED("can't call AppPersistent.save() from outside grain");
    } else if (interfaceId == capnp::typeId<MainView<>>()) {
      KJ_UNIMPLEMENTED("MainView methods are private to the supervisor");
    } else {
      return nullptr;
    }
  }
  kj::Maybe<capnp::Capability::Client> outboundCall(
      uint64_t interfaceId, uint16_t methodId, capnp::Capability::Client target) override {
    if (interfaceId == capnp::typeId<AppPersistent<>>()) {
      // Treat as unimplemented to give apps a convenient way to attempt an internal save before
      // falling back to an external save.
      KJ_UNIMPLEMENTED("can't call AppPersistent.save() on capabilities from outside the grain");
    } else if (interfaceId == capnp::typeId<capnp::Persistent<>>() ||
               interfaceId == capnp::typeId<SystemPersistent>()) {
      KJ_FAIL_REQUIRE("Cannot directly call save() on capabilities outside the grain. "
        "Use SandstormApi.save() instead.");
    } else {
      return nullptr;
    }
  }
  kj::Own<MembranePolicy> addRef() override {
    return kj::addRef(*this);
  }
  kj::Maybe<kj::Promise<void>> onRevoked() override {
    KJ_IF_MAYBE(c, childInfo) {
      return c->revoked.addBranch();
    } else {
      return nullptr;
    }
  }

  MembranePolicy& rootPolicy() override {
    KJ_IF_MAYBE(c, childInfo) {
      return c->parent->rootPolicy();
    } else {
      return *this;
    }
  }

  capnp::Capability::Client importInternal(capnp::Capability::Client internal,
      capnp::MembranePolicy& exportPolicy, capnp::MembranePolicy& importPolicy) override {
    // If a capability originally from this app is returned to it, we drop all membrane
    // requirements, so that the app gets its original object back.
    //
    // TODO(security): Is this really a good idea? Maybe apps should opt-in to dropping
    //   requirements on re-import? We could create a loopback membrane here.
    return kj::mv(internal);
  }

  capnp::Capability::Client exportExternal(capnp::Capability::Client external,
      capnp::MembranePolicy& importPolicy, capnp::MembranePolicy& exportPolicy) override {
    // A capability came in and is going back out. Maybe we're passing it to a third-party grain.
    // We'd like for this grain not to have to proxy all requests, so we'll ask the host grain
    // to enforce the membrane requirements from here on out.

    KJ_IF_MAYBE(c, childInfo) {
      auto req = kj::mv(external).castAs<SystemPersistent>()
          .addRequirementsRequest();
      // TODO(soon): Also merge requirements from exportPolicy.
      // TODO(soon): We actually have to make several addRequirements() calls to send across all
      //   the observers for our parents, ugh.
      req.adoptRequirements(kj::downcast<RequirementsMembranePolicy>(importPolicy)
          .collectRequirements(capnp::Orphanage::getForMessageContaining(
              SystemPersistent::AddRequirementsParams::Builder(req))));
      req.setObserver(c->observer);
      return req.send().getCap();
    } else {
      // We weren't enforcing any requirements anyway.
      return kj::mv(external);
    }
  }

  capnp::Orphan<capnp::List<MembraneRequirement>> collectRequirements(capnp::Orphanage orphanage) {
    kj::Vector<capnp::List<MembraneRequirement>::Reader> parts;

    auto ptr = this;
    bool empty = true;
    for (;;) {
      KJ_IF_MAYBE(c, ptr->childInfo) {
        if (c->requirements.size() > 0) {
          empty = false;
          parts.add(c->requirements);
        }
        ptr = c->parent;
      } else {
        break;
      }
    }

    if (empty) {
      return {};
    } else {
      return orphanage.newOrphanConcat(parts.asPtr());
    }
  }

  kj::Own<RequirementsMembranePolicy> addRequirements(
      SystemPersistent::AddRequirementsParams::Reader params) {
    auto paf = kj::newPromiseAndFulfiller<void>();
    auto observer = params.getObserver();
    auto req = observer.dropWhenRevokedRequest();
    req.setHandle(kj::heap<RevokerImpl>(kj::mv(paf.fulfiller)));
    auto revoked = req.send().ignoreResult()
        .then([]() -> kj::Promise<void> { return kj::NEVER_DONE; })
        .exclusiveJoin(kj::mv(paf.promise));

    return kj::refcounted<RequirementsMembranePolicy>(
        sandstormCore, params.getRequirements(),
        kj::mv(revoked), kj::mv(observer), kj::addRef(*this));
  }

private:
  SandstormCore::Client sandstormCore;

  struct ChildInfo {
    OwnCapnp<capnp::List<MembraneRequirement>> requirements;
    kj::ForkedPromise<void> revoked;
    SystemPersistent::RevocationObserver::Client observer;
    kj::Own<RequirementsMembranePolicy> parent;
  };

  kj::Maybe<ChildInfo> childInfo;

  kj::Promise<void> mergeRevoked(kj::Promise<void>&& promise) {
    KJ_IF_MAYBE(c, childInfo) {
      return promise.exclusiveJoin(c->revoked.addBranch());
    } else {
      return kj::mv(promise);
    }
  }
};

class ChildTokenMembranePolicy final: public capnp::MembranePolicy, public kj::Refcounted {
  // A special MembranePolicy to handle the case of an internal capability that was created by
  // restore(). If save() is called directly on this capability, it should create a child token.
  // But if any other capabilities are obtained through it, then regular membrane requirements
  // logic applies.

public:
  ChildTokenMembranePolicy(kj::Own<RequirementsMembranePolicy> policy,
                           capnp::Data::Reader token,
                           SandstormCore::Client sandstormCore)
      : policy(kj::mv(policy)),
        token(kj::heapArray<const byte>(token)),
        sandstormCore(kj::mv(sandstormCore)) {}

  class SaveHandler final: public SystemPersistent::Server {
  public:
    SaveHandler(capnp::Capability::Client cap, kj::Own<ChildTokenMembranePolicy> membrane)
        : cap(kj::mv(cap)), membrane(kj::mv(membrane)) {}

    kj::Promise<void> save(SaveContext context) override {
      // Save by creating a child token.
      auto owner = context.getParams().getSealFor();
      auto req = membrane->sandstormCore.makeChildTokenRequest();
      req.setParent(membrane->token);
      req.setOwner(owner);
      req.adoptRequirements(membrane->policy->collectRequirements(
          capnp::Orphanage::getForMessageContaining(
              SandstormCore::MakeChildTokenParams::Builder(req))));
      return req.send().then([context](auto args) mutable -> void {
        context.getResults().setSturdyRef(args.getToken());
      });
    }

    kj::Promise<void> addRequirements(AddRequirementsContext context) override {
      auto child = kj::heap<ChildTokenMembranePolicy>(
          membrane->policy->addRequirements(context.getParams()),
          membrane->token, membrane->sandstormCore);
      context.releaseParams();
      auto results = context.getResults();
      results.setCap(capnp::membrane(cap, kj::mv(child)).castAs<SystemPersistent>());
      return kj::READY_NOW;
    }

  private:
    capnp::Capability::Client cap;
    kj::Own<ChildTokenMembranePolicy> membrane;
  };

  kj::Maybe<capnp::Capability::Client> inboundCall(
      uint64_t interfaceId, uint16_t methodId, capnp::Capability::Client target) override {
    if (interfaceId == capnp::typeId<capnp::Persistent<>>() ||
        interfaceId == capnp::typeId<SystemPersistent>()) {
      return capnp::Persistent<capnp::Data, ApiTokenOwner>::Client(
          kj::heap<SaveHandler>(kj::mv(target), kj::addRef(*this)));
    }

    return policy->inboundCall(interfaceId, methodId, kj::mv(target));
  }
  kj::Maybe<capnp::Capability::Client> outboundCall(
      uint64_t interfaceId, uint16_t methodId, capnp::Capability::Client target) override {
    return policy->outboundCall(interfaceId, methodId, kj::mv(target));
  }
  kj::Own<MembranePolicy> addRef() override {
    return kj::addRef(*this);
  }
  kj::Maybe<kj::Promise<void>> onRevoked() override {
    return policy->onRevoked();
  }
  MembranePolicy& rootPolicy() override {
    return policy->rootPolicy();
  }

  capnp::Capability::Client importExternal(capnp::Capability::Client external) override {
    // Revert to regular policy.
    return policy->importExternal(kj::mv(external));
  }
  capnp::Capability::Client exportInternal(capnp::Capability::Client internal) override {
    // Revert to regular policy.
    return policy->exportInternal(kj::mv(internal));
  }

  capnp::Capability::Client importInternal(capnp::Capability::Client internal,
      capnp::MembranePolicy& exportPolicy, capnp::MembranePolicy& importPolicy) override {
    // Only be called on root policy.
    KJ_UNREACHABLE;
  }

  capnp::Capability::Client exportExternal(capnp::Capability::Client external,
      capnp::MembranePolicy& importPolicy, capnp::MembranePolicy& exportPolicy) override {
    // Only be called on root policy.
    KJ_UNREACHABLE;
  }

private:
  kj::Own<RequirementsMembranePolicy> policy;
  kj::Array<const byte> token;
  SandstormCore::Client sandstormCore;
};

class IncomingSaveHandler final: public SystemPersistent::Server {
  // When a save() call is intercepted by the MembranePolicy, it is redirected to this wrapper.

public:
  IncomingSaveHandler(AppPersistent<>::Client&& cap,
                      kj::Own<RequirementsMembranePolicy> membrane,
                      SandstormCore::Client sandstormCore)
      : cap(kj::mv(cap)),
        membrane(kj::mv(membrane)),
        sandstormCore(kj::mv(sandstormCore)) {}

  kj::Promise<void> save(SaveContext context) override {
    return cap.saveRequest().send()
        .then([this,context](capnp::Response<AppPersistent<>::SaveResults> response) mutable {
      auto owner = context.getParams().getSealFor();
      auto req = sandstormCore.makeTokenRequest();
      req.initRef().setAppRef(response.getObjectId());
      req.setOwner(owner);
      req.adoptRequirements(membrane->collectRequirements(
          capnp::Orphanage::getForMessageContaining(
              SandstormCore::MakeTokenParams::Builder(req))));
      // TODO(someday): Do something with response.getLabel()?
      return req.send().then([context](auto args) mutable -> void {
        context.getResults().setSturdyRef(args.getToken());
      });
    });
  }

  kj::Promise<void> addRequirements(AddRequirementsContext context) override {
    auto child = membrane->addRequirements(context.getParams());
    context.releaseParams();
    auto results = context.getResults();
    results.setCap(capnp::membrane(cap, kj::mv(child)).castAs<SystemPersistent>());
    return kj::READY_NOW;
  }

private:
  AppPersistent<>::Client cap;
  kj::Own<RequirementsMembranePolicy> membrane;
  SandstormCore::Client sandstormCore;
};

SystemPersistent::Client newIncomingSaveHandler(AppPersistent<>::Client&& cap,
                                                kj::Own<RequirementsMembranePolicy> membrane,
                                                SandstormCore::Client sandstormCore) {
  return kj::heap<IncomingSaveHandler>(kj::mv(cap), kj::mv(membrane), kj::mv(sandstormCore));
}

// -----------------------------------------------------------------------------

static void decrementWakelock() {
  --sandstorm::wakelockCount;
  if (sandstorm::wakelockCount == 0) {
    SANDSTORM_LOG("Grain's backgrounding has been disabled; staying up for now.");
    // Stay alive for one more keepAlive tick after disabling backgrounding.
    sandstorm::keepAlive = true;
  }
}

class WakeLockInfo {
public:
  OngoingNotification::Client ongoingNotification;

  WakeLockInfo(OngoingNotification::Client& ongoingNotification)
    : ongoingNotification(ongoingNotification) {}
  WakeLockInfo(WakeLockInfo&&) = default;
  KJ_DISALLOW_COPY(WakeLockInfo);
};

class WakelockSet: private kj::TaskSet::ErrorHandler {
public:

  class WrappedOngoingNotification final: public PersistentOngoingNotification::Server {
  public:
    WrappedOngoingNotification(OngoingNotification::Client ongoingNotification,
                               WakelockSet& wakelockSet)
      : ongoingNotification(ongoingNotification), wakelockSet(wakelockSet), isCancelled(false) {
      ++sandstorm::wakelockCount;
    }
    WrappedOngoingNotification(WrappedOngoingNotification&&) = delete;
    KJ_DISALLOW_COPY(WrappedOngoingNotification);

    ~WrappedOngoingNotification() noexcept(false) {
      if (!isCancelled) {
        isCancelled = true;
        decrementWakelock();
      }
    }

    void cancel() {
      if (!isCancelled) {
        isCancelled = true;
        decrementWakelock();
      }
    }

    kj::Promise<void> cancel(CancelContext context) override {
      cancel();
      return ongoingNotification.cancelRequest().send().ignoreResult();
    }

    kj::Promise<void> save(SaveContext context) override {
      return wakelockSet.save(ongoingNotification).then([context] (auto args) mutable -> void {
        context.getResults().setSturdyRef(args.getToken());
      });
    }
  private:
    OngoingNotification::Client ongoingNotification;
    WakelockSet& wakelockSet;
    bool isCancelled;
  };

  WakelockSet(kj::StringPtr grainId, SandstormCore::Client& sandstormCore)
    : grainId(grainId), sandstormCore(sandstormCore), tasks(*this), counter(1) {}
    // Fun fact. This counter starts at 1 because javascript considers 0 to be a falsey value
    // and this makes it harder to check in the frontend. It's easier to just fix it here.

  capnp::RemotePromise<sandstorm::SandstormCore::MakeTokenResults>
  save(OngoingNotification::Client client) {
    ++sandstorm::wakelockCount;
    auto id = counter++;
    wakelockMap.insert(std::make_pair(id, WakeLockInfo(client)));
    auto req = sandstormCore.makeTokenRequest();
    req.getRef().setWakeLockNotification(id);
    req.getOwner().setFrontend();
    return req.send();
  }

  void drop(uint32_t wakelockId) {
    auto iter = wakelockMap.find(wakelockId);
    if (iter == wakelockMap.end()) {
      KJ_LOG(WARNING, "Tried to drop a wakelock that has already been deleted");
      return;
    }
    wakelockMap.erase(iter);
    decrementWakelock();
  }

  PersistentOngoingNotification::Client restore(uint32_t wakelockId) {
    auto iter = wakelockMap.find(wakelockId);
    KJ_REQUIRE(iter != wakelockMap.end(), "Wakelock id not found");
    return kj::heap<WakelockSet::WrappedOngoingNotification>(iter->second.ongoingNotification,
                                                             *this);
  }

  std::map<uint32_t, WakeLockInfo> wakelockMap;
private:
  void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(ERROR, exception);
  }

  kj::StringPtr grainId;
  SandstormCore::Client sandstormCore;
  kj::TaskSet tasks;
  uint32_t counter;
};

class SupervisorMain::SandstormApiImpl final:
  public SandstormApi<>::Server, public kj::Refcounted, private kj::TaskSet::ErrorHandler  {
public:
  SandstormApiImpl(WakelockSet& wakelockSet, kj::StringPtr grainId,
                   SandstormCore::Client& sandstormCore)
    : wakelockSet(wakelockSet), grainId(grainId), sandstormCore(sandstormCore), tasks(*this) {}
  // TODO(someday):  Implement API.
//  kj::Promise<void> publish(PublishContext context) override {

//  }

//  kj::Promise<void> registerAction(RegisterActionContext context) override {

//  }

//  kj::Promise<void> shareCap(ShareCapContext context) override {

//  }

//  kj::Promise<void> shareView(ShareViewContext context) override {

//  }

  kj::Promise<void> save(SaveContext context) override {
    auto args = context.getParams();
    KJ_REQUIRE(args.hasCap(), "Cannot save a null capability.");
    auto req = args.getCap().template castAs<SystemPersistent>().saveRequest();
    auto grainOwner = req.getSealFor().initGrain();
    grainOwner.setGrainId(grainId);
    grainOwner.setSaveLabel(args.getLabel());
    return req.send().then([context](auto args) mutable -> void {
      context.getResults().setToken(args.getSturdyRef());
    });
  }

  kj::Promise<void> restore(RestoreContext context) override {
    auto req = sandstormCore.restoreRequest();
    req.setToken(context.getParams().getToken());
    return req.send().then([context](auto args) mutable -> void {
      context.getResults().setCap(args.getCap());
    });
  }

  kj::Promise<void> drop(DropContext context) override {
    auto req = sandstormCore.dropRequest();
    req.setToken(context.getParams().getToken());
    return req.send().ignoreResult();
  }

//  kj::Promise<void> deleted(DeletedContext context) override {

//  }

  kj::Promise<void> stayAwake(StayAwakeContext context) override {
    //   The supervisor maintains a map of "wake locks". Since wake locks
    //   by their nature do not outlast the process, this map can be held in-memory. When
    //   `stayAwake()` is called, the supervisor:
    //   - Constructs a wrapper around `OngoingNotification` to be passed to the front-end. The
    //     wrapper is persistent.
    //   - Calls SandstormCore.getOwnerNotificationTarget().addOngoing(), passing along
    //     this new wrapper object as well as the `displayInfo` provided from the app.
    //   - On the handle returned by `addOngoing()`, immediately calls `save()` (with
    //     sealFor = this grain; see `SystemPersistent`), storing the resulting `SturdyRef`
    //     (actually, just an API token) into a wrapped handle.
    //   - Constructs a wrapped handle object and returns it from `stayAwake()`.
    //   - When that handle is destroyed, calls SandstormCore.drop() on the handle SturdyRef stored
    //     and calls cancel on the original ongoing notification passed from the app.
    //   - When SandstormCore calls the wrapper OngoingNotification's `cancel()` method, forwards
    //     that call to the app.
    //   - When SandstormCore drops the wrapper OngoingNotification (via `Supervisor.drop()`),
    //     if it's the last reference, then disable backgrounding.
    //
    //   Meanwhile, until the point that SandstormCore calls cancel on the OngoingNotification, the
    //   supervisor does not kill itself during its regular keep-alive check.
    //
    //   The main reason this is so complicated is that the front-end is supposed to be able to
    //   restart independently of the app, but the `OngoingNotification` provided by the app is
    //   not required to be persistent. The supervisor thus takes care of the complication of
    //   dealing with persistence through front-end restarts.
    auto params = context.getParams();

    OngoingNotification::Client notification =
      kj::heap<WakelockSet::WrappedOngoingNotification>(params.getNotification(), wakelockSet);

    auto req = sandstormCore.getOwnerNotificationTargetRequest().send().getOwner()
      .addOngoingRequest();
    req.setDisplayInfo(params.getDisplayInfo());
    req.setNotification(notification);

    context.releaseParams();
    // We actually don't need to catch errors here, since if an error occurs, the notification will
    // be dropped and cleanup will happen automatically.
    return req.send().then([this, context](auto args) mutable {
      auto req = args.getHandle().template castAs<SystemPersistent>().saveRequest();
      auto grainOwner = req.getSealFor().initGrain();
      grainOwner.setGrainId(grainId);
      grainOwner.getSaveLabel().setDefaultText("ongoing notification handle");
      return req.send().then([this, context](auto args) mutable -> void {
        SANDSTORM_LOG("Grain has enabled backgrounding.");
        context.getResults().setHandle(kj::heap<WakelockHandle>(args.getSturdyRef(), *this));
      });
    });
  }

  kj::Promise<void> backgroundActivity(BackgroundActivityContext context) override {
    auto params = context.getParams();
    auto req = sandstormCore.backgroundActivityRequest(params.totalSize());
    req.setEvent(params.getEvent());
    context.releaseParams();
    return req.send().ignoreResult();
  }

  kj::Promise<void> getIdentityId(GetIdentityIdContext context) override {
    auto params = context.getParams();
    auto req = sandstormCore.getIdentityIdRequest(params.totalSize());
    req.setIdentity(params.getIdentity());
    context.releaseParams();
    return req.send().then([context](auto args) mutable -> void {
      context.getResults().setId(args.getId());
    });
  }

  kj::Promise<void> schedule(ScheduleContext context) override {
    auto params = context.getParams();
    auto req = sandstormCore.scheduleRequest(params.totalSize());
    req.setName(params.getName());
    req.setCallback(params.getCallback());
    auto sched = params.getSchedule();
    switch(sched.which()) {
      case ScheduledJob::Schedule::ONE_SHOT: {
          auto reqOneShot = req.getSchedule().getOneShot();
          auto argOneShot = sched.getOneShot();
          reqOneShot.setWhen(argOneShot.getWhen());
          reqOneShot.setSlack(argOneShot.getSlack());
          break;
        }
      case ScheduledJob::Schedule::PERIODIC:
        req.getSchedule().setPeriodic(sched.getPeriodic());
        break;
      default:
        KJ_UNIMPLEMENTED("Unknown schedule type.");
    }
    // There aren't any actually results to copy over, but we do want
    // to wait for the SandstormCore to return before we do, so the
    // app doesn't prematurely think the scheduling is complete.
    return req.send().ignoreResult();
  }

private:
  void dropHandle(kj::ArrayPtr<byte> sturdyRef) {
    auto req = sandstormCore.dropRequest();
    req.setToken(sturdyRef);
    // TODO(someday): Handle failures for drop? Currently, if the the frontend never drops the
    // notification or calls cancel on it, then this handle will essentially leak.
    tasks.add(req.send().ignoreResult());
  }

  void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(ERROR, exception);
  }

  class WakelockHandle final: public Handle::Server {
  public:
    WakelockHandle(capnp::Data::Reader sturdyRef,
                   SandstormApiImpl& api)
      : sturdyRef(kj::heapArray(sturdyRef)), api(api) {
    }
    ~WakelockHandle() noexcept(false) {
      api.dropHandle(sturdyRef);
    }

  private:
    kj::Array<byte> sturdyRef;
    SandstormApiImpl& api;
  };

  WakelockSet& wakelockSet;
  kj::StringPtr grainId;
  SandstormCore::Client sandstormCore;
  kj::TaskSet tasks;
};

class SupervisorMain::SupervisorImpl final: public Supervisor::Server {
public:
  inline SupervisorImpl(kj::UnixEventPort& eventPort, MainView<>::Client&& mainView,
                        kj::Own<RequirementsMembranePolicy> rootMembranePolicy,
                        WakelockSet& wakelockSet, kj::AutoCloseFd startAppEvent,
                        SandstormCore::Client sandstormCore, kj::Own<CapRedirector> coreRedirector)
      : eventPort(eventPort), mainView(kj::mv(mainView)),
        rootMembranePolicy(kj::mv(rootMembranePolicy)),
        wakelockSet(wakelockSet), sandstormCore(kj::mv(sandstormCore)),
        coreRedirector(kj::mv(coreRedirector)), startAppEvent(kj::mv(startAppEvent)) {}

  kj::Promise<void> getMainView(GetMainViewContext context) override {
    ensureStarted();
    context.getResults(capnp::MessageSize {4, 1})
        .setView(capnp::membrane(mainView, kj::addRef(*rootMembranePolicy)));
    return kj::READY_NOW;
  }

  kj::Promise<void> keepAlive(KeepAliveContext context) override {
    sandstorm::keepAlive = true;

    auto params = context.getParams();
    if (params.hasCore()) {
      coreRedirector->setTarget(params.getCore());
    }

    return kj::READY_NOW;
  }

  kj::Promise<void> syncStorage(SyncStorageContext context) override {
    auto fd = raiiOpen(".", O_RDONLY | O_DIRECTORY);
    KJ_SYSCALL(syncfs(fd));
    return kj::READY_NOW;
  }

  kj::Promise<void> shutdown(ShutdownContext context) override {
    SANDSTORM_LOG("Grain shutdown requested.");
    killChildAndExit(0);
  }

  kj::Promise<void> watchLog(WatchLogContext context) override {
    auto params = context.getParams();
    auto logFile = sandstorm::raiiOpen("log", O_RDONLY | O_CLOEXEC);

    // Seek to desired start point.
    struct stat stats;
    KJ_SYSCALL(fstat(logFile, &stats));
    uint64_t requestedBacklog = params.getBacklogAmount();
    uint64_t backlog = kj::min(requestedBacklog, stats.st_size);
    KJ_SYSCALL(lseek(logFile, stats.st_size - backlog, SEEK_SET));

    // If the existing log file doesn't cover the whole request, check the previous log file.
    kj::Maybe<kj::Promise<void>> firstWrite;
    if (stats.st_size < requestedBacklog) {
      KJ_IF_MAYBE(log1, raiiOpenIfExists("log.1", O_RDONLY)) {
        struct stat stats1;
        KJ_SYSCALL(fstat(*log1, &stats1));
        uint64_t requestedBacklog1 = requestedBacklog - stats.st_size;
        uint64_t backlog1 = kj::min(requestedBacklog1, stats1.st_size);
        KJ_SYSCALL(lseek(*log1, stats1.st_size - backlog1, SEEK_SET));

        kj::FdInputStream in(log1->get());
        auto req = params.getStream().writeRequest();
        auto data = req.initData(backlog1);
        in.read(data.begin(), backlog1);
        firstWrite = req.send().ignoreResult();
      }
    }

    // Create the watcher.
    auto watcher = kj::heap<LogWatcher>(eventPort, "log", kj::mv(logFile), params.getStream());

    KJ_IF_MAYBE(f, firstWrite) {
      watcher->addTask(kj::mv(*f));
    }

    context.releaseParams();
    context.getResults(capnp::MessageSize { 4, 1 }).setHandle(kj::mv(watcher));
    return kj::READY_NOW;
  }

  kj::Promise<void> restore(RestoreContext context) override {
    // # Wraps `MainView.restore()`. Can also restore capabilities hosted by the supervisor.
    ensureStarted();
    auto params = context.getParams();
    auto objectId = params.getRef();

    switch (objectId.which()) {
      case SupervisorObjectId<>::WAKE_LOCK_NOTIFICATION: {
        context.getResults().setCap(wakelockSet.restore(objectId.getWakeLockNotification()));
        return kj::READY_NOW;
      }
      case SupervisorObjectId<>::APP_REF: {
        auto req = mainView.restoreRequest();
        req.setObjectId(objectId.getAppRef());
        auto cap = req.send().getCap();

        auto policy = kj::refcounted<ChildTokenMembranePolicy>(
            kj::addRef(*rootMembranePolicy), params.getParentToken(), sandstormCore);

        context.getResults().setCap(capnp::membrane(kj::mv(cap), kj::mv(policy)));
        return kj::READY_NOW;
      }
      default:
        KJ_FAIL_REQUIRE("Unknown objectId type");
    }
  }

  kj::Promise<void> drop(DropContext context) override {
    ensureStarted();
    auto objectId = context.getParams().getRef();

    if (objectId.which() == SupervisorObjectId<>::WAKE_LOCK_NOTIFICATION) {
      wakelockSet.drop(objectId.getWakeLockNotification());
      return kj::READY_NOW;
    } else {
      KJ_FAIL_REQUIRE("Supervisor can only drop wakelocks for now.");
    }
  }

  kj::Promise<void> getWwwFileHack(GetWwwFileHackContext context) override {
    context.allowCancellation();

    auto params = context.getParams();
    auto path = params.getPath();

    {
      // Prohibit non-canonical requests.
      auto parts = split(path, '/');
      if (parts.back().size() == 0) parts.removeLast();  // allow trailing '/'
      for (auto part: parts) {
        if (part.size() == 0 ||
            (part.size() == 1 && part[0] == '.') ||
            (part.size() == 2 && part[0] == '.' && part[1] == '.')) {
          context.getResults(capnp::MessageSize {4, 0})
              .setStatus(Supervisor::WwwFileStatus::NOT_FOUND);
          return kj::READY_NOW;
        }
      }
    }

    auto fullPath = kj::str("sandbox/www/", path);
    KJ_IF_MAYBE(fd, raiiOpenIfExists(fullPath, O_RDONLY)) {
      struct stat stats;
      KJ_SYSCALL(fstat(*fd, &stats));

      if (S_ISREG(stats.st_mode)) {
        auto stream = params.getStream();
        context.releaseParams();
        auto req = stream.expectSizeRequest();
        req.setSize(stats.st_size);
        auto expectSizeTask = req.send();
        auto inStream = kj::heap<kj::FdInputStream>(kj::mv(*fd));
        return pump(*inStream, kj::mv(stream)).attach(kj::mv(inStream), kj::mv(expectSizeTask));
      } else if (S_ISDIR(stats.st_mode)) {
        context.getResults(capnp::MessageSize {4, 0})
            .setStatus(Supervisor::WwwFileStatus::DIRECTORY);
        return kj::READY_NOW;
      } else {
        KJ_FAIL_ASSERT("not a regular file");
      }
    } else {
      context.getResults(capnp::MessageSize {4, 0})
          .setStatus(Supervisor::WwwFileStatus::NOT_FOUND);
      return kj::READY_NOW;
    }
  }

private:
  kj::UnixEventPort& eventPort;
  MainView<>::Client mainView;  // INTERNAL TO rootMembranePolicy; use carefully
  kj::Own<RequirementsMembranePolicy> rootMembranePolicy;
  WakelockSet& wakelockSet;
  SandstormCore::Client sandstormCore;
  kj::Own<CapRedirector> coreRedirector;
  kj::AutoCloseFd startAppEvent;

  void ensureStarted() {
    // Ensure that the app has been started.
    if (startAppEvent != nullptr) {
      uint64_t one = 1;
      ssize_t n;
      KJ_SYSCALL(n = write(startAppEvent, &one, sizeof(one)));
      KJ_ASSERT(n == sizeof(one));
      startAppEvent = nullptr;
    }
  }

  class LogWatcher final: public Handle::Server, private kj::TaskSet::ErrorHandler {
  public:
    explicit LogWatcher(kj::UnixEventPort& eventPort, kj::StringPtr logPath,
                        kj::AutoCloseFd logFileParam, ByteStream::Client stream)
        : logFile(kj::mv(logFileParam)),
          inotify(makeInotifyFd()),
          inotifyObserver(eventPort, inotify, kj::UnixEventPort::FdObserver::OBSERVE_READ),
          stream(kj::mv(stream)),
          tasks(*this) {
      KJ_SYSCALL(inotify_add_watch(inotify, logPath.cStr(), IN_MODIFY));
      tasks.add(watchLoop());
    }

    void addTask(kj::Promise<void> task) {
      // HACK for watchLog().
      tasks.add(kj::mv(task));
    }

  private:
    kj::AutoCloseFd logFile;
    kj::AutoCloseFd inotify;
    kj::UnixEventPort::FdObserver inotifyObserver;
    ByteStream::Client stream;
    kj::TaskSet tasks;
    off_t lastOffset = 0;

    void taskFailed(kj::Exception&& exception) override {
      KJ_LOG(ERROR, exception);
    }

    kj::Promise<void> watchLoop() {
      // Exhaust all events from the inotify queue, because edge triggering.
      // Luckily we don't actually have to interpret the events because we're only waiting on
      // one type of event.
      for (;;) {
        byte buffer[sizeof(struct inotify_event) + NAME_MAX + 1];
        ssize_t n;
        KJ_NONBLOCKING_SYSCALL(n = read(inotify, buffer, sizeof(buffer)));
        if (n < 0) break;
        KJ_ASSERT(n > 0);
      }

      // Check for recent rotation.
      struct stat stats;
      KJ_SYSCALL(fstat(logFile, &stats));
      if (lastOffset > stats.st_size) {
        // Looks like log was rotated.
        lastOffset = 0;
        KJ_SYSCALL(lseek(logFile, 0, SEEK_SET));
      }

      // Read all unread data from logFile and send it to the stream.
      // TODO(perf): Flow control? Currently we avoid asking for very much data at once.
      for (;;) {
        auto req = stream.writeRequest();
        auto orphanage =
            capnp::Orphanage::getForMessageContaining<ByteStream::WriteParams::Builder>(req);
        auto orphan = orphanage.newOrphan<capnp::Data>(4096);
        auto data = orphan.get();

        size_t n = kj::FdInputStream(logFile.get())
            .tryRead(data.begin(), data.size(), data.size());
        bool done = n < data.size();
        if (done) {
          orphan.truncate(n);
        }
        req.adoptData(kj::mv(orphan));

        tasks.add(req.send().ignoreResult());

        if (done) break;
      }

      KJ_SYSCALL(lastOffset = lseek(logFile, 0, SEEK_CUR));

      // OK, now wait for more.
      return inotifyObserver.whenBecomesReadable().then([this]() {
        return watchLoop();
      });
    }

    static kj::AutoCloseFd makeInotifyFd() {
      int ifd;
      KJ_SYSCALL(ifd = inotify_init1(IN_NONBLOCK | IN_CLOEXEC));
      return kj::AutoCloseFd(ifd);
    }
  };
};

// -----------------------------------------------------------------------------

constexpr SupervisorMain::DefaultSystemConnector SupervisorMain::DEFAULT_CONNECTOR_INSTANCE;

class SupervisorMain::DefaultSystemConnector::ErrorHandlerImpl: public kj::TaskSet::ErrorHandler {
public:
  void taskFailed(kj::Exception&& exception) override {
    KJ_LOG(ERROR, "connection failed", exception);
  }
};

kj::Promise<void> SupervisorMain::DefaultSystemConnector::run(
    kj::AsyncIoContext& ioContext, Supervisor::Client mainCap,
    kj::Own<CapRedirector> coreRedirector) const {
  auto listener = kj::heap<TwoPartyServerWithClientBootstrap>(
      kj::mv(mainCap), kj::mv(coreRedirector));

  unlink("socket");  // Clear stale socket, if any.
  return ioContext.provider->getNetwork().parseAddress("unix:socket", 0).then(
      [KJ_MVCAP(listener)](kj::Own<kj::NetworkAddress>&& addr) mutable {
    auto serverPort = addr->listen();

    // The front-end knows we're ready to accept connections when we write something to stdout.
    KJ_SYSCALL(write(STDOUT_FILENO, "Listening...\n", strlen("Listening...\n")));

    auto promise = listener->listen(kj::mv(serverPort));
    return promise.attach(kj::mv(listener));
  });
}

// -----------------------------------------------------------------------------

[[noreturn]] void SupervisorMain::runSupervisor(int apiFd, kj::AutoCloseFd startEventFd) {
  // We're currently in a somewhat dangerous state: our root directory is controlled
  // by the app.  If glibc reads, say, /etc/nsswitch.conf, the grain could take control
  // of the supervisor.  Fix this by chrooting to the supervisor directory.
  // TODO(someday): chroot somewhere that's guaranteed to be empty instead, so that if the
  //   supervisor storage is itself compromised it can't be used to execute arbitrary code in
  //   the supervisor process.
  KJ_SYSCALL(chroot("."));

  permanentlyDropSuperuser();
  setupSeccomp();

  // TODO(soon): Somehow make sure all grandchildren die if supervisor dies. Currently SIGKILL
  //   on the supervisor won't give it a chance to kill the sandbox pid tree. Perhaps the
  //   supervisor should actually be the app's root process? We'd have to more carefully handle
  //   SIGCHLD in that case and also worry about signals sent from the app process.

  kj::UnixEventPort::captureSignal(SIGCHLD);
  auto ioContext = kj::setupAsyncIo();

  // Detect child exit.
  auto exitPromise = ioContext.unixEventPort.onSignal(SIGCHLD).then([this](siginfo_t info) {
    KJ_ASSERT(childPid != 0);
    int status;
    KJ_SYSCALL(waitpid(childPid, &status, 0));
    childPid = 0;
    KJ_ASSERT(WIFEXITED(status) || WIFSIGNALED(status));
    if (WIFSIGNALED(status)) {
      context.exitError(kj::str(
          "** SANDSTORM SUPERVISOR: App exited due to signal ", WTERMSIG(status),
          " (", strsignal(WTERMSIG(status)), ")."));
    } else {
      context.exitError(kj::str(
          "** SANDSTORM SUPERVISOR: App exited with status code: ", WEXITSTATUS(status)));
    }
  }).eagerlyEvaluate([this](kj::Exception&& e) {
    context.exitError(kj::str(
        "** SANDSTORM SUPERVISOR: Uncaught exception waiting for child process:\n", e));
  });

  auto coreRedirector = kj::refcounted<CapRedirector>();
  SandstormCore::Client coreCap = static_cast<capnp::Capability::Client>(
    kj::addRef(*coreRedirector)).castAs<SandstormCore>();

  // Compute grain size and watch for changes.
  DiskUsageWatcher diskWatcher(ioContext.unixEventPort, ioContext.provider->getTimer(), coreCap);
  auto diskWatcherTask = diskWatcher.init();

  // Set up the RPC connection to the app and export the supervisor interface.
  auto appConnection = ioContext.lowLevelProvider->wrapSocketFd(apiFd,
      kj::LowLevelAsyncIoProvider::ALREADY_CLOEXEC |
      kj::LowLevelAsyncIoProvider::TAKE_OWNERSHIP);
  capnp::TwoPartyVatNetwork appNetwork(*appConnection, capnp::rpc::twoparty::Side::SERVER);
  WakelockSet wakelockSet(grainId, coreCap);

  SandstormApi<>::Client api = kj::heap<SandstormApiImpl>(wakelockSet, grainId, coreCap);
  auto rootMembranePolicy = kj::refcounted<RequirementsMembranePolicy>(coreCap);
  api = capnp::reverseMembrane(kj::mv(api), rootMembranePolicy->addRef());
  auto server = capnp::makeRpcServer(appNetwork, kj::mv(api));

  // Limit outstanding calls from the app to 1MiW (8MiB) in order to prevent an errant or malicious
  // app from consuming excessive RAM elsewhere in the system.
  server.setFlowLimit(1u << 20);

  // Get the app's UiView by restoring a null SturdyRef from it.
  capnp::MallocMessageBuilder message;
  auto hostId = message.initRoot<capnp::rpc::twoparty::VatId>();
  hostId.setSide(capnp::rpc::twoparty::Side::CLIENT);
  MainView<>::Client app = server.bootstrap(hostId).castAs<MainView<>>();

  // Set up the external RPC interface, re-exporting the UiView.
  // TODO(someday):  If there are multiple front-ends, or the front-ends restart a lot, we'll
  //   want to wrap the UiView and cache session objects.  Perhaps we could do this by making
  //   them persistable, though it's unclear how that would work with SessionContext.
  Supervisor::Client mainCap = kj::heap<SupervisorImpl>(
      ioContext.unixEventPort, kj::mv(app), kj::mv(rootMembranePolicy),
      wakelockSet, kj::mv(startEventFd), coreCap, kj::addRef(*coreRedirector));

  auto acceptTask = systemConnector->run(ioContext, kj::mv(mainCap), kj::mv(coreRedirector));

  // Wait for disconnect or accept loop failure or disk watch failure, then exit. Also rotate log
  // every 512k (thus having at most 1MB of logs at a time).
  acceptTask.exclusiveJoin(kj::mv(diskWatcherTask))
            .exclusiveJoin(appNetwork.onDisconnect())
            .exclusiveJoin(rotateLog(ioContext.provider->getTimer(),
                                     STDERR_FILENO, "log", 512u << 10))
            .wait(ioContext.waitScope);

  // Only onDisconnect() would return normally (rather than throw), so the app must have
  // disconnected (i.e. from the Cap'n Proto API socket).

  // Hmm, app disconnected API socket. The app probably exited and we just haven't gotten the
  // signal yet, so sleep for a moment to let it arrive, so that we can report the exit status.
  // Otherwise kill.
  ioContext.provider->getTimer().afterDelay(1 * kj::SECONDS)
      .exclusiveJoin(kj::mv(exitPromise))
      .wait(ioContext.waitScope);

  SANDSTORM_LOG("App disconnected API socket but didn't actually exit; killing it.");
  killChildAndExit(1);
}

}  // namespace sandstorm
