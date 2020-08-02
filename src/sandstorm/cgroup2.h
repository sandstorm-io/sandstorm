#ifndef SANDSTORM_CGROUP2_H_
#define SANDSTORM_CGROUP2_H_

#include <sys/types.h>  // For pid_t
#include <kj/io.h>

namespace sandstorm {
class Cgroup {
  // A Linux control group (version 2).

  public:
    class FreezeHandle {
      // A handle for a currently-frozen cgroup. When the handle is
      // destroyed, the cgroup is unfrozen.

      friend class Cgroup;
      public:
        FreezeHandle() = delete;
        KJ_DISALLOW_COPY(FreezeHandle);
        FreezeHandle(FreezeHandle&&) noexcept = default;

        ~FreezeHandle() noexcept(false);
      private:
        kj::AutoCloseFd fd;

        FreezeHandle(kj::AutoCloseFd&& fd);
    };

    Cgroup() = delete;
    KJ_DISALLOW_COPY(Cgroup);
    Cgroup(Cgroup&&) noexcept = default;

    Cgroup(kj::StringPtr path);
    // Open the cgroup corresponding to the directory `path`.

    Cgroup getOrMakeChild(kj::StringPtr path);
    // Open a cgroup that is a child of this one, creating it if it does not
    // exist.

    void removeChild(kj::StringPtr path);
    // Delete a child of this cgroup. The child must not contain any
    // processes.

    void addPid(pid_t pid);
    // Add the given process to the cgroup.

    FreezeHandle freeze();
    // Freeze the cgroup, suspending all processes within in. The cgroup will
    // be unfrozen when the returned handle is dropped.
  private:
    Cgroup(kj::AutoCloseFd&& dirfd);
    kj::AutoCloseFd dirfd;
};
};

#endif
