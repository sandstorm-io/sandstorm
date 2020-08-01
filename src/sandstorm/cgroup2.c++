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
  KJ_SYSCALL_HANDLE_ERRORS(mkdirat(dirfd.get(), path.cStr(), 0700)) {
    case EEXIST:
      break;
    default:
      KJ_FAIL_SYSCALL("mkdirat()", error);
  }

  return Cgroup(raiiOpenAt(dirfd.get(), path, O_DIRECTORY|O_CLOEXEC));
}

void Cgroup::removeChild(kj::StringPtr path) {
  KJ_SYSCALL(unlinkat(dirfd.get(), path.cStr(), AT_REMOVEDIR));
}

void Cgroup::addPid(pid_t pid) {
  auto procsfd = raiiOpenAt(dirfd.get(), "cgroup.procs", O_WRONLY);
  auto pidStr = kj::str(pid);
  auto cStr = pidStr.cStr();
  KJ_SYSCALL(write(procsfd.get(), cStr, strlen(cStr)));
}
};
