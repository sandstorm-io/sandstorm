#include <fcntl.h>
#include <kj/io.h>
#include "util.h"
#include "sandbox.h"

namespace sandstorm::sandbox {

static void writeSetgroupsIfPresent(const char *contents) {
  KJ_IF_MAYBE(fd, raiiOpenIfExists("/proc/self/setgroups", O_WRONLY | O_CLOEXEC)) {
    kj::FdOutputStream(kj::mv(*fd)).write(contents, strlen(contents));
  }
}

static void writeUserNSMap(const char *type, kj::StringPtr contents) {
  kj::FdOutputStream(raiiOpen(kj::str("/proc/self/", type, "_map").cStr(), O_WRONLY | O_CLOEXEC))
      .write(contents.begin(), contents.size());
}

void hideUserGroupIds(uid_t realUid, gid_t realGid, bool randomize) {
    uid_t fakeUid = 1000;
    gid_t fakeGid = 1000;

    if (randomize) {
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
    writeUserNSMap("uid", kj::str(fakeUid, " ", realUid, " 1\n"));
    writeUserNSMap("gid", kj::str(fakeGid, " ", realGid, " 1\n"));
}

};
