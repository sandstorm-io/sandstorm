#pragma once
// Utility functions for setting up a sandbox.
//
// TODO: right now some of the sandbox code from the supervisor is duplicated
// in the code for taking backups. We should factor all of that out and move
// it here; right now only a few pieces have been moved.

#include <unistd.h>

namespace sandstorm::sandbox {

void hideUserGroupIds(uid_t realUid, gid_t realGid, bool randomize);
// Use user namespaces to mask the real user- and group- ids as seen
// by a grain. If randomize is true, the the uids are chosen at random
// (weakly; do not rely on this being particularly good randomness).
// otherwise, we choose 1000:1000.
};
