#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdlib.h>
#include <kj/debug.h>
#include <kj/parse/char.h>

#include "util.h"
#include "config.h"

namespace sandstorm {

// =======================================================================================
// id(1) handling
//
// We can't use getpwnam(), etc. in a static binary, so we shell out to id(1) instead.
// This is to set credentials to our user account before we start the server.

namespace idParser {
// A KJ parser for the output of id(1).

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wglobal-constructors"

namespace p = kj::parse;
using Input = p::IteratorInput<char, const char*>;

template <char delimiter, typename SubParser>
auto delimited(SubParser& subParser) -> decltype(auto) {
  // Create a parser that parses several instances of subParser separated by the given delimiter.

  typedef p::OutputType<SubParser, Input> Element;
  return p::transform(p::sequence(subParser,
      p::many(p::sequence(p::exactChar<delimiter>(), subParser))),
      [](Element&& first, kj::Array<Element>&& rest) {
    auto result = kj::heapArrayBuilder<Element>(rest.size() + 1);
    result.add(kj::mv(first));
    for (auto& e: rest) result.add(kj::mv(e));
    return result.finish();
  });
}

constexpr auto username = p::charsToString(p::oneOrMore(
    p::nameChar.orAny("-.$").orRange(0x80, 0xff)));
// It's a bit ambiguous what characters are allowed in usernames. Usually usernames must match:
//     ^[a-z_][a-z0-9_-]*[$]?$
// However, it seems this may be configurable. We'll try to be lenient here by allowing letters,
// digits, -, _, ., $, and any non-ASCII character.

constexpr auto nameNum = p::sequence(p::integer, p::discard(p::optional(
    p::sequence(p::exactChar<'('>(), username, p::exactChar<')'>()))));

struct Assignment {
  kj::String name;
  kj::Array<uint64_t> values;
};

auto assignment = p::transform(
    p::sequence(p::identifier, p::exactChar<'='>(), delimited<','>(nameNum)),
    [](kj::String&& name, kj::Array<uint64_t>&& ids) {
  return Assignment { kj::mv(name), kj::mv(ids) };
});

auto parser = p::sequence(delimited<' '>(assignment), p::discardWhitespace, p::endOfInput);

#pragma GCC diagnostic pop

}  // namespace idParser

// =======================================================================================

kj::Array<uint> parsePorts(kj::Maybe<uint> httpsPort, kj::StringPtr portList) {
  auto portsSplitOnComma = split(portList, ',');
  size_t numHttpPorts = portsSplitOnComma.size();
  size_t numHttpsPorts;
  kj::Array<uint> result;

  // If the configuration has a https port, then add it first.
  KJ_IF_MAYBE(portNumber, httpsPort) {
    numHttpsPorts = 1;
    result = kj::heapArray<uint>(numHttpsPorts + numHttpPorts);
    result[0] = *portNumber;
  } else {
    numHttpsPorts = 0;
    result = kj::heapArray<uint>(numHttpsPorts + numHttpPorts);
  }

  for (size_t i = 0; i < portsSplitOnComma.size(); i++) {
    KJ_IF_MAYBE(portNumber, parseUInt(trim(portsSplitOnComma[i]), 10)) {
      result[i + numHttpsPorts] = *portNumber;
    } else {
      KJ_FAIL_REQUIRE("invalid config value PORT", portList);
    }
  }

  return kj::mv(result);
}

kj::Maybe<UserIds> getUserIds(kj::StringPtr name) {
  // We can't use getpwnam() in a statically-linked binary, so we shell out to id(1).  lol.

  int fds[2];
  KJ_SYSCALL(pipe2(fds, O_CLOEXEC));

  pid_t child;
  KJ_SYSCALL(child = fork());
  if (child == 0) {
    // id(1) actually localizes the word "groups". Make sure the locale is set to C to prevent this.
    KJ_SYSCALL(setenv("LANG", "C", true));
    KJ_SYSCALL(unsetenv("LANGUAGE"));
    KJ_SYSCALL(unsetenv("LC_ALL"));
    KJ_SYSCALL(unsetenv("LC_MESSAGES"));

    KJ_SYSCALL(dup2(fds[1], STDOUT_FILENO));
    KJ_SYSCALL(execlp("id", "id", name.cStr(), EXEC_END_ARGS));
    KJ_UNREACHABLE;
  }

  close(fds[1]);
  KJ_DEFER(close(fds[0]));

  auto idOutput = readAll(fds[0]);

  int status;
  KJ_SYSCALL(waitpid(child, &status, 0));
  if (!WIFEXITED(status) || WEXITSTATUS(status) != 0) {
    return nullptr;
  }

  idParser::Input input(idOutput.begin(), idOutput.end());
  KJ_IF_MAYBE(assignments, idParser::parser(input)) {
    UserIds result;
    bool sawUid = false, sawGid = false;
    for (auto& assignment: *assignments) {
      if (assignment.name == "uid") {
        KJ_ASSERT(assignment.values.size() == 1, "failed to parse output of id(1)", idOutput);
        result.uid = assignment.values[0];
        sawUid = true;
      } else if (assignment.name == "gid") {
        KJ_ASSERT(assignment.values.size() == 1, "failed to parse output of id(1)", idOutput);
        result.gid = assignment.values[0];
        sawGid = true;
      } else if (assignment.name == "groups") {
        result.groups = KJ_MAP(g, assignment.values) -> gid_t { return g; };
      }
    }

    KJ_ASSERT(sawUid, "id(1) didn't return uid?", idOutput);
    KJ_ASSERT(sawGid, "id(1) didn't return gid?", idOutput);
    if (result.groups.size() == 0) {
      result.groups = kj::heapArray<gid_t>(1);
      result.groups[0] = result.gid;
    }

    return kj::mv(result);
  } else {
    KJ_FAIL_ASSERT("failed to parse output of id(1)", idOutput, input.getBest() - idOutput.begin());
  }
}

Config readConfig(const char *path, bool parseUids) {
  // Read and return the config file.
  //
  // If parseUids is true, we initialize `uids` from SERVER_USER.  This requires shelling
  // out to id(1).  If false, we ignore SERVER_USER.

  Config config;

  config.uids.uid = getuid();
  config.uids.gid = getgid();

  // Store the PORT and HTTPS_PORT values in variables here so we can
  // process them at the end.
  kj::Maybe<kj::String> maybePortValue = nullptr;

  auto lines = splitLines(readAll(path));
  for (auto& line: lines) {
    auto equalsPos = KJ_ASSERT_NONNULL(line.findFirst('='), "Invalid config line", line);
    auto key = trim(line.slice(0, equalsPos));
    auto value = trim(line.slice(equalsPos + 1));

    if (key == "SERVER_USER") {
      if(parseUids) {
        KJ_IF_MAYBE(u, getUserIds(value)) {
          config.uids = kj::mv(*u);
          KJ_REQUIRE(config.uids.uid != 0, "Sandstorm cannot run as root.");
        } else {
          KJ_FAIL_REQUIRE("invalid config value SERVER_USER", value);
        }
      }
    } else if (key == "HTTPS_PORT") {
      KJ_IF_MAYBE(p, parseUInt(value, 10)) {
        config.httpsPort = *p;
      } else {
        KJ_FAIL_REQUIRE("invalid config value HTTPS_PORT", value);
      }
    } else if (key == "PORT") {
        maybePortValue = kj::mv(value);
    } else if (key == "MONGO_PORT") {
      KJ_IF_MAYBE(p, parseUInt(value, 10)) {
        config.mongoPort = *p;
      } else {
        KJ_FAIL_REQUIRE("invalid config value MONGO_PORT", value);
      }
    } else if (key == "BIND_IP") {
      config.bindIp = kj::mv(value);
    } else if (key == "BASE_URL") {
      // If the value ends in any number of "/" characters, remove them now. This allows the
      // Sandstorm codebase to assume that BASE_URL does not end in a slash.
      int desiredLength = value.size();
      while (desiredLength > 0 && value[desiredLength-1] == '/') {
        desiredLength -= 1;
      }
      config.rootUrl = kj::str(value.slice(0, desiredLength));
    } else if (key == "WILDCARD_HOST") {
      config.wildcardHost = kj::mv(value);
    } else if (key == "WILDCARD_PARENT_URL") {
      bool found = false;
      for (uint i: kj::range<uint>(0, value.size() - 3)) {
        if (value.slice(i).startsWith("://")) {
          config.wildcardHost = kj::str("*.", value.slice(i + 3));
          found = true;
          break;
        }
      }
      KJ_REQUIRE(found, "Invalid WILDCARD_PARENT_URL.", value);
    } else if (key == "DDP_DEFAULT_CONNECTION_URL") {
      config.ddpUrl = kj::mv(value);
    } else if (key == "MAIL_URL") {
      config.mailUrl = kj::mv(value);
    } else if (key == "UPDATE_CHANNEL") {
      if (value == "none") {
        config.updateChannel = nullptr;
      } else {
        config.updateChannel = kj::mv(value);
      }
    } else if (key == "SANDCATS_BASE_DOMAIN") {
      config.sandcatsHostname = kj::mv(value);
    } else if (key == "ALLOW_DEMO_ACCOUNTS") {
      config.allowDemoAccounts = value == "true" || value == "yes";
    } else if (key == "ALLOW_DEV_ACCOUNTS") {
      config.allowDevAccounts = value == "true" || value == "yes";
    } else if (key == "IS_TESTING") {
      config.isTesting = value == "true" || value == "yes";
    } else if (key == "HIDE_TROUBLESHOOTING") {
      config.hideTroubleshooting = value == "true" || value == "yes";
    } else if (key == "SMTP_LISTEN_PORT") {
      KJ_IF_MAYBE(p, parseUInt(value, 10)) {
        config.smtpListenPort = *p;
      } else {
        KJ_FAIL_REQUIRE("invalid config value SMTP_LISTEN_PORT", value);
      }
    } else if (key == "EXPERIMENTAL_GATEWAY") {
      if (value != "true" && value != "yes") {
        KJ_LOG(WARNING, "Gateway is no longer experimental. Disabling EXPERIMENTAL_GATEWAY is "
                        "no longer supported.");
      }
    } else if (key == "PRIVATE_KEY_PASSWORD") {
      config.privateKeyPassword = kj::mv(value);
    } else if (key == "TERMS_PAGE_PUBLIC_ID") {
      config.termsPublicId = kj::mv(value);
    } else if (key == "STRIPE_SECRET_KEY") {
      config.stripeKey = kj::mv(value);
    } else if (key == "STRIPE_PUBLIC_KEY") {
      config.stripePublicKey = kj::mv(value);
    } else if (key == "USE_EXPERIMENTAL_SECCOMP_FILTER") {
      config.useExperimentalSeccompFilter = value == "true" || value == "yes";
    } else if (key == "LOG_SECCOMP_VIOLATIONS") {
      config.logSeccompViolations = value == "true" || value == "yes";
    } else if (key == "ALLOW_LEGACY_RELAXED_CSP") {
      KJ_LOG(WARNING,
          "The option ALLOW_LEGACY_RELAXED_CSP will be removed "
          "soon. Apps that rely on loading thrid party resources "
          "should be modified to embed those resources in the app "
          "package instead.");
      config.allowLegacyRelaxedCSP = value == "true" || value == "yes";
    } else {
      KJ_LOG(WARNING, "Ignoring unrecognized config option", key);
    }
  }

  // Now process the PORT setting, since the actual value in config.ports
  // depends on if HTTPS_PORT was provided at any point in reading the
  // config file.
  //
  // Outer KJ_IF_MAYBE so we only run this code if the config file contained
  // a PORT= declaration.
  KJ_IF_MAYBE(portValue, maybePortValue) {
    auto ports = parsePorts(config.httpsPort, *portValue);
    config.ports = kj::mv(ports);
  }

  return config;
}

}; // namespace sandstorm
