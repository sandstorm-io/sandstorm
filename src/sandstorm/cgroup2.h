#ifndef SANDSTORM_CGROUP2_H_
#define SANDSTORM_CGROUP2_H_

#include <sys/types.h>  // For pid_t
#include <kj/io.h>

namespace sandstorm {
  class Cgroup {
    // A Linux control group (version 2).

    public:
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
    private:
      Cgroup(kj::AutoCloseFd&& dirfd);
      kj::AutoCloseFd dirfd;
  };
};

#endif
