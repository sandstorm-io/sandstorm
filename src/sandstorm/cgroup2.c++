#include <sandstorm/cgroup2.h>
#include <sandstorm/util.h>

#include <kj/debug.h>

namespace sandstorm {
  Cgroup::Cgroup(kj::StringPtr path)
    : dirfd(raiiOpen(path, O_DIRECTORY|O_CLOEXEC))
  {}

  Cgroup::Cgroup(kj::AutoCloseFd&& dirfd)
    : dirfd(kj::mv(dirfd))
  {}

  Cgroup Cgroup::getOrMakeChild(kj::StringPtr path) {
    int status;
    do {
      errno = 0;
      status = mkdirat(dirfd.get(), path.cStr(), 0700);
    } while(status != 0 && errno == EINTR);

    if(status < 0) {
      KJ_REQUIRE(errno == EEXIST);
    }

    return Cgroup(raiiOpenAt(dirfd.get(), path, O_DIRECTORY|O_CLOEXEC));
  }

  void Cgroup::addPid(pid_t pid) {
    auto procsfd = raiiOpenAt(dirfd.get(), "cgroup.procs", O_WRONLY);
    auto pidStr = kj::str(pid);
    auto cStr = pidStr.cStr();
    KJ_SYSCALL(write(procsfd.get(), cStr, strlen(cStr)));
  }
};
