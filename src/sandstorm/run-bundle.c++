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

// Hack around stdlib bug with C++14.
#include <initializer_list>  // force libstdc++ to include its config
#undef _GLIBCXX_HAVE_GETS    // correct broken config
// End hack.

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/io.h>
#include <kj/parse/common.h>
#include <kj/parse/char.h>
#include <capnp/schema.h>
#include <capnp/dynamic.h>
#include <capnp/serialize.h>
#include <sandstorm/package.capnp.h>
#include <sodium.h>
#include <stdlib.h>
#include <signal.h>
#include <limits.h>
#include <unistd.h>
#include <sys/mount.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/signalfd.h>
#include <sys/wait.h>
#include <sys/sendfile.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/utsname.h>
#include <sys/capability.h>
#include <linux/securebits.h>
#include <sched.h>
#include <grp.h>
#include <errno.h>
#include <fcntl.h>
#include <ctype.h>
#include <time.h>
#include <stdio.h>  // rename()
#include <sys/socket.h>
#include <sys/un.h>
#include <netdb.h>
#include <dirent.h>

#include "version.h"
#include "send-fd.h"

namespace sandstorm {

typedef unsigned int uint;

constexpr const char* EXEC_END_ARGS = nullptr;

kj::String trim(kj::ArrayPtr<const char> slice) {
  while (slice.size() > 0 && isspace(slice[0])) {
    slice = slice.slice(1, slice.size());
  }
  while (slice.size() > 0 && isspace(slice[slice.size() - 1])) {
    slice = slice.slice(0, slice.size() - 1);
  }

  return kj::heapString(slice);
}

void toLower(kj::ArrayPtr<char> text) {
  for (char& c: text) {
    if ('A' <= c && c <= 'Z') {
      c = c - 'A' + 'a';
    }
  }
}

kj::Maybe<uint> parseUInt(kj::StringPtr s, int base) {
  char* end;
  uint result = strtoul(s.cStr(), &end, base);
  if (s.size() == 0 || *end != '\0') {
    return nullptr;
  }
  return result;
}

kj::AutoCloseFd raiiOpen(kj::StringPtr name, int flags, mode_t mode = 0666) {
  int fd;
  KJ_SYSCALL(fd = open(name.cStr(), flags, mode), name);
  return kj::AutoCloseFd(fd);
}

kj::AutoCloseFd openTemporary(kj::StringPtr near) {
  // Creates a temporary file in the same directory as the file specified by "near", immediately
  // unlinks it, and then returns the file descriptor,  which will be open for both read and write.

  // TODO(someday):  Use O_TMPFILE?  New in Linux 3.11.

  int fd;
  auto name = kj::str(near, ".XXXXXX");
  KJ_SYSCALL(fd = mkostemp(name.begin(), O_CLOEXEC));
  kj::AutoCloseFd result(fd);
  KJ_SYSCALL(unlink(name.cStr()));
  return result;
}

kj::Array<kj::String> listDirectory(kj::StringPtr dirname) {
  DIR* dir = opendir(dirname.cStr());
  if (dir == nullptr) {
    KJ_FAIL_SYSCALL("opendir", errno, dirname);
  }
  KJ_DEFER(closedir(dir));

  kj::Vector<kj::String> entries;

  for (;;) {
    errno = 0;
    struct dirent* entry = readdir(dir);
    if (entry == nullptr) {
      int error = errno;
      if (error == 0) {
        break;
      } else {
        KJ_FAIL_SYSCALL("readdir", error, dirname);
      }
    }

    kj::StringPtr name = entry->d_name;
    if (name != "." && name != "..") {
      entries.add(kj::heapString(entry->d_name));
    }
  }

  return entries.releaseAsArray();
}

void recursivelyDelete(kj::StringPtr path) {
  // Delete the given path, recursively if it is a directory.
  //
  // Since this may be used in KJ_DEFER to delete temporary directories, all exceptions are
  // recoverable (won't throw if already unwinding).

  struct stat stats;
  KJ_SYSCALL(lstat(path.cStr(), &stats), path) { return; }
  if (S_ISDIR(stats.st_mode)) {
    for (auto& file: listDirectory(path)) {
      recursivelyDelete(kj::str(path, "/", file));
    }
    KJ_SYSCALL(rmdir(path.cStr()), path) { break; }
  } else {
    KJ_SYSCALL(unlink(path.cStr()), path) { break; }
  }
}

kj::String readAll(int fd) {
  kj::FdInputStream input(fd);
  kj::Vector<char> content;
  for (;;) {
    char buffer[4096];
    size_t n = input.tryRead(buffer, sizeof(buffer), sizeof(buffer));
    content.addAll(buffer, buffer + n);
    if (n < sizeof(buffer)) {
      // Done!
      break;
    }
  }
  content.add('\0');
  return kj::String(content.releaseAsArray());
}

kj::String readAll(kj::StringPtr name) {
  return readAll(raiiOpen(name, O_RDONLY));
}

kj::Maybe<kj::String> readLine(kj::BufferedInputStream& input) {
  kj::Vector<char> result(80);

  for (;;) {
    auto buffer = input.tryGetReadBuffer();
    if (buffer.size() == 0) {
      KJ_REQUIRE(result.size() == 0, "Got partial line.");
      return nullptr;
    }
    for (size_t i: kj::indices(buffer)) {
      if (buffer[i] == '\n') {
        input.skip(i+1);
        result.add('\0');
        return kj::String(result.releaseAsArray());
      } else {
        result.add(buffer[i]);
      }
    }
    input.skip(buffer.size());
  }
}

kj::Array<kj::String> splitLines(kj::String input) {
  // Split the input into lines, trimming whitespace, and ignoring blank lines or lines that start
  // with #.

  size_t lineStart = 0;
  kj::Vector<kj::String> results;
  for (auto i: kj::indices(input)) {
    if (input[i] == '\n') {
      input[i] = '\0';
      auto line = trim(input.slice(lineStart, i));
      if (line.size() > 0 && !line.startsWith("#")) {
        results.add(kj::mv(line));
      }
      lineStart = i + 1;
    }
  }

  return results.releaseAsArray();
}

// We use SIGALRM to timeout waitpid()s.
static bool alarmed = false;
void alarmHandler(int) {
  alarmed = true;
}
void registerAlarmHandler() {
  struct sigaction action;
  memset(&action, 0, sizeof(action));
  action.sa_handler = &alarmHandler;
  KJ_SYSCALL(sigaction(SIGALRM, &action, nullptr));
}

kj::AutoCloseFd prepareMonitoringLoop() {
  // Prepare to run a loop where we monitor some children and also receive signals.  Returns a
  // signalfd.

  // Set up signal mask to catch events that should lead to shutdown.
  sigset_t sigmask;
  KJ_SYSCALL(sigemptyset(&sigmask));
  KJ_SYSCALL(sigaddset(&sigmask, SIGTERM));
  KJ_SYSCALL(sigaddset(&sigmask, SIGINT));   // request front-end shutdown
  KJ_SYSCALL(sigaddset(&sigmask, SIGCHLD));
  KJ_SYSCALL(sigaddset(&sigmask, SIGHUP));
  KJ_SYSCALL(sigprocmask(SIG_BLOCK, &sigmask, nullptr));

  // Receive signals on a signalfd.
  int sigfd;
  KJ_SYSCALL(sigfd = signalfd(-1, &sigmask, SFD_CLOEXEC));
  return kj::AutoCloseFd(sigfd);
}

// =======================================================================================

struct KernelVersion {
  uint major;
  uint minor;
};

KernelVersion getKernelVersion() {
  struct utsname uts;
  KJ_SYSCALL(uname(&uts));
  kj::StringPtr release = uts.release;

  auto parser = kj::parse::transform(kj::parse::sequence(
      kj::parse::oneOrMore(kj::parse::digit),
      kj::parse::exactChar<'.'>(),
      kj::parse::oneOrMore(kj::parse::digit)),
      [](kj::Array<char> major, kj::Array<char> minor) {
    return KernelVersion {
      KJ_ASSERT_NONNULL(parseUInt(kj::heapString(major), 10)),
      KJ_ASSERT_NONNULL(parseUInt(kj::heapString(minor), 10))
    };
  });
  kj::parse::IteratorInput<char, const char*> input(release.begin(), release.end());
  KJ_IF_MAYBE(version, parser(input)) {
    return *version;
  } else {
    KJ_FAIL_ASSERT("Couldn't parse kernel version.", release);
  }
}

bool isKernelNewEnough() {
  auto version = getKernelVersion();
  if (version.major < 3 || (version.major == 3 && version.minor < 13)) {
    // Insufficient kernel version.
    return false;
  }

  // unprivileged_userns_clone, for systems that have it, must be enabled (set to 1).
  if (access("/proc/sys/kernel/unprivileged_userns_clone", F_OK) == 0 &&
      !KJ_ASSERT_NONNULL(parseUInt(trim(
          readAll("/proc/sys/kernel/unprivileged_userns_clone")), 10))) {
    return false;
  }

  return true;
}

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

constexpr auto nameNum = p::sequence(p::integer, p::discard(p::optional(
    p::sequence(p::exactChar<'('>(), p::identifier, p::exactChar<')'>()))));

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

struct UserIds {
  uid_t uid = 0;
  gid_t gid = 0;
  kj::Array<gid_t> groups;
};

kj::Maybe<UserIds> getUserIds(kj::StringPtr name) {
  // Convert a user or group name to the equivalent ID number.  Set `flag` to "-u" for username,
  // "-g" for group name.
  //
  // We can't use getpwnam() in a statically-linked binary, so we shell out to id(1).  lol.

  int fds[2];
  KJ_SYSCALL(pipe2(fds, O_CLOEXEC));

  pid_t child;
  KJ_SYSCALL(child = fork());
  if (child == 0) {
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

// =======================================================================================

class CurlRequest {
public:
  explicit CurlRequest(kj::StringPtr url): url(kj::heapString(url)) {
    int pipeFds[2];
    KJ_SYSCALL(pipe(pipeFds));
    kj::AutoCloseFd pipeInput(pipeFds[0]), pipeOutput(pipeFds[1]);

    KJ_SYSCALL(pid = fork());
    if (pid == 0) {
      KJ_SYSCALL(dup2(pipeOutput, STDOUT_FILENO));
      pipeInput = nullptr;
      pipeOutput = nullptr;

      KJ_SYSCALL(execlp("curl", "curl", isatty(STDERR_FILENO) ? "-f" : "-fs",
                        url.cStr(), EXEC_END_ARGS), url);
      KJ_UNREACHABLE;
    } else {
      pipeFd = kj::mv(pipeInput);
    }
  }

  ~CurlRequest() {
    if (pid == 0) return;

    // Close the pipe first, in case the child is waiting for that.
    pipeFd = nullptr;

    int status;
    KJ_SYSCALL(waitpid(pid, &status, 0)) { return; }
    if (WIFEXITED(status)) {
      int exitCode = WEXITSTATUS(status);
      if (exitCode != 0) {
        KJ_FAIL_ASSERT("curl failed", url, exitCode) { return; }
      }
    } else if (WIFSIGNALED(status)) {
      int signalNumber = WTERMSIG(status);
      KJ_FAIL_ASSERT("curl crashed", url, signalNumber) { return; }
    } else {
      KJ_FAIL_ASSERT("curl failed", url) { return; }
    }
  }

  int getPipe() { return pipeFd; }

  KJ_DISALLOW_COPY(CurlRequest);

private:
  kj::AutoCloseFd pipeFd;
  pid_t pid;
  kj::String url;
};

// =======================================================================================
// JSON-ify Cap'n Proto message
//
// Used specifically to insert a dev app's manifest into the database.
//
// TODO(cleanup): This REALLY belongs somewhere else!

static const char HEXDIGITS[] = "0123456789abcdef";

static capnp::schema::Type::Which whichFieldType(const capnp::StructSchema::Field& field) {
  auto proto = field.getProto();
  switch (proto.which()) {
    case capnp::schema::Field::SLOT:
      return proto.getSlot().getType().which();
    case capnp::schema::Field::GROUP:
      return capnp::schema::Type::STRUCT;
  }
  KJ_UNREACHABLE;
}

static kj::StringTree toJson(const capnp::DynamicValue::Reader& value,
                             capnp::schema::Type::Which which) {
  switch (value.getType()) {
    case capnp::DynamicValue::UNKNOWN:
      return kj::strTree("null");
    case capnp::DynamicValue::VOID:
      return kj::strTree("null");
    case capnp::DynamicValue::BOOL:
      return kj::strTree(value.as<bool>() ? "true" : "false");
    case capnp::DynamicValue::INT:
      if (which == capnp::schema::Type::INT64 ||
          which == capnp::schema::Type::UINT64) {
        // 64-bit values must be stringified to avoid losing precision.
        return kj::strTree('\"', value.as<int64_t>(), '\"');
      } else {
        return kj::strTree(value.as<int32_t>());
      }
    case capnp::DynamicValue::UINT:
      if (which == capnp::schema::Type::INT64 ||
          which == capnp::schema::Type::UINT64) {
        // 64-bit values must be stringified to avoid losing precision.
        return kj::strTree('\"', value.as<uint64_t>(), '\"');
      } else {
        return kj::strTree(value.as<uint64_t>());
      }
    case capnp::DynamicValue::FLOAT:
      if (which == capnp::schema::Type::FLOAT32) {
        return kj::strTree(value.as<float>());
      } else {
        return kj::strTree(value.as<double>());
      }
    case capnp::DynamicValue::TEXT: {
      auto chars = value.as<capnp::Text>();
      kj::Vector<char> escaped(chars.size());

      for (char c: chars) {
        switch (c) {
          case '\a': escaped.addAll(kj::StringPtr("\\a")); break;
          case '\b': escaped.addAll(kj::StringPtr("\\b")); break;
          case '\f': escaped.addAll(kj::StringPtr("\\f")); break;
          case '\n': escaped.addAll(kj::StringPtr("\\n")); break;
          case '\r': escaped.addAll(kj::StringPtr("\\r")); break;
          case '\t': escaped.addAll(kj::StringPtr("\\t")); break;
          case '\v': escaped.addAll(kj::StringPtr("\\v")); break;
          case '\'': escaped.addAll(kj::StringPtr("\\\'")); break;
          case '\"': escaped.addAll(kj::StringPtr("\\\"")); break;
          case '\\': escaped.addAll(kj::StringPtr("\\\\")); break;
          default:
            if (c < 0x20) {
              escaped.add('\\');
              escaped.add('x');
              uint8_t c2 = c;
              escaped.add(HEXDIGITS[c2 / 16]);
              escaped.add(HEXDIGITS[c2 % 16]);
            } else {
              escaped.add(c);
            }
            break;
        }
      }
      return kj::strTree('"', escaped, '"');
    }
    case capnp::DynamicValue::DATA:
      // TODO(someday): This is a crappy encoding for bytes. It produces the semantic value we want,
      //   but we really want to supply it as base64 and have it deserialize into a Buffer.
      return kj::strTree('[',
        kj::StringTree(KJ_MAP(b, value.as<capnp::Data>()) { return kj::strTree((uint)b); }, ","),
        ']');

    case capnp::DynamicValue::LIST: {
      auto listValue = value.as<capnp::DynamicList>();
      auto which = listValue.getSchema().whichElementType();
      kj::Array<kj::StringTree> elements = KJ_MAP(element, listValue) {
        return toJson(element, which);
      };
      return kj::strTree('[', kj::StringTree(kj::mv(elements), ","), ']');
    }
    case capnp::DynamicValue::ENUM: {
      auto enumValue = value.as<capnp::DynamicEnum>();
      KJ_IF_MAYBE(enumerant, enumValue.getEnumerant()) {
        return kj::strTree('\"', enumerant->getProto().getName(), '\"');
      } else {
        // Unknown enum value; output raw number.
        return kj::strTree(enumValue.getRaw());
      }
      break;
    }
    case capnp::DynamicValue::STRUCT: {
      auto structValue = value.as<capnp::DynamicStruct>();
      auto unionFields = structValue.getSchema().getUnionFields();
      auto nonUnionFields = structValue.getSchema().getNonUnionFields();

      kj::Vector<kj::StringTree> printedFields(nonUnionFields.size() + (unionFields.size() != 0));

      // We try to write the union field, if any, in proper order with the rest.
      auto which = structValue.which();

      kj::StringTree unionValue;
      KJ_IF_MAYBE(field, which) {
        // Even if the union field has its default value, if it is not the default field of the
        // union then we have to print it anyway.
        auto fieldProto = field->getProto();
        if (fieldProto.getDiscriminantValue() != 0 || structValue.has(*field)) {
          unionValue = kj::strTree(
              '\"', fieldProto.getName(), "\":",
              toJson(structValue.get(*field), whichFieldType(*field)));
        } else {
          which = nullptr;
        }
      }

      for (auto field: nonUnionFields) {
        KJ_IF_MAYBE(unionField, which) {
          if (unionField->getIndex() < field.getIndex()) {
            printedFields.add(kj::mv(unionValue));
            which = nullptr;
          }
        }
        if (structValue.has(field)) {
          printedFields.add(kj::strTree(
              '\"', field.getProto().getName(), "\":",
              toJson(structValue.get(field), whichFieldType(field))));
        }
      }
      if (which != nullptr) {
        // Union value is last.
        printedFields.add(kj::mv(unionValue));
      }

      return kj::strTree('{', kj::StringTree(printedFields.releaseAsArray(), ","), '}');
    }
    case capnp::DynamicValue::CAPABILITY:
      // TODO(someday): Implement capabilities?
      return kj::strTree("null");
    case capnp::DynamicValue::ANY_POINTER:
      // TODO(someday): Convert to bytes?
      return kj::strTree("null");
  }

  KJ_UNREACHABLE;
}

kj::StringTree toJson(capnp::DynamicStruct::Reader value) {
  return toJson(value, capnp::schema::Type::STRUCT);
}

// =======================================================================================

class RunBundleMain {
  // Main class for the Sandstorm bundle runner.  This is a convenience tool for running the
  // Sandstorm binary bundle, which is a packaged chroot environment containing everything needed
  // to run a Sandstorm server.  Just unpack and run!

  struct Config;

public:
  RunBundleMain(kj::ProcessContext& context): context(context) {
    // Make sure we didn't inherit a weird signal mask from the parent process.
    clearSignalMask();
    umask(0022);

    if (!kernelNewEnough) {
      context.warning(
          "WARNING: Your Linux kernel is too old or unprivileged user namespaces are disabled. "
          "You need at least kernel version 3.13 and must set the "
          "kernel.unprivileged_userns_clone sysctl (if your system has it) to 1. The next "
          "version of Sandstorm will require these things, so updates will be disabled for now. "
          "If in doubt, re-run the Sandstorm installer for help.");
    }
  }

  kj::MainFunc getMain() {
    static const char* VERSION = "Sandstorm version " SANDSTORM_VERSION;
    return kj::MainBuilder(context, VERSION,
            "Controls the Sandstorm server.\n\n"
            "Something not working? Check the logs in SANDSTORM_HOME/var/log.")
        .addSubCommand("start",
            [this]() {
              return kj::MainBuilder(context, VERSION, "Start the Sandstorm server (default).")
                  .callAfterParsing(KJ_BIND_METHOD(*this, start))
                  .build();
            },
            "Start the sandstorm server.")
        .addSubCommand("stop",
            [this]() {
              return kj::MainBuilder(context, VERSION, "Stop the Sandstorm server.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, stop))
                  .build();
            },
            "Stop the sandstorm server.")
        .addSubCommand("start-fe",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                    "Start the Sandstorm front-end after it has previously been stopped using "
                    "the `stop-fe` command.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, startFe))
                  .build();
            },
            "Undo previous stop-fe.")
        .addSubCommand("stop-fe",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                    "Stop the Sandstorm front-end, but leave Mongo running. Useful when you "
                    "want to run the front-end in dev mode in front of the existing database "
                    "and grains.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, stopFe))
                  .build();
            },
            "Stop the sandstorm front-end.")
        .addSubCommand("status",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                      "Check if Sandstorm is running. Prints the pid and exits successfully if so; "
                      "exits with an error otherwise.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, status))
                  .build();
            },
            "Check if Sandstorm is running.")
        .addSubCommand("restart",
            [this]() {
              return kj::MainBuilder(context, VERSION, "Restart Sandstorm server.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, restart))
                  .build();
            },
            "Restart Sandstorm server.")
        .addSubCommand("mongo",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                  "Run MongoDB shell, connecting to the an already-running Sandstorm server.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, mongo))
                  .build();
            },
            "Run MongoDB shell.")
        .addSubCommand("update",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                      "Update the Sandstorm platform to a new version. If <release> is provided "
                      "and specifies a bundle file (something like sandstorm-1234.tar.xz) it is "
                      "used as the update. If <release> is a channel name, e.g. \"dev\", we "
                      "securely check the web for an update. If <release> is not provided, we "
                      "use the channel specified in the config file.")
                  .expectOptionalArg("<release>", KJ_BIND_METHOD(*this, setUpdateFile))
                  .callAfterParsing(KJ_BIND_METHOD(*this, update))
                  .build();
            },
            "Update the Sandstorm platform.")
        .addSubCommand("devtools",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                      "Place symlinks in <bindir> (default: /usr/local/bin) to the dev tools "
                      "in this package.")
                  .expectOptionalArg("<bindir>", KJ_BIND_METHOD(*this, setDevtoolsBindir))
                  .callAfterParsing(KJ_BIND_METHOD(*this, devtools))
                  .build();
            },
            "Install Sandstorm devtools.")
        .addSubCommand("continue",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                      "For internal use only: Continue running Sandstorm after an update. "
                      "This command is invoked by the Sandstorm server itself. Do not run it "
                      "directly.")
                  .addOption({"userns"}, [this]() { unsharedUidNamespace = true; return true; },
                      "Pass this flag if the parent has already set up and entered a UID "
                      "namespace.")
                  .expectArg("<pidfile-fd>", KJ_BIND_METHOD(*this, continue_))
                  .build();
            },
            "For internal use only.")
        .addSubCommand("dev",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                      "For internal use only: Run an app in dev mode. This command is "
                      "invoked by the `spk` tool. Do not run it directly.")
                  .callAfterParsing(KJ_BIND_METHOD(*this, dev))
                  .build();
            },
            "For internal use only.")
        .addSubCommand("supervise",
            [this]() {
              return kj::MainBuilder(context, VERSION,
                      "Run a sandstorm-supervisor process inside the server's namespace. This is "
                      "mainly used to make it easier to run the front-end in dev mode.")
                  .expectZeroOrMoreArgs("<supervisor-args>",
                      KJ_BIND_METHOD(*this, addSuperviseArg))
                  .callAfterParsing(KJ_BIND_METHOD(*this, supervise))
                  .build();
            },
            "For internal use only.")
        .build();
  }

  kj::MainBuilder::Validity start() {
    changeToInstallDir();
    const Config config = readConfig();

    // Check / lock the pidfile.
    auto pidfile = raiiOpen("../var/pid/sandstorm.pid", O_RDWR | O_CREAT | O_CLOEXEC, 0660);
    {
      struct flock lock;
      memset(&lock, 0, sizeof(lock));
      lock.l_type = F_WRLCK;
      lock.l_whence = SEEK_SET;
      lock.l_start = 0;
      lock.l_len = 0;  // entire file
      if (fcntl(pidfile, F_SETLK, &lock) < 0) {
        int error = errno;
        if (error == EACCES || error == EAGAIN) {
          context.exitInfo(kj::str("Sandstorm is already running.  PID = ", readAll(pidfile)));
        } else {
          KJ_FAIL_SYSCALL("fcntl(pidfile, F_SETLK)", error);
        }
      }

      // It's ours.  Truncate for now so we can write in the new PID later.
      KJ_SYSCALL(ftruncate(pidfile, 0));
    }

    if (!runningAsRoot) unshareUidNamespaceOnce();

    // Unshare PID namespace so that daemon process becomes the root process of its own PID
    // namespace and therefore if it dies the whole namespace is killed.
    KJ_SYSCALL(unshare(CLONE_NEWPID));

    // Daemonize ourselves.
    pid_t mainPid;  // PID of the main process as seen *outside* the PID namespace.
    {
      int pipeFds[2];
      KJ_SYSCALL(pipe2(pipeFds, O_CLOEXEC));
      kj::AutoCloseFd pipeIn(pipeFds[0]), pipeOut(pipeFds[1]);

      KJ_SYSCALL(mainPid = fork());
      if (mainPid != 0) {
        // Tell the child process its own PID, since being in a PID namespace its own getpid() will
        // unhelpfully return 1.
        pipeIn = nullptr;
        kj::FdOutputStream(kj::mv(pipeOut)).write(&mainPid, sizeof(mainPid));

        // Write the pidfile before exiting.
        {
          auto pidstr = kj::str(mainPid, '\n');
          kj::FdOutputStream((int)pidfile).write(pidstr.begin(), pidstr.size());
        }

        // Exit success.
        context.exitInfo(kj::str("Sandstorm started. PID = ", mainPid));
        return true;
      }

      // Read our (global) PID in from the parent process.
      pipeOut = nullptr;
      kj::FdInputStream(kj::mv(pipeIn)).read(&mainPid, sizeof(mainPid));
    }

    // Since we unshared the PID namespace, the first fork() should have produced pid 1 in the
    // new namespace.  That means that if this pid ever exits, everything under it dies.  That's
    // perfect!  Otherwise we'd have to carefully kill node and mongo separately.
    KJ_ASSERT(getpid() == 1, "unshare(CLONE_NEWPID) didn't do what I expected.", getpid());

    // Lock the pidfile and make sure it still belongs to us.
    //
    // We need to wait for the parent process to release its lock, so we use F_SETLKW.
    // However, if another Sandstorm server is started simultaneously and manages to steal
    // ownership, we want to detect this and exit, so we take a shared (read-only) lock.
    {
      struct flock lock;
      memset(&lock, 0, sizeof(lock));
      lock.l_type = F_RDLCK;
      lock.l_whence = SEEK_SET;
      lock.l_start = 0;
      lock.l_len = 0;  // entire file
      KJ_SYSCALL(fcntl(pidfile, F_SETLKW, &lock));

      // Verify that we still own the file.
      KJ_SYSCALL(lseek(pidfile, 0, SEEK_SET));
      pid_t pidfilePid = KJ_ASSERT_NONNULL(parseUInt(trim(readAll(pidfile)), 10));
      if (pidfilePid != mainPid) {
        context.exitInfo(kj::str(
            "Oops, Sandstorm PID ", pidfilePid, " just started. "
            "PID ", mainPid, " exiting in deference."));
      }
    }

    // Redirect stdio.
    {
      auto logFd = raiiOpen("../var/log/sandstorm.log", O_WRONLY | O_APPEND | O_CREAT, 0660);
      if (runningAsRoot) { KJ_SYSCALL(fchown(logFd, config.uids.uid, config.uids.gid)); }
      KJ_SYSCALL(dup2(logFd, STDOUT_FILENO));
      KJ_SYSCALL(dup2(logFd, STDERR_FILENO));
    }
    {
      auto nullFd = raiiOpen("/dev/null", O_RDONLY);
      KJ_SYSCALL(dup2(nullFd, STDIN_FILENO));
    }

    // Write time to log.
    time_t now;
    time(&now);
    context.warning(kj::str("** Starting Sandstorm at: ", ctime(&now)));

    // Detach from controlling terminal and make ourselves session leader.
    KJ_SYSCALL(setsid());

    runUpdateMonitor(config, pidfile);
  }

  kj::MainBuilder::Validity continue_(kj::StringPtr pidfileFdStr) {
    if (getpid() != 1) {
      return "This command is only internal use only.";
    }

    if (unsharedUidNamespace) {
      // Even if getuid() return zero, we aren't really root, it's just that we mapped our UID to
      // zero in the UID namespace.
      runningAsRoot = false;
    }

    int pidfile = KJ_ASSERT_NONNULL(parseUInt(pidfileFdStr, 10));

    // Make sure the pidfile is close-on-exec.
    KJ_SYSCALL(fcntl(pidfile, F_SETFD, FD_CLOEXEC));

    changeToInstallDir();
    Config config = readConfig();
    runUpdateMonitor(config, pidfile);
  }

  kj::MainBuilder::Validity stop() {
    changeToInstallDir();

    registerAlarmHandler();

    kj::AutoCloseFd pidfile = nullptr;
    KJ_IF_MAYBE(pf, openPidfile()) {
      pidfile = kj::mv(*pf);
    } else {
      context.exitInfo("Sandstorm is not running.");
    }

    pid_t pid;
    KJ_IF_MAYBE(p, getRunningPid(pidfile)) {
      pid = *p;
    } else {
      context.exitInfo("Sandstorm is not running.");
    }

    context.warning(kj::str("Waiting for PID ", pid, " to terminate..."));
    KJ_SYSCALL(kill(pid, SIGTERM));

    // Timeout if not dead within 10 seconds.
    uint timeout = 10;
    KJ_SYSCALL(alarm(timeout));

    // Take write lock on pidfile as a way to wait for exit.
    struct flock lock;
    memset(&lock, 0, sizeof(lock));
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    lock.l_start = 0;
    lock.l_len = 0;  // entire file

    for (;;) {
      if (fcntl(pidfile, F_SETLKW, &lock) >= 0) {
        // Success.
        break;
      }

      int error = errno;
      if (error == EINTR) {
        if (alarmed) {
          context.warning(kj::str("Did not terminate after ", timeout, " seconds; killing..."));
          KJ_SYSCALL(kill(pid, SIGKILL));
          alarmed = false;
        } else {
          // Ignore signal.
        }
      } else {
        KJ_FAIL_SYSCALL("fcntl(pidfile, F_SETLKW)", error);
      }
    }

    context.exitInfo("Sandstorm server stopped.");
  }

  kj::MainBuilder::Validity startFe() {
    return startStopFe(1);
  }

  kj::MainBuilder::Validity stopFe() {
    return startStopFe(0);
  }

  kj::MainBuilder::Validity startStopFe(int value) {
    changeToInstallDir();

    kj::AutoCloseFd pidfile = nullptr;
    KJ_IF_MAYBE(pf, openPidfile()) {
      pidfile = kj::mv(*pf);
    } else {
      context.exitInfo("Sandstorm is not running.");
    }

    pid_t pid;
    KJ_IF_MAYBE(p, getRunningPid(pidfile)) {
      pid = *p;
    } else {
      context.exitInfo("Sandstorm is not running.");
    }

    union sigval sigval;
    memset(&sigval, 0, sizeof(sigval));
    sigval.sival_int = value;
    KJ_SYSCALL(sigqueue(pid, SIGINT, sigval));
    context.exitInfo(value == 0 ? "Requested front-end shutdown." : "Requested front-end start.");
  }

  kj::MainBuilder::Validity status() {
    changeToInstallDir();

    KJ_IF_MAYBE(pid, getRunningPid()) {
      context.exitInfo(kj::str("Sandstorm is running; PID = ", *pid));
    } else {
      context.exitError("Sandstorm is not running.");
    }
  }

  kj::MainBuilder::Validity restart() {
    changeToInstallDir();

    KJ_IF_MAYBE(pid, getRunningPid()) {
      KJ_SYSCALL(kill(*pid, SIGHUP));
      context.exitInfo("Restart request sent.");
    } else {
      context.exitError("Sandstorm is not running.");
    }
  }

  kj::MainBuilder::Validity mongo() {
    changeToInstallDir();

    // Verify that Sandstorm is running.
    if (getRunningPid() == nullptr) {
      context.exitError("Sandstorm is not running.");
    }

    const Config config = readConfig();

    // We'll run under the chroot.
    enterChroot();

    // Don't run as root.
    dropPrivs(config.uids);

    // OK, run the Mongo client!
    execMongoClient(config, {});
    KJ_UNREACHABLE;
  }

  kj::MainBuilder::Validity update() {
    changeToInstallDir();
    const Config config = readConfig();

    if (updateFile == nullptr) {
      if (config.updateChannel == nullptr) {
        return "You must specify a channel.";
      }

      if (!checkForUpdates(config.updateChannel, "manual", config)) {
        context.exit();
      }
    } else {
      if (config.updateChannel != nullptr) {
        return "You currently have auto-updates enabled. Please disable it before updating "
               "manually, otherwise you'll just be switched back at the next update. Set "
               "UPDATE_CHANNEL to \"none\" to disable. Or, if you want to manually apply "
               "the latest update from the configured channel, run `sandstorm update` with "
               "no argument.";
      }

      if (!updateFileIsChannel) {
        unpackUpdate(raiiOpen(updateFile, O_RDONLY));
      } else if (!checkForUpdates(updateFile, "manual", config)) {
        context.exit();
      }
    }

    KJ_IF_MAYBE(pid, getRunningPid()) {
      KJ_SYSCALL(kill(*pid, SIGHUP));
      context.exitInfo("Update complete; restarting Sandstorm.");
    } else {
      context.exitInfo("Update complete.");
    }
  }

  kj::MainBuilder::Validity devtools() {
    auto dir = getInstallDir();
    auto parent = kj::heapString(dir.slice(0, KJ_ASSERT_NONNULL(dir.findLast('/'))));

    KJ_SYSCALL(access(kj::str(parent, "/latest").cStr(), F_OK),
               "No \"latest\" symlink? Sandstorm doesn't seem to be installed the way I "
               "expected it.");

    auto to = kj::str(devtoolsBindir, "/spk");
    unlink(to.cStr());
    KJ_SYSCALL(symlink(kj::str(parent, "/latest/bin/spk").cStr(), to.cStr()));
    context.exitInfo(kj::str("created: ", devtoolsBindir, "/spk"));
  }

  kj::MainBuilder::Validity dev() {
    // When called by the spk tool, stdout is a socket where we will send the fuse FD.
    struct stat stats;
    KJ_SYSCALL(fstat(STDOUT_FILENO, &stats));
    if (!S_ISSOCK(stats.st_mode)) {
      return "This command is for internal use only.";
    }

    changeToInstallDir();

    // Verify that Sandstorm is running.
    if (getRunningPid() == nullptr) {
      context.exitError("Sandstorm is not running.");
    }

    // Connect to the devmode socket. The server daemon listens on this socket for commands.
    // See `runDevDaemon()`.
    auto sock = connectToDevDaemon();

    // Send the command code.
    kj::FdOutputStream((int)sock).write(&DEVMODE_COMMAND_CONNECT, 1);

    // Send our "stdout" (which is actually a socket) to the devmode server.
    sendFd(sock, STDOUT_FILENO);

    return true;
  }

  kj::MainBuilder::Validity supervise() {
    changeToInstallDir();

    // Verify that Sandstorm is running.
    if (getRunningPid() == nullptr) {
      context.exitError("Sandstorm is not running.");
    }

    // Connect to the devmode socket. The server daemon listens on this socket for commands.
    // See `runDevDaemon()`.
    auto sock = connectToDevDaemon();

    // Send the command code.
    kj::FdOutputStream((int)sock).write(&DEVMODE_COMMAND_SUPERVISE, 1);

    // Forward our standard I/O FDs.
    sendFd(sock, STDIN_FILENO);
    sendFd(sock, STDOUT_FILENO);
    sendFd(sock, STDERR_FILENO);

    // Send supervisor args.
    kj::FdOutputStream((int)sock).write(superviseArgs.begin(), superviseArgs.size());

    // Send EOF.
    KJ_SYSCALL(shutdown(sock, SHUT_WR));

    // Wait for exit status.
    int status;
    kj::FdInputStream((int)sock).read(&status, sizeof(status));

    if (WIFEXITED(status)) {
      _exit(WEXITSTATUS(status));
    } else if (WIFSIGNALED(status)) {
      // Try to kill ourself with the same signal to emulate the same outcome.
      KJ_SYSCALL(kill(getpid(), WTERMSIG(status)));
      // Otherwise just report it.
      context.exitError(kj::str("Supervisor terminated by signal: ", WTERMSIG(status)));
    } else {
      context.exitError("Supervisor terminated with status I didn't understand.");
    }
  }

  kj::MainBuilder::Validity addSuperviseArg(kj::StringPtr arg) {
    superviseArgs.addAll(arg);
    superviseArgs.add('\0');
    return true;
  }

private:
  kj::ProcessContext& context;

  struct Config {
    uint port = 3000;
    uint mongoPort = 3001;
    UserIds uids;
    kj::String bindIp = kj::str("127.0.0.1");
    kj::String rootUrl = nullptr;
    kj::String wildcardHost = nullptr;
    kj::String ddpUrl = nullptr;
    kj::String mailUrl = nullptr;
    kj::String updateChannel = nullptr;
    bool allowDemoAccounts = false;
  };

  kj::String updateFile;
  kj::StringPtr devtoolsBindir = "/usr/local/bin";

  kj::Vector<char> superviseArgs;

  bool changedDir = false;
  bool unsharedUidNamespace = false;
  bool kernelNewEnough = isKernelNewEnough();
  bool runningAsRoot = getuid() == 0;
  bool updateFileIsChannel = false;

  kj::String getInstallDir() {
    char exeNameBuf[PATH_MAX + 1];
    size_t len;
    KJ_SYSCALL(len = readlink("/proc/self/exe", exeNameBuf, sizeof(exeNameBuf) - 1));
    exeNameBuf[len] = '\0';
    kj::StringPtr exeName(exeNameBuf, len);
    return kj::heapString(exeName.slice(0, KJ_ASSERT_NONNULL(exeName.findLast('/'))));
  }

  void changeToInstallDir() {
    KJ_SYSCALL(chdir(getInstallDir().cStr()));
    changedDir = true;
  }

  void checkOwnedByRoot(kj::StringPtr path, kj::StringPtr title) {
    if (access(path.cStr(), F_OK) != 0) {
      context.exitError(kj::str(title, " not found."));
    }

    if (runningAsRoot) {
      struct stat stats;
      KJ_SYSCALL(stat(path.cStr(), &stats));
      if (stats.st_uid != 0) {
        context.exitError(kj::str(title, " not owned by root, but you're running as root."));
      }
    }
  }

  kj::Maybe<kj::AutoCloseFd> openPidfile() {
    KJ_REQUIRE(changedDir);
    if (access("../var/pid", R_OK) < 0) {
      if (access("../var/pid", F_OK) < 0) {
        KJ_FAIL_REQUIRE("$SANDSTORM_HOME/var/pid doesn't exist?");
      } else {
        KJ_FAIL_REQUIRE(
            "You do not have permission to read the pidfile directory. Perhaps your "
            "user account is not a member of the server's group?");
      }
    }
    kj::StringPtr pidfileName = "../var/pid/sandstorm.pid";
    if (access(pidfileName.cStr(), F_OK) < 0) {
      return nullptr;
    }
    return raiiOpen(pidfileName, O_RDWR);
  }

  kj::Maybe<pid_t> getRunningPid() {
    KJ_IF_MAYBE(pf, openPidfile()) {
      return getRunningPid(*pf);
    } else {
      return nullptr;
    }
  }

  kj::Maybe<pid_t> getRunningPid(kj::AutoCloseFd& pidfile) {
    struct flock lock;
    memset(&lock, 0, sizeof(lock));
    lock.l_type = F_WRLCK;
    lock.l_whence = SEEK_SET;
    lock.l_start = 0;
    lock.l_len = 0;  // entire file
    KJ_SYSCALL(fcntl(pidfile, F_GETLK, &lock));

    if (lock.l_type == F_UNLCK) {
      return nullptr;
    }

    // The pidfile is locked, therefore someone is using it.
    pid_t lockingPid = lock.l_pid;

    // Let's also read the content of the file and make sure it matches.
    pid_t pidfilePid;
    KJ_IF_MAYBE(p, parseUInt(trim(readAll(pidfile)), 10)) {
      pidfilePid = *p;
    } else {
      pidfilePid = -1;
    }

    if (lockingPid != pidfilePid) {
      // We probably caught it just as it was starting up.  People probably shouldn't be telling
      // it to shut down in these circumstances anyway.
      return nullptr;
    }

    return lockingPid;
  }

  int64_t getTime() {
    struct timespec ts;
    KJ_SYSCALL(clock_gettime(CLOCK_MONOTONIC, &ts));
    return ts.tv_sec * 1000000000ll + ts.tv_nsec;
  }

  void writeUserNSMap(const char *type, kj::StringPtr contents) {
    kj::FdOutputStream(raiiOpen(kj::str("/proc/self/", type, "_map").cStr(), O_WRONLY | O_CLOEXEC))
        .write(contents.begin(), contents.size());
  }

  void unshareUidNamespaceOnce() {
    if (!unsharedUidNamespace) {
      uid_t uid = getuid();
      gid_t gid = getgid();

      KJ_SYSCALL(unshare(CLONE_NEWUSER));

      // Set up the UID namespace. We map ourselves as UID zero because this allows capabilities
      // to be inherited through exec(), which we need to support update and restart. With any
      // other UID, capabilities can only be inherited through exec() if the target exec'd file
      // has its inheritable capabilities set filled. By default, the inheritable capability set
      // for all files is empty, and only the filesystem's superuser (i.e. not us) can change them.
      // But if our UID is zero, then the file's attributes are ignored and all capabilities are
      // inherited.
      writeUserNSMap("uid", kj::str("0 ", uid, " 1\n"));
      writeUserNSMap("gid", kj::str("0 ", gid, " 1\n"));

      unsharedUidNamespace = true;
    }
  }

  void enterChroot() {
    KJ_REQUIRE(changedDir);

    // Verify ownership is intact.
    checkOwnedByRoot("..", "Install directory");
    checkOwnedByRoot(".", "Version intsall directory");
    checkOwnedByRoot("sandstorm", "'sandstorm' executable");
    checkOwnedByRoot("../sandstorm.conf", "Config file");

    kj::StringPtr tmpfsUidOpts = "";
    if (runningAsRoot) {
      tmpfsUidOpts = ",uid=0,gid=0";
    } else {
      unshareUidNamespaceOnce();
    }

    // Unshare the mount namespace, so we can create some private bind mounts.
    KJ_SYSCALL(unshare(CLONE_NEWNS));

    // To really unshare the mount namespace, we also have to make sure all mounts are private.
    // The parameters here were derived by strace'ing `mount --make-rprivate /`.  AFAICT the flags
    // are undocumented.  :(
    KJ_SYSCALL(mount("none", "/", nullptr, MS_REC | MS_PRIVATE, nullptr));

    // Make sure that the current directory is a mount point so that we can use pivot_root.
    KJ_SYSCALL(mount(".", ".", nullptr, MS_BIND | MS_REC, nullptr));

    // Now change directory into the new mount point.
    char cwdBuf[PATH_MAX + 1];
    if (getcwd(cwdBuf, sizeof(cwdBuf)) == nullptr) {
      KJ_FAIL_SYSCALL("getcwd", errno);
    }
    KJ_SYSCALL(chdir(cwdBuf));

    // Mount /proc in the chroot.
    KJ_SYSCALL(mount("proc", "proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, ""));

    // Bind var -> ../var, so that all versions share the same var.
    // Same for tmp, though we clear it on every startup.
    KJ_SYSCALL(mount("../var", "var", nullptr, MS_BIND, nullptr));
    KJ_SYSCALL(mount("../tmp", "tmp", nullptr, MS_BIND, nullptr));

    // Bind devices from /dev into our chroot environment.
    // We can't bind /dev itself because this is apparently not allowed when in a UID namespace
    // (returns EINVAL; haven't figured out why yet).
    KJ_SYSCALL(mount("/dev/null", "dev/null", nullptr, MS_BIND, nullptr));
    KJ_SYSCALL(mount("/dev/zero", "dev/zero", nullptr, MS_BIND, nullptr));
    KJ_SYSCALL(mount("/dev/random", "dev/random", nullptr, MS_BIND, nullptr));
    KJ_SYSCALL(mount("/dev/urandom", "dev/urandom", nullptr, MS_BIND, nullptr));
    KJ_SYSCALL(mount("/dev/fuse", "dev/fuse", nullptr, MS_BIND, nullptr));

    // Mount a tmpfs at /etc and copy over necessary config files from the host.
    KJ_SYSCALL(mount("tmpfs", "etc", "tmpfs", MS_NOSUID | MS_NOEXEC,
                     kj::str("size=2m,nr_inodes=128,mode=755", tmpfsUidOpts).cStr()));
    copyEtc();

    // OK, change our root directory.
    KJ_SYSCALL(syscall(SYS_pivot_root, ".", "tmp"));
    KJ_SYSCALL(chdir("/"));
    KJ_SYSCALL(umount2("tmp", MNT_DETACH));

    // Set up path.
    KJ_SYSCALL(setenv("PATH", "/usr/bin:/bin", true));
    KJ_SYSCALL(setenv("LD_LIBRARY_PATH", "/usr/local/lib:/usr/lib:/lib", true));
  }

  void dropPrivs(const UserIds& uids) {
    if (runningAsRoot) {
      KJ_SYSCALL(setresgid(uids.gid, uids.gid, uids.gid));
      KJ_SYSCALL(setgroups(uids.groups.size(), uids.groups.begin()));
      KJ_SYSCALL(setresuid(uids.uid, uids.uid, uids.uid));
    } else {
      // We're using UID namespaces.

      // Defense in depth: Don't give my children any new caps for any reason.
      KJ_SYSCALL(prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0));

      // Defense in depth: Drop all capabilities from the set of caps which my children are allowed
      //   to ever have.
      for (uint cap: kj::range(0, CAP_LAST_CAP + 1)) {
        KJ_SYSCALL(prctl(PR_CAPBSET_DROP, cap, 0, 0, 0));
      }

      // Defense in depth: Don't grant my children capabilities just because they have UID 0.
      KJ_SYSCALL(prctl(PR_SET_SECUREBITS, SECBIT_NOROOT | SECBIT_NOROOT_LOCKED));

      // Drop all Linux "capabilities".  (These are Linux/POSIX "capabilities", which are not true
      // object-capabilities, hence the quotes.)
      struct __user_cap_header_struct hdr;
      struct __user_cap_data_struct data[2];
      hdr.version = _LINUX_CAPABILITY_VERSION_3;
      hdr.pid = 0;
      memset(data, 0, sizeof(data));  // All capabilities disabled!
      KJ_SYSCALL(capset(&hdr, data));
    }

    umask(0007);
  }

  void clearSignalMask() {
    sigset_t sigset;
    KJ_SYSCALL(sigemptyset(&sigset));
    KJ_SYSCALL(sigprocmask(SIG_SETMASK, &sigset, nullptr));
  }

  void copyEtc() {
    auto files = splitLines(readAll("etc.list"));

    // Now copy over each file.
    for (auto& file: files) {
      if (access(file.cStr(), R_OK) == 0) {
        auto in = raiiOpen(file, O_RDONLY);
        auto out = raiiOpen(kj::str(".", file), O_WRONLY | O_CREAT | O_EXCL);
        ssize_t n;
        do {
          KJ_SYSCALL(n = sendfile(out, in, nullptr, 1 << 20));
        } while (n > 0);
      }
    }
  }

  Config readConfig() {
    // Read and return the config file.
    //
    // If parseUids is true, we initialize `uids` from SERVER_USER.  This requires shelling
    // out to id(1).  If false, we ignore SERVER_USER.

    KJ_REQUIRE(changedDir);

    Config config;

    config.uids.uid = getuid();
    config.uids.gid = getgid();

    auto lines = splitLines(readAll("../sandstorm.conf"));
    for (auto& line: lines) {
      auto equalsPos = KJ_ASSERT_NONNULL(line.findFirst('='), "Invalid config line", line);
      auto key = trim(line.slice(0, equalsPos));
      auto value = trim(line.slice(equalsPos + 1));

      if (key == "SERVER_USER") {
        KJ_IF_MAYBE(u, getUserIds(value)) {
          config.uids = kj::mv(*u);
          KJ_REQUIRE(config.uids.uid != 0, "Sandstorm cannot run as root.");
        } else {
          KJ_FAIL_REQUIRE("invalid config value SERVER_USER", value);
        }
      } else if (key == "PORT") {
        KJ_IF_MAYBE(p, parseUInt(value, 10)) {
          config.port = *p;
        } else {
          KJ_FAIL_REQUIRE("invalid config value PORT", value);
        }
      } else if (key == "MONGO_PORT") {
        KJ_IF_MAYBE(p, parseUInt(value, 10)) {
          config.mongoPort = *p;
        } else {
          KJ_FAIL_REQUIRE("invalid config value MONGO_PORT", value);
        }
      } else if (key == "BIND_IP") {
        config.bindIp = kj::mv(value);
      } else if (key == "BASE_URL") {
        config.rootUrl = kj::mv(value);
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
      } else if (key == "ALLOW_DEMO_ACCOUNTS") {
        config.allowDemoAccounts = value == "true" || value == "yes";
      }
    }

    if (runningAsRoot) {
      KJ_REQUIRE(config.uids.uid != 0, "config missing SERVER_USER; can't run as root");
    }

    return config;
  }

  void runUpdateMonitor(const Config& config, int pidfile) KJ_NORETURN {
    // Run the update monitor process.  This process runs two subprocesses:  the sandstorm server
    // and the auto-updater.

    // Fix permissions on pidfile. We do this here rather than back where we opened it because
    // a previous version failed to do this and we want it fixed immediately on upgrade.
    if (runningAsRoot) {
      KJ_SYSCALL(fchown(pidfile, 0, config.uids.gid));
      KJ_SYSCALL(fchmod(pidfile, 0660));
    }

    cleanupOldVersions();

    // Clean up the temp directory.
    KJ_REQUIRE(changedDir);
    if (access("../tmp", F_OK) == 0) {
      recursivelyDelete("../tmp");
    }
    mkdir("../tmp", 0770);
    KJ_SYSCALL(chmod("../tmp", 0770));
    if (runningAsRoot) {
      KJ_SYSCALL(chown("../tmp", 0, config.uids.gid));
    }

    auto sigfd = prepareMonitoringLoop();

    pid_t updaterPid = startUpdater(config, false);

    pid_t sandstormPid = fork();
    if (sandstormPid == 0) {
      runServerMonitor(config);
      KJ_UNREACHABLE;
    }

    for (;;) {
      // Wait for a signal -- any signal.
      struct signalfd_siginfo siginfo;
      KJ_SYSCALL(read(sigfd, &siginfo, sizeof(siginfo)));

      if (siginfo.ssi_signo == SIGCHLD) {
        // Some child exited.

        // Reap zombies until there are no more.
        bool updaterDied = false;
        bool updaterSucceeded = false;
        bool sandstormDied = false;
        for (;;) {
          int status;
          pid_t deadPid = waitpid(-1, &status, WNOHANG);
          if (deadPid <= 0) {
            // No more zombies.
            break;
          } else if (deadPid == updaterPid) {
            updaterDied = true;
            updaterSucceeded = WIFEXITED(status) && WEXITSTATUS(status) == 0;
          } else if (deadPid == sandstormPid) {
            sandstormDied = true;
          }
        }

        if (updaterSucceeded) {
          context.warning("** Restarting to apply update");
          killChild("Server Monitor", sandstormPid);
          restartForUpdate(pidfile);
          KJ_UNREACHABLE;
        } else if (updaterDied) {
          context.warning("** Updater died; restarting it");
          updaterPid = startUpdater(config, true);
        } else if (sandstormDied) {
          context.exitError("** Server monitor died. Aborting.");
          KJ_UNREACHABLE;
        }
      } else if (siginfo.ssi_signo == SIGINT) {
        // Pass along to server monitor.
        union sigval sigval;
        memset(&sigval, 0, sizeof(sigval));
        sigval.sival_int = siginfo.ssi_int;
        KJ_SYSCALL(sigqueue(sandstormPid, SIGINT, sigval));
      } else {
        // Kill updater if it is running.
        if (updaterPid != 0) {
          KJ_SYSCALL(kill(updaterPid, SIGKILL));
        }

        // Shutdown server.
        KJ_SYSCALL(kill(sandstormPid, SIGTERM));
        int status;
        KJ_SYSCALL(waitpid(sandstormPid, &status, 0));

        // Handle signal.
        if (siginfo.ssi_signo == SIGHUP) {
          context.warning("** Restarting");
          restartForUpdate(pidfile);
        } else {
          // SIGTERM or something.
          context.exitInfo("** Exiting");
        }
        KJ_UNREACHABLE;
      }
    }
  }

  void runServerMonitor(const Config& config) KJ_NORETURN {
    // Run the server monitor, which runs node and mongo and deals with them dying.

    enterChroot();

    // For later use when killing children with timeout.
    registerAlarmHandler();

    // MongoDB forks a subprocess but we want to be its reaper.
    KJ_SYSCALL(prctl(PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0));

    auto sigfd = prepareMonitoringLoop();

    context.warning("** Starting MongoDB...");
    pid_t mongoPid = startMongo(config);
    int64_t mongoStartTime = getTime();

    // Create the mongo user if it hasn't been created already.
    maybeCreateMongoUser(config);

    context.warning("** Mongo started; now starting front-end...");

    // If we're root, run the dev daemon. At present the dev daemon requires root (in order to
    // use FUSE), so we don't run it if we aren't root.
    pid_t devDaemonPid;
    if (runningAsRoot) {
      KJ_SYSCALL(devDaemonPid = fork());
      if (devDaemonPid == 0) {
        // Ugh, undo the setup we *just* did. Note that we can't just fork the dev daemon earlier
        // because it wants to connect to mongo first thing.
        sigfd = nullptr;
        clearSignalMask();
        KJ_SYSCALL(signal(SIGALRM, SIG_DFL));
        runDevDaemon(config);
        KJ_UNREACHABLE;
      }
    } else {
      devDaemonPid = 0;
      context.warning("Note: Not accepting \"spk dev\" connections because not running as root.");
    }

    pid_t nodePid = startNode(config);
    int64_t nodeStartTime = getTime();

    for (;;) {
      // Wait for a signal -- any signal.
      struct signalfd_siginfo siginfo;
      KJ_SYSCALL(read(sigfd, &siginfo, sizeof(siginfo)));

      if (siginfo.ssi_signo == SIGCHLD) {
        // Some child exited.  If it's Mongo or Node we have a problem, but it could also be some
        // grandchild that was orphaned and thus reparented to the PID namespace's init process,
        // which is us.

        // Reap zombies until there are no more.
        bool mongoDied = false;
        bool nodeDied = false;
        for (;;) {
          int status;
          pid_t deadPid = waitpid(-1, &status, WNOHANG);
          if (deadPid <= 0) {
            // No more zombies.
            break;
          } else if (deadPid == mongoPid) {
            mongoDied = true;
          } else if (deadPid == nodePid) {
            nodeDied = true;
          } else if (deadPid == devDaemonPid) {
            // We don't restart the dev daemon since it should never crash in the first place.
            // Just record that we already reaped it.
            devDaemonPid = 0;
          }
        }

        // Deal with mongo or node dying.
        if (mongoDied) {
          maybeWaitAfterChildDeath("MongoDB", mongoStartTime);
          mongoPid = startMongo(config);
          mongoStartTime = getTime();
        } else if (nodeDied) {
          maybeWaitAfterChildDeath("Front-end", nodeStartTime);
          nodePid = startNode(config);
          nodeStartTime = getTime();
        }
      } else if (siginfo.ssi_signo == SIGINT) {
        if (siginfo.ssi_int) {
          // Requested startup of front-end after previous shutdown.
          if (nodePid == 0) {
            context.warning("** Starting front-end by admin request");
            nodePid = startNode(config);
            nodeStartTime = getTime();
          } else {
            context.warning("** Request to start front-end, but it is already running");
          }
        } else {
          // Requested shutdown of the front-end but not the back-end.
          context.warning("** Shutting down front-end by admin request");
          killChild("Front-end", nodePid);
          nodePid = 0;
        }
      } else {
        // SIGTERM or something.
        context.warning("** Shutting down due to signal");
        killChild("Front-end", nodePid);
        killChild("MongoDB", mongoPid);
        killChild("Dev daemon", devDaemonPid);
        context.exit();
      }
    }
  }

  pid_t startMongo(const Config& config) {
    pid_t outerPid;
    KJ_SYSCALL(outerPid = fork());
    if (outerPid == 0) {
      dropPrivs(config.uids);
      clearSignalMask();

      KJ_SYSCALL(execl("/bin/mongod", "/bin/mongod", "--fork",
          "--bind_ip", "127.0.0.1", "--port", kj::str(config.mongoPort).cStr(),
          "--dbpath", "/var/mongo", "--logpath", "/var/log/mongo.log",
          "--pidfilepath", "/var/pid/mongo.pid",
          "--auth", "--nohttpinterface", "--noprealloc", "--nopreallocj", "--smallfiles",
          "--replSet", "ssrs", "--oplogSize", "16",
          EXEC_END_ARGS));
      KJ_UNREACHABLE;
    }

    // Wait for mongod to return, meaning the database is up.  Then get its real pid via the
    // pidfile.
    int status;
    KJ_SYSCALL(waitpid(outerPid, &status, 0));

    KJ_ASSERT(WIFEXITED(status) && WEXITSTATUS(status) == 0,
        "MongoDB failed on startup. Check var/log/mongo.log.");

    // Even after the startup command exits, MongoDB takes exactly two seconds to elect itself as
    // master of the repl set (of which it is the only damned member). Unforutnately, if Node
    // connects during this time, it fails, sometimes without actually exiting, leaving the entire
    // server hosed. It appears that this always takes exactly two seconds from startup, since
    // MongoDB does some sort of heartbeat every second where it checks the replset status, and it
    // takes three of these for the election to complete, and the first of the three happens
    // immediately on startup, meaning the last one is two seconds in. So, we'll sleep for 3
    // seconds to be safe.
    // TODO(cleanup): There must be a better way...
    int n = 3;
    while (n > 0) n = sleep(n);

    return KJ_ASSERT_NONNULL(parseUInt(trim(readAll("/var/pid/mongo.pid")), 10));
  }

  void maybeCreateMongoUser(const Config& config) {
    if (access("/var/mongo/passwd", F_OK) != 0) {
      // We need to initialize the repl set to get oplog tailing. Our set isn't actually much of a
      // set since it only contains one instance, but you need that for oplog.
      mongoCommand(config, kj::str(
          "rs.initiate({_id: 'ssrs', members: [{_id: 0, host: 'localhost:",
          config.mongoPort, "'}]})"));

      // We have to wait a few seconds for Mongo to elect itself master of the repl set. Mongo does
      // some sort of heartbeat every second and it takes three of these for Mongo to elect itself,
      // meaning the whole process always takes 2-3 seconds. We'll sleep for 4.
      // TODO(cleanup): This is ugly.
      {
        int n = 4;
        while (n > 0) n = sleep(n);
      }

      // Get 20 random bytes for password.
      kj::byte bytes[20];
      kj::FdInputStream random(raiiOpen("/dev/urandom", O_RDONLY));
      random.read(bytes, sizeof(bytes));

      // Base64 encode them.
      // TODO(cleanup): Move to libkj.
      const char* digits =
          "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_";
      uint buffer = 0;
      uint bufferBits = 0;
      kj::Vector<char> chars;
      for (kj::byte b: bytes) {
        buffer |= kj::implicitCast<uint>(b) << bufferBits;
        bufferBits += 8;

        while (bufferBits >= 6) {
          chars.add(digits[buffer & 0x3f]);
          buffer >>= 6;
          bufferBits -= 6;
        }
      }
      if (bufferBits > 0) {
        chars.add(digits[buffer & 0x3f]);
      }
      chars.add('\0');
      kj::String password(chars.releaseAsArray());

      // Create the mongo user.
      auto command = kj::str(
        "db.addUser({user: \"sandstorm\", pwd: \"", password, "\", "
        "roles: [\"readWriteAnyDatabase\",\"userAdminAnyDatabase\",\"dbAdminAnyDatabase\"]})");
      mongoCommand(config, command, "admin");

      // Store the password.
      auto outFd = raiiOpen("/var/mongo/passwd", O_WRONLY | O_CREAT | O_EXCL, 0640);
      if (runningAsRoot) { KJ_SYSCALL(fchown(outFd, config.uids.uid, config.uids.gid)); }
      kj::FdOutputStream((int)outFd).write(password.begin(), password.size());
    }
  }

  pid_t startNode(const Config& config) {
    pid_t result;
    KJ_SYSCALL(result = fork());
    if (result == 0) {
      dropPrivs(config.uids);
      clearSignalMask();

      kj::String authPrefix;
      kj::StringPtr authSuffix;
      if (access("/var/mongo/passwd", F_OK) == 0) {
        // Read the password.
        auto password = trim(readAll(raiiOpen("/var/mongo/passwd", O_RDONLY)));
        authPrefix = kj::str("sandstorm:", password, "@");
        authSuffix = "?authSource=admin";

        // Oplog is only configured if we have a password.
        KJ_SYSCALL(setenv("MONGO_OPLOG_URL",
            kj::str("mongodb://", authPrefix, "127.0.0.1:", config.mongoPort,
                    "/local", authSuffix).cStr(),
            true));
      }

      KJ_SYSCALL(setenv("PORT", kj::str(config.port).cStr(), true));
      KJ_SYSCALL(setenv("MONGO_URL",
          kj::str("mongodb://", authPrefix, "127.0.0.1:", config.mongoPort,
                  "/meteor", authSuffix).cStr(),
          true));
      KJ_SYSCALL(setenv("BIND_IP", config.bindIp.cStr(), true));
      if (config.mailUrl != nullptr) {
        KJ_SYSCALL(setenv("MAIL_URL", config.mailUrl.cStr(), true));
      }
      if (config.rootUrl == nullptr) {
        if (config.port == 80) {
          KJ_SYSCALL(setenv("ROOT_URL", kj::str("http://", config.bindIp).cStr(), true));
        } else {
          KJ_SYSCALL(setenv("ROOT_URL",
              kj::str("http://", config.bindIp, ":", config.port).cStr(), true));
        }
      } else {
        KJ_SYSCALL(setenv("ROOT_URL", config.rootUrl.cStr(), true));
      }
      if (config.wildcardHost != nullptr) {
        KJ_SYSCALL(setenv("WILDCARD_HOST", config.wildcardHost.cStr(), true));
      }
      if (config.ddpUrl != nullptr) {
        KJ_SYSCALL(setenv("DDP_DEFAULT_CONNECTION_URL", config.ddpUrl.cStr(), true));
      }

      kj::String buildstamp;
      if (SANDSTORM_BUILD == 0) {
        buildstamp = kj::str("\"[", trim(readAll("buildstamp")), "]\"");
      } else {
        buildstamp = kj::str(SANDSTORM_BUILD);
      }

      KJ_SYSCALL(setenv("METEOR_SETTINGS", kj::str(
          "{\"public\":{\"build\":", buildstamp,
          ", \"kernelTooOld\":", kernelNewEnough ? "false" : "true",
          ", \"allowDemoAccounts\":", config.allowDemoAccounts ? "true" : "false",
          ", \"wildcardHost\":\"", config.wildcardHost, "\"",
          "}}").cStr(), true));
      KJ_SYSCALL(execl("/bin/node", "/bin/node", "main.js", EXEC_END_ARGS));
      KJ_UNREACHABLE;
    }

    return result;
  }

  void maybeWaitAfterChildDeath(kj::StringPtr title, int64_t startTime) {
    if (getTime() - startTime < 10ll * 1000 * 1000 * 1000) {
      context.warning(kj::str(
          "** ", title, " died immediately after starting.\n"
          "** Sleeping for a bit before trying again..."));

      // Sleep for 10 seconds to avoid burning resources on a restart loop.
      usleep(10 * 1000 * 1000);
    } else {
      context.warning(kj::str("** ", title, " died! Restarting it..."));
    }
  }

  void killChild(kj::StringPtr title, pid_t pid) {
    if (pid == 0) {
      // We use PID = 0 to indicate that a process isn't running, so there's nothing to do.
      context.warning(kj::str("Not killing ", title, " because it is not running."));
      return;
    }

    int status;

    KJ_SYSCALL(kill(pid, SIGTERM));

    alarmed = false;
    uint timeout = 5;
    KJ_SYSCALL(alarm(timeout));

    for (;;) {
      if (waitpid(pid, &status, 0) >= 0) {
        KJ_SYSCALL(alarm(0));
        return;
      }

      int error = errno;
      if (error == EINTR) {
        if (alarmed) {
          // Termination timed out.  Kill hard.
          context.warning(kj::str(
              title, " did not terminate after ", timeout, " seconds; killing."));
          KJ_SYSCALL(kill(pid, SIGKILL));
          alarmed = false;
        } else {
          // Some other signal; ignore.
        }
      } else {
        KJ_FAIL_SYSCALL("waitpid()", error, title);
      }
    }
  }

  bool checkForUpdates(kj::StringPtr channel, kj::StringPtr type, const Config& config) {
    if (!kernelNewEnough) {
      context.warning(
          "Refusing to update because kernel is too old or unprivileged user namespaces are "
          "disabled. You need at least kernel version 3.13 and must set the "
          "kernel.unprivileged_userns_clone sysctl (if your system has it) to 1. If in doubt, "
          "re-run the Sandstorm installer for help.");
      return false;
    }

    // GET install.sandstorm.io/$channel?from=$oldBuild&type=[manual|startup|daily]
    //     -> result is build number
    context.warning(kj::str("Checking for updates on channel ", channel, "..."));

    kj::String buildStr;

    {
      kj::String from;
      if (SANDSTORM_BUILD > 0) {
        from = kj::str("from=", SANDSTORM_BUILD, "&");
      }

      CurlRequest updateCheck(
          kj::str("https://install.sandstorm.io/", channel, "?", from, "type=", type));
      buildStr = readAll(updateCheck.getPipe());
    }

    uint targetBuild = KJ_ASSERT_NONNULL(parseUInt(trim(buildStr), 10));

    if (targetBuild <= SANDSTORM_BUILD) {
      context.warning("No update available.");
      return false;
    }

    // Start http request to download bundle.
    auto url = kj::str("https://dl.sandstorm.io/sandstorm-", targetBuild, ".tar.xz");
    context.warning(kj::str("Downloading: ", url));
    auto download = kj::heap<CurlRequest>(url);
    int fd = download->getPipe();
    unpackUpdate(fd, kj::mv(download), targetBuild);
    return true;
  }

  void unpackUpdate(int bundleFd, kj::Maybe<kj::Own<CurlRequest>> curlRequest = nullptr,
                    uint expectedBuild = 0) {
    char tmpdir[] = "../downloading.XXXXXX";
    if (mkdtemp(tmpdir) != tmpdir) {
      KJ_FAIL_SYSCALL("mkdtemp", errno);
    }
    KJ_DEFER(recursivelyDelete(tmpdir));

    pid_t tarPid = fork();
    if (tarPid == 0) {
      KJ_SYSCALL(dup2(bundleFd, STDIN_FILENO));
      KJ_SYSCALL(chdir(tmpdir));
      KJ_SYSCALL(execlp("tar", "tar", "Jxo", EXEC_END_ARGS));
      KJ_UNREACHABLE;
    }

    // Make sure to report CURL status before tar status.
    curlRequest = nullptr;

    int tarStatus;
    KJ_SYSCALL(waitpid(tarPid, &tarStatus, 0));
    KJ_ASSERT(WIFEXITED(tarStatus) && WEXITSTATUS(tarStatus) == 0, "tar failed");

    auto files = listDirectory(tmpdir);
    KJ_ASSERT(files.size() == 1, "Expected tar file to contain only one item.");
    KJ_ASSERT(files[0].startsWith("sandstorm-"), "Expected tar file to contain sandstorm-$BUILD.");

    uint targetBuild = KJ_ASSERT_NONNULL(parseUInt(files[0].slice(strlen("sandstorm-")), 10));

    if (expectedBuild != 0) {
      KJ_ASSERT(targetBuild == expectedBuild,
          "Downloaded bundle did not contain the build number we expecetd.");
    }

    kj::String targetDir;
    if (targetBuild == 0) {
      // Build 0 indicates a custom build. Tag it with the time.

      char buffer[128];
      time_t now = time(nullptr);
      struct tm local;
      localtime_r(&now, &local);
      strftime(buffer, sizeof(buffer), "%Y-%m-%d_%H-%M-%S", &local);
      targetDir = kj::str("../sandstorm-custom.", buffer);
    } else {
      targetDir = kj::str("../", files[0]);
    }

    if (access(targetDir.cStr(), F_OK) != 0) {
      KJ_SYSCALL(rename(kj::str(tmpdir, '/', files[0]).cStr(), targetDir.cStr()));
    }

    // Setup "latest" symlink, atomically.
    auto tmpLink = kj::str("../latest.", targetBuild);
    unlink(tmpLink.cStr());  // just in case; ignore failure
    KJ_SYSCALL(symlink(targetDir.slice(3).cStr(), tmpLink.cStr()));
    KJ_SYSCALL(rename(tmpLink.cStr(), "../latest"));
  }

  pid_t startUpdater(const Config& config, bool isRetry) {
    if (config.updateChannel == nullptr) {
      context.warning("WARNING: Auto-updates are disabled by config.");
      return 0;
    } else if (access("..", W_OK) != 0) {
      context.warning("WARNING: Auto-updates are disabled because the server does not have write "
                      "access to the installation location.");
      return 0;
    } else {
      pid_t pid = fork();
      if (pid == 0) {
        doUpdateLoop(config.updateChannel, isRetry, config);
        KJ_UNREACHABLE;
      }
      return pid;
    }
  }

  void doUpdateLoop(kj::StringPtr channel, bool isRetry, const Config& config) KJ_NORETURN {
    // This is the updater process.  Run in a loop.
    auto log = raiiOpen("../var/log/updater.log", O_WRONLY | O_APPEND | O_CREAT);
    KJ_SYSCALL(dup2(log, STDOUT_FILENO));
    KJ_SYSCALL(dup2(log, STDERR_FILENO));

    // Wait 10 minutes before the first update attempt just to make sure the server isn't going
    // to be shut down right away.  (On a retry, wait an hour so we don't overwhelm the servers
    // when a broken package is posted.)
    uint n = isRetry ? 3600 : 600;
    while (n > 0) n = sleep(n);

    // The 10-minute request is called "startup" while subsequent daily requests are called "daily".
    // We signal retries separately so that the server can monitor for flapping clients.
    kj::StringPtr type = isRetry ? "retry" : "startup";

    for (;;) {
      // Print time.
      time_t start = time(nullptr);
      context.warning(kj::str("** Time: ", ctime(&start)));

      // Check for updates.
      if (checkForUpdates(channel, type, config)) {
        // Exit so that the update can be applied.
        context.exitInfo("** Successfully updated; restarting.");
      }

      // Wait a day.  We actually wait 10 minutes at a time, then check if a day has passed, to
      // capture cases where the system was suspended.
      for (;;) {
        n = 600;
        while (n > 0) n = sleep(n);
        if (time(nullptr) - start >= 86400) break;
      }

      n = 86400;
      while (n > 0) n = sleep(n);
      type = "daily";
    }
  }

  void restartForUpdate(int pidfileFd) KJ_NORETURN {
    // Change pidfile to not close on exec, since we want it to live through the following exec!
    KJ_SYSCALL(fcntl(pidfileFd, F_SETFD, 0));

    // Create arg list.
    kj::Vector<const char*> argv;
    argv.add("../latest/sandstorm");
    argv.add("continue");
    if (unsharedUidNamespace) {
      argv.add("--userns");
    }
    auto pidfileFdStr = kj::str(pidfileFd);
    argv.add(pidfileFdStr.cStr());
    argv.add(EXEC_END_ARGS);

    // Exec the new version with our magic "continue".
    KJ_SYSCALL(execv(argv[0], const_cast<char**>(argv.begin())));
    KJ_UNREACHABLE;
  }

  void cleanupOldVersions() {
    for (auto& file: listDirectory("..")) {
      KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
        if (file.startsWith("sandstorm-")) {
          auto suffix = file.slice(strlen("sandstorm-"));
          if (suffix.startsWith("custom.")) {
            // This is a custom build. If we aren't currently running a custom build, go ahead and
            // delete it.
            if (SANDSTORM_BUILD != 0) {
              recursivelyDelete(kj::str("../", file));
            }
          } else KJ_IF_MAYBE(build, parseUInt(suffix, 10)) {
            // Only delete older builds.
            if (*build < SANDSTORM_BUILD) {
              KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
                recursivelyDelete(kj::str("../", file));
              })) {
                context.warning(kj::str("couldn't delete old build ", file, ": ",
                                        exception->getDescription()));
              }
            }
          }
        }
      })) {
        KJ_LOG(ERROR, "Error while trying to delete old versions.", *exception);
      }
    }
  }

  kj::AutoCloseFd connectToDevDaemon() {
    int sock_;
    KJ_SYSCALL(sock_ = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0));
    auto sock = kj::AutoCloseFd(sock_);

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, "../var/sandstorm/socket/devmode");
    KJ_SYSCALL(connect(sock, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)));

    return kj::mv(sock);
  }

  void runDevDaemon(const Config& config) KJ_NORETURN {
    clearDevApps(config);

    // Make sure socket directory exists (since the installer doesn't create it).
    if (mkdir("/var/sandstorm/socket", 0770) == 0) {
      // Allow group to use this directory.
      if (runningAsRoot) { KJ_SYSCALL(chown("/var/sandstorm/socket", 0, config.uids.gid)); }
    } else {
      int error = errno;
      if (error != EEXIST) {
        KJ_FAIL_SYSCALL("mkdir(/var/sandstorm/socket)", error);
      }
    }

    // Create the devmode socket.
    int sock_;
    KJ_SYSCALL(sock_ = socket(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0));
    auto sock = kj::AutoCloseFd(sock_);

    struct sockaddr_un addr;
    memset(&addr, 0, sizeof(addr));
    addr.sun_family = AF_UNIX;
    strcpy(addr.sun_path, "/var/sandstorm/socket/devmode");
    unlink(addr.sun_path);
    KJ_SYSCALL(bind(sock, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)));
    KJ_SYSCALL(listen(sock, 2));

    // Ensure that the group can connect to the socket.
    if (runningAsRoot) { KJ_SYSCALL(chown("/var/sandstorm/socket/devmode", 0, config.uids.gid)); }
    KJ_SYSCALL(chmod("/var/sandstorm/socket/devmode", 0770));

    // We don't care to reap dev sessions.
    KJ_SYSCALL(signal(SIGCHLD, SIG_IGN));

    // Please don't SIGPIPE if we write to a disconnected socket. An exception is nicer.
    KJ_SYSCALL(signal(SIGPIPE, SIG_IGN));

    for (;;) {
      int connFd_;
      KJ_SYSCALL(connFd_ = accept4(sock, nullptr, nullptr, SOCK_CLOEXEC));
      kj::AutoCloseFd connFd(connFd_);

      if (fork() == 0) {
        sock = nullptr;
        runDevSession(config, kj::mv(connFd));
        KJ_UNREACHABLE;
      }
    }
  }

  static constexpr kj::byte DEVMODE_COMMAND_CONNECT = 1;
  // Command code sent by `sandstorm dev` command, which is invoked by `spk dev`.

  static constexpr kj::byte DEVMODE_COMMAND_GETNS = 2;
  // Command code sent by sandstorm-supervisor when it needs to enter our namespace.
  //
  // TODO(cleanup): This constant is also defined in supervisor-main.c++. Share them.

  static constexpr kj::byte DEVMODE_COMMAND_SUPERVISE = 3;
  // Command code sent by `sandstorm supervise` command, which is invoked by the front-end when
  // running in meteor dev mode (outside of the sandbox) in order to start an app. The front-end
  // can't just invoke sandstorm-supervisor directly in this case since it's not in the proper
  // namespace. This command must be followed by three file descriptors (to represent stdin,
  // stdout, stderr), a series of NUL-terminated strings representing the arguments, and then
  // EOF.

  void runDevSession(const Config& config, kj::AutoCloseFd internalFd) KJ_NORETURN {
    auto exception = kj::runCatchingExceptions([&]() {
      // When someone connects, we expect them to pass us a one-byte command code.
      kj::byte commandCode;
      kj::FdInputStream((int)internalFd).read(&commandCode, 1);
      if (commandCode == DEVMODE_COMMAND_GETNS) {
        // Oh, they just want to know our namespace.
        auto nsfd = raiiOpen("/proc/self/ns/mnt", O_RDONLY);
        sendFd(internalFd, nsfd);
        return;
      } else if (commandCode == DEVMODE_COMMAND_SUPERVISE) {
        // Oh, they want us to run a sandstorm-supervisor.

        // Receive the standard FDs and dup2() them into place.
        KJ_SYSCALL(dup2(receiveFd(internalFd), STDIN_FILENO));
        KJ_SYSCALL(dup2(receiveFd(internalFd), STDOUT_FILENO));
        KJ_SYSCALL(dup2(receiveFd(internalFd), STDERR_FILENO));

        // Re-enable child reaping.
        KJ_SYSCALL(signal(SIGCHLD, SIG_DFL));

        // Supervisor should run unprivileged.
        dropPrivs(config.uids);

        // Compute args.
        auto args = readAll(internalFd);
        kj::StringPtr argsPtr = args;

        kj::Vector<const char*> argv;
        argv.add("/bin/sandstorm-supervisor");
        while (argsPtr.size() > 0) {
          argv.add(argsPtr.begin());
          argsPtr = argsPtr.slice(KJ_ASSERT_NONNULL(
              argsPtr.findFirst('\0'), "Invalid args pack; each arg must end with '\0'!") + 1);
        }
        argv.add(nullptr);

        // Execute.
        pid_t child;
        KJ_SYSCALL(child = fork());
        if (child == 0) {
          KJ_SYSCALL(execv(argv[0], const_cast<char**>(argv.begin())));
          KJ_UNREACHABLE;
        } else {
          int status;
          KJ_SYSCALL(waitpid(child, &status, 0));
          kj::FdOutputStream((int)internalFd).write(&status, sizeof(status));
          _exit(0);
        }
      }

      KJ_REQUIRE(commandCode == DEVMODE_COMMAND_CONNECT);
      context.warning("** Accepted new dev session connection...");

      // OK, we're accepting a new dev mode connection. `internalFd` is the socket opened by
      // the `sandstorm dev` command, implemented elsewhere in this file. All it does is pass
      // us the file descriptor originally provided by its invoker (i.e. from the `spk` tool).
      // So get that, then discard internalFd.
      auto fd = receiveFd(internalFd);
      internalFd = nullptr;

      // Dev error log goes to the connected session.
      KJ_SYSCALL(dup2(fd, STDOUT_FILENO));
      KJ_SYSCALL(dup2(fd, STDERR_FILENO));

      // Restore SIGCHLD, ignored by parent process.
      KJ_SYSCALL(signal(SIGCHLD, SIG_DFL));

      kj::FdInputStream rawInput((int)fd);
      kj::BufferedInputStreamWrapper input(rawInput);
      kj::String appId;
      KJ_IF_MAYBE(line, readLine(input)) {
        appId = kj::mv(*line);
      } else {
        KJ_FAIL_ASSERT("Expected app ID.");
      }

      for (char c: appId) {
        if (!isalnum(c)) {
          context.exitError("Invalid app ID. Must contain only alphanumerics.");
        }
      }

      char dir[] = "/var/sandstorm/apps/dev-XXXXXX";
      if (mkdtemp(dir) == nullptr) {
        KJ_FAIL_SYSCALL("mkdtemp(dir)", errno, dir);
      }
      KJ_DEFER(rmdir(dir));
      if (runningAsRoot) { KJ_SYSCALL(chown(dir, config.uids.uid, config.uids.gid)); }

      char* pkgId = strrchr(dir, '/') + 1;

      // We dont use fusermount(1) because it doesn't live in our namespace. For now, this is not
      // a problem because we're root anyway. If in the future we use UID namespaces to avoid being
      // root, then this gets complicated. We could include fusermount(1) in our package, but
      // it would have to be suid-root, defeating the goal of not using root rights.
      auto fuseFd = raiiOpen("/dev/fuse", O_RDWR);

      auto mountOptions = kj::str("fd=", fuseFd, ",rootmode=40000,"
          "user_id=", config.uids.uid, ",group_id=", config.uids.gid, ",allow_other");

      KJ_SYSCALL(mount("/dev/fuse", dir, "fuse", MS_NOSUID|MS_NODEV, mountOptions.cStr()));
      KJ_DEFER(umount2(dir, MNT_FORCE | UMOUNT_NOFOLLOW));

      // Send the FUSE fd back to the client.
      sendFd(fd, fuseFd);
      fuseFd = nullptr;

      // Kill all sandstorm-supervisor processes to force a reload of the app. (In theory we could
      // try to only kill supervisors of the specific app we're overriding, but that would take
      // some extra work to figure out. Killing them all shouldn't hurt much.)
      killall("/bin/sandstorm-supervisor");

      {
        // Read the manifest.
        capnp::StreamFdMessageReader reader(
            raiiOpen(kj::str(dir, "/sandstorm-manifest"), O_RDONLY));

        // Notify the front-end that the app exists.
        insertDevApp(config, appId, pkgId, reader.getRoot<spk::Manifest>());
      }

      {
        KJ_DEFER(removeDevApp(config, appId));

        for (;;) {
          KJ_IF_MAYBE(line, readLine(input)) {
            if (*line == "restart") {
              // Re-read the manifest.
              capnp::StreamFdMessageReader reader(
                  raiiOpen(kj::str(dir, "/sandstorm-manifest"), O_RDONLY));

              // Kill all the supervisors again to force a reload of the app.
              killall("/bin/sandstorm-supervisor");

              // Notify front-end that the app changed.
              updateDevApp(config, appId, reader.getRoot<spk::Manifest>());
            }
          } else {
            break;
          }
        }
      }

      // Kill all the supervisors again to shut down the app before we unmount it.
      killall("/bin/sandstorm-supervisor");
    });

    KJ_IF_MAYBE(e, exception) {
      context.exitError(kj::str(*e));
    } else {
      context.exit();
    }
  }

  void killall(kj::StringPtr exePath) {
    for (auto& file: listDirectory("/proc")) {
      KJ_IF_MAYBE(pid, parseUInt(file, 10)) {
        char buf[exePath.size()];
        char* bufPtr = buf;  // Clang doesn't like capturing variable-width arrays.

        ssize_t n;
        for (;;) {
          n = readlink(kj::str("/proc/", file, "/exe").cStr(), bufPtr, exePath.size());
          if (n < 0) {
            int error = errno;
            if (error == ENOENT) {
              // Probably the pid disappeared while we were listing the directory. No big deal.
              break;
            } else if (error != EINTR) {
              KJ_FAIL_SYSCALL("readlink(/proc/pid/exe)", error, pid);
            }
          } else {
            if (n >= 0 && n == exePath.size() && memcmp(exePath.begin(), buf, sizeof(buf)) == 0) {
              // It's the exe we want to kill!
              KJ_SYSCALL(kill(*pid, SIGTERM));
            }
            break;
          }
        }
      }
    }
  }

  void insertDevApp(const Config& config, kj::StringPtr appId, kj::StringPtr pkgId,
                    spk::Manifest::Reader manifest) {
    mongoCommand(config, kj::str(
        "db.devapps.insert({"
          "_id:\"", appId, "\","
          "packageId:\"", pkgId, "\","
          "timestamp:", time(nullptr), ","
          "manifest:", toJson(manifest),
        "})"));
  }

  void updateDevApp(const Config& config, kj::StringPtr appId, spk::Manifest::Reader manifest) {
    mongoCommand(config, kj::str(
        "db.devapps.update({_id:\"", appId, "\"}, {$set: {"
          "timestamp:", time(nullptr), ","
          "manifest:", toJson(manifest),
        "}})"));
  }

  void removeDevApp(const Config& config, kj::StringPtr appId) {
    mongoCommand(config, kj::str(
        "db.devapps.remove({_id:\"", appId, "\"})"));
  }

  void clearDevApps(const Config& config) {
    mongoCommand(config, kj::str("db.devapps.remove()"));
  }

  void mongoCommand(const Config& config, kj::StringPtr command, kj::StringPtr db = "meteor") {
    pid_t pid = fork();
    if (pid == 0) {
      // We don't want to unwind the stack in this subprocess.
      KJ_IF_MAYBE(exception, kj::runCatchingExceptions([&]() {
        // Don't run as root.
        dropPrivs(config.uids);

        execMongoClient(config, {"--quiet", "--eval", command }, db);
      })) {
        context.exitError(kj::str(*exception));
      }

      KJ_UNREACHABLE;
    }

    int status;
    KJ_SYSCALL(waitpid(pid, &status, 0)) { return; }
    KJ_ASSERT(WIFEXITED(status) && WEXITSTATUS(status) == 0,
              "mongo command failed", command) { return; }
  }

  void execMongoClient(const Config& config,
        std::initializer_list<kj::StringPtr> addlArgs,
        kj::StringPtr dbName = "meteor") KJ_NORETURN {
    auto db = kj::str("127.0.0.1:", config.mongoPort, "/", dbName);

    kj::Vector<const char*> args;
    args.add("/bin/mongo");

    // If /var/mongo/passwd exists, we interpret it as containing the password for a Mongo user
    // "sandstorm", and assume we are expected to log in as this user.
    kj::String password;
    if (access("/var/mongo/passwd", F_OK) == 0) {
      password = trim(readAll(raiiOpen("/var/mongo/passwd", O_RDONLY)));

      args.add("-u");
      args.add("sandstorm");
      args.add("-p");
      args.add(password.cStr());
      args.add("--authenticationDatabase");
      args.add("admin");
    }

    for (auto& arg: addlArgs) {
      args.add(arg.cStr());
    }

    args.add(db.cStr());
    args.add(nullptr);

    // OK, run the Mongo client!
    KJ_SYSCALL(execv(args[0], const_cast<char**>(args.begin())));
    KJ_UNREACHABLE;
  }

  // ---------------------------------------------------------------------------

  kj::MainBuilder::Validity setUpdateFile(kj::StringPtr arg) {
    // If the parameter consists only of lower-case letters, treat it as a channel name,
    // otherwise treat it as a file name. Any reasonable update file should end in .tar.xz
    // and therefore not be all letters.
    bool isFile = false;
    for (char c: arg) {
      if (c < 'a' || c > 'z') {
        isFile = true;
        break;
      }
    }

    updateFileIsChannel = !isFile;

    if (isFile && access(arg.cStr(), F_OK) < 0) {
      return "file not found";
    } else if (isFile && !arg.startsWith("/")) {
      char absoluteNameBuf[PATH_MAX + 1];
      KJ_SYSCALL(realpath(arg.cStr(), absoluteNameBuf));
      updateFile = kj::heapString(absoluteNameBuf);
      return true;
    } else {
      updateFile = kj::heapString(arg);
      return true;
    }
  }

  kj::MainBuilder::Validity setDevtoolsBindir(kj::StringPtr arg) {
    if (access(arg.cStr(), F_OK) != 0) {
      return "not found";
    }
    devtoolsBindir = arg;
    return true;
  }
};

constexpr kj::byte RunBundleMain::DEVMODE_COMMAND_CONNECT;
constexpr kj::byte RunBundleMain::DEVMODE_COMMAND_GETNS;
constexpr kj::byte RunBundleMain::DEVMODE_COMMAND_SUPERVISE;

}  // namespace sandstorm

KJ_MAIN(sandstorm::RunBundleMain)
