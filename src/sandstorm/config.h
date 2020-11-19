#ifndef SANDSTORM_CONFIG_H_
#define SANDSTORM_CONFIG_H_

#include <kj/string.h>

namespace sandstorm {

struct UserIds {
  uid_t uid = 0;
  gid_t gid = 0;
  kj::Array<gid_t> groups;
};

struct Config {
  kj::Maybe<uint> httpsPort;
  kj::Array<uint> ports;
  uint mongoPort = 3001;
  UserIds uids;
  kj::String bindIp = kj::str("127.0.0.1");
  kj::String rootUrl = nullptr;
  kj::String wildcardHost = nullptr;
  kj::String ddpUrl = nullptr;
  kj::String mailUrl = nullptr;
  kj::String updateChannel = nullptr;
  kj::String sandcatsHostname = nullptr;
  bool allowDemoAccounts = false;
  bool isTesting = false;
  bool allowDevAccounts = false;
  bool hideTroubleshooting = false;
  uint smtpListenPort = 30025;
  kj::Maybe<kj::String> privateKeyPassword = nullptr;
  kj::Maybe<kj::String> termsPublicId = nullptr;
  kj::Maybe<kj::String> stripeKey = nullptr;
  kj::Maybe<kj::String> stripePublicKey = nullptr;

  bool allowLegacyRelaxedCSP = true;
};

// Read and return the config file from `path`.
//
// If `parseUids` is true, we initialize `uids` from SERVER_USER.  This requires shelling
// out to id(1).  If false, we ignore SERVER_USER.
Config readConfig(const char *path, bool parseUids);

}; // namespace sandstorm

#endif
