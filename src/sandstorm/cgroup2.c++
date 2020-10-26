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

  return getChild(path);
}

Cgroup Cgroup::getChild(kj::StringPtr path) {
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

kj::Maybe<Cgroup::FreezeHandle> Cgroup::freeze() {
  KJ_IF_MAYBE(freezeFd, raiiOpenAtIfExists(dirfd.get(), "cgroup.freeze", O_WRONLY)) {
    KJ_SYSCALL(write(freezeFd->get(), "1\n", 2));
    return Cgroup::FreezeHandle(kj::mv(*freezeFd));
  } else {
    return nullptr;
  }
}

Cgroup::FreezeHandle::FreezeHandle(kj::AutoCloseFd&& fd) : fd(kj::mv(fd)) {}

Cgroup::FreezeHandle::~FreezeHandle() noexcept(false) {
  int freezeFd = fd.get();
  if(freezeFd >= 0) {
    KJ_SYSCALL(write(freezeFd, "0\n", 2));
  }
}

};
