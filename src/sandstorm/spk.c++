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

// This is a tool for manipulating Sandstorm .spk files.

// Hack around stdlib bug with C++14.
#include <initializer_list>  // force libstdc++ to include its config
#undef _GLIBCXX_HAVE_GETS    // correct broken config
// End hack.

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/io.h>
#include <capnp/serialize.h>
#include <sodium.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/mman.h>
#include <errno.h>
#include <sandstorm/package.capnp.h>
#include <stdlib.h>
#include <dirent.h>
#include <set>
#include <map>
#include <sys/xattr.h>
#include <capnp/schema-parser.h>
#include <capnp/dynamic.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <kj/async-unix.h>
#include <ctype.h>
#include <time.h>

#include "version.h"
#include "fuse.h"
#include "union-fs.h"
#include "send-fd.h"

namespace sandstorm {

typedef kj::byte byte;

static const uint64_t APP_SIZE_LIMIT = 1ull << 30;
// For now, we will refuse to unpack an app over 1 GB (decompressed size).

// =======================================================================================
// base32 encode/decode derived from google-authenticator code, Apache 2.0 license:
//   https://code.google.com/p/google-authenticator/source/browse/libpam/base32.c
//
// Modifications:
// - Prefer to output in lower-case letters.
// - Use Douglas Crockford's alphabet mapping, except instead of excluding 'u', consider 'B' to
//   be a misspelling of '8'.
// - Use a lookup table for decoding (in addition to encoding).  Generate this table
//   programmatically at compile time.  C++14 constexpr is awesome.
// - Convert to KJ style.
//
// TODO(test):  This could use a unit test.

constexpr char BASE32_ENCODE_TABLE[] = "0123456789acdefghjkmnpqrstuvwxyz";

kj::String base32Encode(kj::ArrayPtr<const byte> data) {
  // We'll need a character for every 5 bits, rounded up.
  auto result = kj::heapString((data.size() * 8 + 4) / 5);

  uint count = 0;
  if (data.size() > 0) {
    uint buffer = data[0];
    uint next = 1;
    uint bitsLeft = 8;
    while (bitsLeft > 0 || next < data.size()) {
      if (bitsLeft < 5) {
        if (next < data.size()) {
          buffer <<= 8;
          buffer |= data[next++] & 0xFF;
          bitsLeft += 8;
        } else {
          // No more input; pad with zeros.
          uint pad = 5 - bitsLeft;
          buffer <<= pad;
          bitsLeft += pad;
        }
      }
      uint index = 0x1F & (buffer >> (bitsLeft - 5));
      bitsLeft -= 5;
      KJ_ASSERT(count < result.size());
      result[count++] = BASE32_ENCODE_TABLE[index];
    }
  }

  return result;
}

class Base32Decoder {
public:
  constexpr Base32Decoder(): decodeTable() {
    // Cool, we can generate our lookup table at compile time.

    for (byte& b: decodeTable) {
      b = 255;
    }

    for (uint i = 0; i < sizeof(BASE32_ENCODE_TABLE) - 1; i++) {
      unsigned char c = BASE32_ENCODE_TABLE[i];
      decodeTable[c] = i;
      if ('a' <= c && c <= 'z') {
        decodeTable[c - 'a' + 'A'] = i;
      }
    }

#pragma GCC diagnostic push
#pragma GCC diagnostic ignored "-Wchar-subscripts"
    decodeTable['o'] = decodeTable['O'] = 0;
    decodeTable['i'] = decodeTable['I'] = 1;
    decodeTable['l'] = decodeTable['L'] = 1;
    decodeTable['b'] = decodeTable['B'] = 8;
#pragma GCC diagnostic pop
  }

  constexpr bool verifyTable() const {
    // Verify that all letters and digits have a decoding.
    //
    // Oh cool, this can also be done at compile time, and then checked with a static_assert below.
    //
    // C++14 is awesome.

    for (unsigned char c = '0'; c <= '9'; c++) {
      if (decodeTable[c] == 255) return false;
    }
    for (unsigned char c = 'a'; c <= 'z'; c++) {
      if (decodeTable[c] == 255) return false;
    }
    for (unsigned char c = 'A'; c <= 'Z'; c++) {
      if (decodeTable[c] == 255) return false;
    }
    return true;
  }

  kj::Array<byte> decode(kj::StringPtr encoded) const {
    // We intentionally round the size down.  Leftover bits are presumably zero.
    auto result = kj::heapArray<byte>(encoded.size() * 5 / 8);

    uint buffer = 0;
    uint bitsLeft = 0;
    uint count = 0;
    for (char c: encoded) {
      byte decoded = decodeTable[(byte)c];
      KJ_ASSERT(decoded <= 32, "Invalid base32.");

      buffer <<= 5;
      buffer |= decoded;
      bitsLeft += 5;
      if (bitsLeft >= 8) {
        KJ_ASSERT(count < encoded.size());
        bitsLeft -= 8;
        result[count++] = buffer >> bitsLeft;
      }
    }

    buffer &= (1 << bitsLeft) - 1;
    KJ_REQUIRE(buffer == 0, "Base32 decode failed: extra bits at end.");

    return result;
  }

private:
  byte decodeTable[256];
};

constexpr Base32Decoder BASE64_DECODER;
static_assert(BASE64_DECODER.verifyTable(), "Base32 decode table is incomplete.");

// =======================================================================================

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

bool isDirectory(kj::StringPtr path) {
  struct stat stats;
  KJ_SYSCALL(lstat(path.cStr(), &stats));
  return S_ISDIR(stats.st_mode);
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

kj::String trim(kj::ArrayPtr<const char> slice) {
  while (slice.size() > 0 && isspace(slice[0])) {
    slice = slice.slice(1, slice.size());
  }
  while (slice.size() > 0 && isspace(slice[slice.size() - 1])) {
    slice = slice.slice(0, slice.size() - 1);
  }

  return kj::heapString(slice);
}

kj::Array<kj::String> splitLines(kj::String input) {
  // Split the input into lines, trimming whitespace, and ignoring blank lines or lines that start
  // with #.

  size_t lineStart = 0;
  kj::Vector<kj::String> results;
  for (size_t i = 0; i < input.size(); i++) {
    if (input[i] == '\n' || input[i] == '#') {
      bool hasComment = input[i] == '#';
      input[i] = '\0';
      auto line = trim(input.slice(lineStart, i));
      if (line.size() > 0) {
        results.add(kj::mv(line));
      }
      if (hasComment) {
        // Ignore through newline.
        ++i;
        while (i < input.size() && input[i] != '\n') ++i;
      }
      lineStart = i + 1;
    }
  }

  return results.releaseAsArray();
}

kj::AutoCloseFd openTemporary(kj::StringPtr near) {
  // Creates a temporary file in the same directory as the file specified by "near", immediately
  // unlinks it, and then returns the file descriptor,  which will be open for both read and write.

  // TODO(someday):  Use O_TMPFILE?  New in Linux 3.11.

  int fd;
  auto name = kj::str(near, ".XXXXXX");
  KJ_SYSCALL(fd = mkstemp(name.begin()));
  kj::AutoCloseFd result(fd);
  KJ_SYSCALL(unlink(name.cStr()));
  return result;
}

class ReplacementFile {
public:
  explicit ReplacementFile(kj::StringPtr name): name(name) {
    int fd_;
    replacementName = kj::str(name, ".XXXXXX");
    KJ_SYSCALL(fd_ = mkstemp(replacementName.begin()));
    fd = kj::AutoCloseFd(fd_);
  }
  ~ReplacementFile() {
    if (!committed) {
      // We never wrote the file. Attempt to clean up, but don't complain if this goes wrong
      // because we are probably in an exception unwind already.
      unlink(replacementName.cStr());
    }
  }

  KJ_DISALLOW_COPY(ReplacementFile);

  inline int getFd() { return fd; }

  void commit() {
    fd = nullptr;
    KJ_SYSCALL(rename(replacementName.cStr(), name.cStr()));
    committed = true;
  }

private:
  kj::StringPtr name;
  kj::AutoCloseFd fd;
  kj::String replacementName;
  bool committed = false;
};

size_t getFileSize(int fd, kj::StringPtr filename) {
  struct stat stats;
  KJ_SYSCALL(fstat(fd, &stats));
  KJ_REQUIRE(S_ISREG(stats.st_mode), "Not a regular file.", filename);
  return stats.st_size;
}

class MemoryMapping {
public:
  MemoryMapping(): content(nullptr) {}

  explicit MemoryMapping(int fd, kj::StringPtr filename): content(nullptr) {
    size_t size = getFileSize(fd, filename);

    if (size != 0) {
      void* ptr = mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
      if (ptr == MAP_FAILED) {
        KJ_FAIL_SYSCALL("mmap", errno, filename);
      }

      content = kj::arrayPtr(reinterpret_cast<byte*>(ptr), size);
    }
  }

  ~MemoryMapping() {
    if (content != nullptr) {
      KJ_SYSCALL(munmap(content.begin(), content.size()));
    }
  }

  KJ_DISALLOW_COPY(MemoryMapping);
  inline MemoryMapping(MemoryMapping&& other): content(other.content) {
    other.content = nullptr;
  }
  inline MemoryMapping& operator=(MemoryMapping&& other) {
    MemoryMapping old(kj::mv(*this));
    content = other.content;
    other.content = nullptr;
    return *this;
  }

  inline operator kj::ArrayPtr<const byte>() const {
    return content;
  }

  inline operator capnp::Data::Reader() const {
    return content;
  }

  inline operator kj::ArrayPtr<const capnp::word>() const {
    return kj::arrayPtr(reinterpret_cast<const capnp::word*>(content.begin()),
                        content.size() / sizeof(capnp::word));
  }

  inline size_t size() const { return content.size(); }

private:
  kj::ArrayPtr<byte> content;
};

class ChildProcess {
public:
  enum Direction {
    OUTPUT,
    INPUT
  };

  ChildProcess(kj::StringPtr command, kj::StringPtr flags,
               kj::AutoCloseFd wrappedFd, Direction direction) {
    int pipeFds[2];
    KJ_SYSCALL(pipe(pipeFds));
    kj::AutoCloseFd pipeInput(pipeFds[0]), pipeOutput(pipeFds[1]);

    KJ_SYSCALL(pid = fork());
    if (pid == 0) {
      if (direction == OUTPUT) {
        KJ_SYSCALL(dup2(pipeInput, STDIN_FILENO));
        KJ_SYSCALL(dup2(wrappedFd, STDOUT_FILENO));
      } else {
        KJ_SYSCALL(dup2(wrappedFd, STDIN_FILENO));
        KJ_SYSCALL(dup2(pipeOutput, STDOUT_FILENO));
      }
      pipeInput = nullptr;
      pipeOutput = nullptr;
      wrappedFd = nullptr;

      KJ_SYSCALL(execlp(command.cStr(), command.cStr(), flags.cStr(), (const char*)nullptr),
                 command);
      KJ_UNREACHABLE;
    } else {
      if (direction == OUTPUT) {
        pipeFd = kj::mv(pipeOutput);
      } else {
        pipeFd = kj::mv(pipeInput);
      }
    }
  }

  ~ChildProcess() {
    if (pid == 0) return;

    if (unwindDetector.isUnwinding()) {
      // An exception was thrown, so force-kill the child.
      int status;
      while (kill(pid, SIGKILL) < 0 && errno == EINTR) {}
      while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    } else {
      // Close the pipe first, in case the child is waiting for that.
      pipeFd = nullptr;

      int status;
      KJ_SYSCALL(waitpid(pid, &status, 0)) { return; }
      if (status != 0) {
        if (WIFEXITED(status)) {
          int exitCode = WEXITSTATUS(status);
          KJ_FAIL_ASSERT("child process failed", exitCode) { return; }
        } else if (WIFSIGNALED(status)) {
          int signalNumber = WTERMSIG(status);
          KJ_FAIL_ASSERT("child process crashed", signalNumber) { return; }
        } else {
          KJ_FAIL_ASSERT("child process failed") { return; }
        }
      }
    }
  }

  int getPipe() { return pipeFd; }

  KJ_DISALLOW_COPY(ChildProcess);

private:
  kj::AutoCloseFd pipeFd;
  pid_t pid;
  kj::UnwindDetector unwindDetector;
};

class SpkTool {
  // Main class for the Sandstorm spk tool.

public:
  SpkTool(kj::ProcessContext& context): context(context) {
    char buf[PATH_MAX + 1];
    ssize_t n;
    KJ_SYSCALL(n = readlink("/proc/self/exe", buf, sizeof(buf)));
    buf[n] = '\0';
    exePath = kj::heapString(buf, n);
    if (exePath.endsWith("/bin/spk")) {
      installHome = kj::heapString(buf, n - strlen("/bin/spk"));
    }
  }

  kj::MainFunc getMain() {
    return addCommonOptions(OptionSet::ALL,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
          "Tool for building and checking Sandstorm package files.",
          "Sandstorm packages are compressed archives cryptographically signed in order to prove "
          "that upgrades came from the same source. This tool will help you create and sign "
          "packages. This tool can also let you run an app in development mode on a local "
          "Sandstorm instance, without actually building a package, and can automatically "
          "determine your app's dependencies.\n"
          "\n"
          "This tool should be run inside your app's source directory. It expects to find a file "
          "in the current directory called `sandstorm-pkgdef.capnp` which should define a "
          "constant named `pkgdef` of type `PackageDefinition` as defined in "
          "`/sandstorm/package.capnp`. You can usually find `package.capnp` in your Sandstorm "
          "installation, e.g.:\n"
          "  /opt/sandstorm/latest/usr/include/sandstorm/package.capnp\n"
          "The file contains comments describing the package definition format, which is based "
          "on Cap'n Proto (https://capnproto.org). You can also use the `init` command to "
          "generate a sample definition file in the current directory.\n"
          "\n"
          "App signing keys are not stored in your source directory; they are instead placed "
          "on a keyring, currently stored at `~/.sandstorm-keyring`. It is important that you "
          "protect this file. If you lose it, you won't be able to update your app. If someone "
          "else steals it, they will be able to publish updates to your app. Keep a backup! "
          "(In the future, we plan to add features to better protect your keyring.)\n"
          "\n"
          "Note that you may combine two keyring files by simply concatenating them.")
        .addSubCommand("keygen", KJ_BIND_METHOD(*this, getKeygenMain),
                       "Generate a new app ID and private key.")
        .addSubCommand("listkeys", KJ_BIND_METHOD(*this, getListkeysMain),
                       "List all keys on your keyring.")
        .addSubCommand("getkey", KJ_BIND_METHOD(*this, getGetkeyMain),
                       "Get a single key from your keyring, e.g. to send to someone.")
        .addSubCommand("init", KJ_BIND_METHOD(*this, getInitMain),
                       "Create a sample package definition for a new app.")
        .addSubCommand("pack", KJ_BIND_METHOD(*this, getPackMain),
                       "Create an spk from a directory tree and a signing key.")
        .addSubCommand("unpack", KJ_BIND_METHOD(*this, getUnpackMain),
                       "Unpack an spk to a directory, verifying its signature.")
        .addSubCommand("dev", KJ_BIND_METHOD(*this, getDevMain),
                       "Run an app in dev mode."))
        .build();
  }

private:
  kj::ProcessContext& context;
  kj::String exePath;
  kj::Maybe<kj::String> installHome;

  // Used to parse package def.
  capnp::SchemaParser parser;
  kj::Vector<kj::String> importPath;
  spk::PackageDefinition::Reader packageDef;
  kj::String sourceDir;
  bool sawPkgDef = false;

  kj::StringPtr keyringPath = nullptr;
  bool quiet = false;

  kj::Maybe<kj::Own<MemoryMapping>> keyringMapping;
  std::map<kj::String, kj::Own<capnp::FlatArrayMessageReader>> keyMap;

  enum class OptionSet {
    ALL, ALL_READONLY, KEYS, KEYS_READONLY
  };

  kj::MainBuilder& addCommonOptions(OptionSet options, kj::MainBuilder& builder) {
    if (options == OptionSet::ALL || options == OptionSet::ALL_READONLY) {
      builder.addOptionWithArg({'I', "import-path"}, KJ_BIND_METHOD(*this, addImportPath), "<path>",
              "Additionally search for Cap'n Proto schemas in <path>. (This allows your package "
              "definition file to import files from that directory -- this is rarely useful.)")
          .addOptionWithArg({'p', "pkg-def"}, KJ_BIND_METHOD(*this, setPackageDef),
                            "<def-file>:<name>",
              "Don't read the package definition from ./sandstorm-pkgdef.capnp. Instead, read "
              "from <def-file>, and expect the constant to be named <name>.");
    }
    builder.addOptionWithArg({'k', "keyring"}, KJ_BIND_METHOD(*this, setKeyringPath), "<path>",
            "Use <path> as the keyring file, rather than $HOME/.sandstorm-keyring.");
    if (options != OptionSet::KEYS_READONLY && options != OptionSet::ALL_READONLY) {
      builder.addOption({'q', "quiet"}, KJ_BIND_METHOD(*this, setQuiet),
              "Don't write the keyring warning to stderr.");
    }
    return builder;
  }

  kj::MainBuilder::Validity setPackageDef(kj::StringPtr arg) {
    KJ_IF_MAYBE(colonPos, arg.findFirst(':')) {
      auto filename = kj::heapString(arg.slice(0, *colonPos));
      auto constantName = arg.slice(*colonPos + 1);

      if (access(filename.cStr(), F_OK) != 0) {
        return "not found";
      }

      KJ_IF_MAYBE(slashPos, filename.findLast('/')) {
        sourceDir = kj::heapString(filename.slice(0, *slashPos));
      } else {
        sourceDir = nullptr;
      }

      KJ_IF_MAYBE(i, installHome) {
        if (*i != "/usr/local" && *i != "/usr") {
          auto candidate = kj::str(*i, "/usr/include");
          if (access(candidate.cStr(), F_OK) == 0) {
            importPath.add(kj::mv(candidate));
          }
        }
      }

      importPath.add(kj::heapString("/usr/local/include"));
      importPath.add(kj::heapString("/usr/include"));

      auto importPathPtrs = KJ_MAP(p, importPath) -> kj::StringPtr { return p; };

      parser.loadCompiledTypeAndDependencies<spk::PackageDefinition>();

      auto schema = parser.parseDiskFile(filename, filename, importPathPtrs);
      KJ_IF_MAYBE(symbol, schema.findNested(constantName)) {
        if (!symbol->getProto().isConst()) {
          return kj::str("\"", constantName, "\" is not a constant");
        }

        packageDef = symbol->asConst().as<spk::PackageDefinition>();

        return true;
      } else {
        return kj::str("\"", constantName, "\" not defined in schema file");
      }
    } else {
      return "argument missing constant name";
    }
  }

  void ensurePackageDefParsed() {
    if (!sawPkgDef) {
      auto valid = setPackageDef("sandstorm-pkgdef.capnp:pkgdef");
      KJ_IF_MAYBE(e, valid.getError()) {
        context.exitError(kj::str("sandstorm-pkgdef.capnp: ", *e));
      }
    }
  }

  void printAppId(kj::StringPtr appId) {
    kj::String msg = kj::str(appId, "\n");
    kj::FdOutputStream out(STDOUT_FILENO);
    out.write(msg.begin(), msg.size());
  }

  void printAppId(kj::ArrayPtr<const byte> publicKey) {
    static_assert(crypto_sign_PUBLICKEYBYTES == 32, "Signing algorithm changed?");
    KJ_REQUIRE(publicKey.size() == crypto_sign_PUBLICKEYBYTES);

    printAppId(base32Encode(publicKey));
  }

  kj::MainBuilder::Validity setKeyringPath(kj::StringPtr arg) {
    if (access(arg.cStr(), F_OK) != 0) {
      return "not found";
    }
    keyringPath = arg;
    return true;
  }

  kj::MainBuilder::Validity setQuiet() {
    quiet = true;
    return true;
  }

  kj::AutoCloseFd openKeyring(int flags) {
    kj::StringPtr filename;
    kj::String ownFilename;
    if (keyringPath == nullptr) {
      const char* home = getenv("HOME");
      KJ_REQUIRE(home != nullptr, "$HOME is not set!");
      ownFilename = kj::str(home, "/.sandstorm-keyring");
      filename = ownFilename;
    } else {
      filename = keyringPath;
    }
    if (!quiet && (flags & O_ACCMODE) != O_RDONLY) {
      context.warning(kj::str(
          "** WARNING: Keys are being added to:\n",
          "**   ", filename, "\n"
          "** Please make a backup of this file and keep it safe. If you lose your keys,\n"
          "** you won't be able to update your app. If someone steals your keys, they\n"
          "** will be able to post updates for your app. (Use -q to quiet this warning.)"));
    }
    return raiiOpen(filename, flags, 0600);
  }

  spk::KeyFile::Reader lookupKey(kj::StringPtr appid) {
    if (keyringMapping == nullptr) {
      auto mapping = kj::heap<MemoryMapping>(openKeyring(O_RDONLY), "(keyring)");
      kj::ArrayPtr<const capnp::word> words = *mapping;
      keyringMapping = kj::mv(mapping);

      while (words.size() > 0) {
        auto reader = kj::heap<capnp::FlatArrayMessageReader>(words);
        auto key = reader->getRoot<spk::KeyFile>();
        words = kj::arrayPtr(reader->getEnd(), words.end());
        keyMap.insert(std::make_pair(base32Encode(key.getPublicKey()), kj::mv(reader)));
      }
    }

    auto iter = keyMap.find(kj::str(appid));
    if (iter == keyMap.end()) {
      context.exitError(kj::str(appid, ": key not found in keyring"));
    } else {
      auto key = iter->second->getRoot<spk::KeyFile>();
      KJ_REQUIRE(key.getPublicKey().size() == crypto_sign_PUBLICKEYBYTES &&
                 key.getPrivateKey().size() == crypto_sign_SECRETKEYBYTES,
                 "Invalid key in keyring.");
      return key;
    }
  }

  // =====================================================================================

  kj::MainFunc getKeygenMain() {
    return addCommonOptions(OptionSet::KEYS,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Create a new app ID and signing key and store it to your keyring. It will then be "
            "used by the `pack` command to sign your app package. Note that when starting a new "
            "app, it's better to use `spk init`. Only use `keygen` when you need to replace the "
            "key on an existing app, e.g. because you're forking it. See `spk help` for more "
            "info about keyrings.")
        .callAfterParsing(KJ_BIND_METHOD(*this, doKeygen)))
        .build();
  }

  kj::String generateKey() {
    capnp::MallocMessageBuilder message(32);
    spk::KeyFile::Builder builder = message.getRoot<spk::KeyFile>();

    int result = crypto_sign_keypair(
        builder.initPublicKey(crypto_sign_PUBLICKEYBYTES).begin(),
        builder.initPrivateKey(crypto_sign_SECRETKEYBYTES).begin());
    KJ_ASSERT(result == 0, "crypto_sign_keypair failed", result);

    capnp::writeMessageToFd(openKeyring(O_WRONLY | O_APPEND | O_CREAT), message);

    return base32Encode(builder.getPublicKey());
  }

  kj::MainBuilder::Validity doKeygen() {
    printAppId(generateKey());

    return true;
  }

  kj::MainFunc getListkeysMain() {
    return addCommonOptions(OptionSet::KEYS_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "List the app IDs corresponding to each key on your keyring.")
        .callAfterParsing(KJ_BIND_METHOD(*this, doListkeys)))
        .build();
  }

  kj::MainBuilder::Validity doListkeys() {
    MemoryMapping mapping(openKeyring(O_RDONLY), "(keyring)");

    kj::ArrayPtr<const capnp::word> words = mapping;

    while (words.size() > 0) {
      capnp::FlatArrayMessageReader reader(words);
      printAppId(reader.getRoot<spk::KeyFile>().getPublicKey());
      words = kj::arrayPtr(reader.getEnd(), words.end());
    }

    return true;
  }

  kj::MainFunc getGetkeyMain() {
    return addCommonOptions(OptionSet::KEYS_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Get the the keys with the given app IDs from your keyring and write them as "
            "Cap'n Proto message to stdout. The output is a valid keyring containing only the "
            "IDs requested. Note that keyrings can be combined via concatenation, so someone "
            "else can add these keys to their own keyring using a command like:\n"
            "    cat keys >> ~/.sandstorm-keyring")
        .expectOneOrMoreArgs("<appid>", KJ_BIND_METHOD(*this, getKey)))
        .build();
  }

  kj::MainBuilder::Validity getKey(kj::StringPtr appid) {
    if (isatty(STDOUT_FILENO)) {
      return "The output is binary. You want to redirect it to a file. Pipe through cat if you "
             "really intended to write it to your terminal. :)";
    }

    auto key = lookupKey(appid);
    capnp::MallocMessageBuilder builder(key.totalSize().wordCount + 4);
    builder.setRoot(key);
    capnp::writeMessageToFd(STDOUT_FILENO, builder);

    return true;
  }

  // =====================================================================================

  kj::MainFunc getInitMain() {
    return addCommonOptions(OptionSet::KEYS,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Initialize the current directory as a Sandstorm package source directory by "
            "writing a `sandstorm-pkgdef.capnp` with a newly-created app ID. <command> "
            "specifies the command used to start your app.")
        .addOptionWithArg({'o', "output"}, KJ_BIND_METHOD(*this, setOutputFile), "<filename>",
            "Write to <filename> instead of `sandstorm-pkgdef.capnp`. Use `-o -` to write to "
            "standard output.")
        .addOptionWithArg({'i', "app-id"}, KJ_BIND_METHOD(*this, setAppIdForInit), "<app-id>",
            "Use <app-id> as the application ID rather than generate a new one.")
        .addOptionWithArg({'p', "port"}, KJ_BIND_METHOD(*this, setPortForInit), "<port>",
            "Set the HTTP port on which your server runs -- that is, the port which <command> "
            "will bind to. Your app will be set up to use Sandstorm's HTTP bridge instead of "
            "using the raw Sandstorm APIs.")
        .addOptionWithArg({'I', "source-path"}, KJ_BIND_METHOD(*this, addSourcePathForInit), "<path>",
            "Add <path> to the path from which files are pulled into the binary. You may "
            "specify this multiple times to set up a search path. If no paths are given, the "
            "default is to seach '.' (current directory) followed by '/' (root), with some "
            "sensitive directories hidden from '/'.")
        .addOption({'A', "include-all"}, KJ_BIND_METHOD(*this, setIncludeAllForInit),
            "Arrange to include all contents of the directories specified with -I rather than "
            "determine needed files dynamically while running in dev mode.")
        .addOption({'r', "raw"}, KJ_BIND_METHOD(*this, setUsesRawApi),
            "Specifies that your app directly implements the raw Sandstorm API and does "
            "not require the HTTP bridge.")
        .expectOneOrMoreArgs("-- <command>", KJ_BIND_METHOD(*this, addCommandArg))
        .callAfterParsing(KJ_BIND_METHOD(*this, doInit)))
        .build();
  }

  kj::StringPtr outputFile = nullptr;
  kj::StringPtr appIdForInit = nullptr;
  kj::Vector<kj::StringPtr> commandArgs;
  kj::Vector<kj::StringPtr> sourcePathForInit;
  uint16_t httpPort = 0;
  bool usesRawApi = false;
  bool includeAllForInit = false;

  kj::MainBuilder::Validity setOutputFile(kj::StringPtr arg) {
    outputFile = arg;
    return true;
  }

  kj::MainBuilder::Validity setAppIdForInit(kj::StringPtr arg) {
    for (char c: arg) {
      if (!isalnum(c)) {
        return "invalid app ID";
      }
    }
    appIdForInit = arg;
    return true;
  }

  kj::MainBuilder::Validity setPortForInit(kj::StringPtr arg) {
    if (usesRawApi) {
      return "You can't specify both -p and -r.";
    }
    KJ_IF_MAYBE(i, parseUInt(arg, 10)) {
      if (*i < 1 || *i > 65535) {
        return "port out-of-range";
      } else if (*i < 1024) {
        return "Ports under 1024 are priveleged and cannot be used by a Sandstorm app.";
      }
      httpPort = *i;
      return true;
    } else {
      return "invalid port";
    }
  }

  kj::MainBuilder::Validity addSourcePathForInit(kj::StringPtr arg) {
    sourcePathForInit.add(arg);
    return true;
  }

  kj::MainBuilder::Validity setIncludeAllForInit() {
    includeAllForInit = true;
    return true;
  }

  kj::MainBuilder::Validity setUsesRawApi() {
    if (httpPort != 0) {
      return "You can't specify both -p and -r.";
    }
    usesRawApi = true;
    return true;
  }

  kj::MainBuilder::Validity addCommandArg(kj::StringPtr arg) {
    commandArgs.add(arg);
    return true;
  }

  uint64_t generateCapnpId() {
    uint64_t result;

    int fd;
    KJ_SYSCALL(fd = open("/dev/urandom", O_RDONLY));

    ssize_t n;
    KJ_SYSCALL(n = read(fd, &result, sizeof(result)), "/dev/urandom");
    KJ_ASSERT(n == sizeof(result), "Incomplete read from /dev/urandom.", n);

    return result | (1ull << 63);
  }

  kj::MainBuilder::Validity doInit() {
    if (httpPort == 0 && !usesRawApi) {
      return "You must specify at least one of -p or -r.";
    }

    kj::String searchPath;
    if (sourcePathForInit.size() == 0) {
      if (includeAllForInit) {
        return "When using -A you must specify at least one -I.";
      }

      searchPath = kj::str(
          "      ( sourcePath = \".\" ),  # Search this directory first.\n"
          "      ( sourcePath = \"/\",    # Then search the system root directory.\n"
          "        hidePaths = [ \"home\", \"proc\", \"sys\" ]\n"
          "        # You probably don't want the app pulling files from these places,\n"
          "        # so we hide them. Note that /dev, /var, and /tmp are implicitly\n"
          "        # hidden because Sandstorm itself provides them.\n"
          "      )\n");
    } else {
      searchPath = kj::str(
          "      ( sourcePath = \"",
          kj::strArray(sourcePathForInit, "\" ),\n      ( sourcePath = \""),
          "\" )\n"
          );
    }

    if (outputFile == nullptr) {
      outputFile = "sandstorm-pkgdef.capnp";
      if (access(outputFile.cStr(), F_OK) == 0) {
        return "`sandstorm-pkgdef.capnp` already exists";
      }
    }

    kj::String ownAppId;
    if (appIdForInit == nullptr) {
      ownAppId = generateKey();
      appIdForInit = ownAppId;
    }

    auto argv = kj::str("\"", kj::strArray(commandArgs, "\", \""), "\"");

    if (httpPort != 0) {
      argv = kj::str("\"/sandstorm-http-bridge\", \"", httpPort, "\", \"--\", ", kj::mv(argv));
    }

    kj::AutoCloseFd outFd;
    if (outputFile == "-") {
      int fd;
      KJ_SYSCALL(fd = dup(STDOUT_FILENO));
      outFd = kj::AutoCloseFd(fd);
    } else {
      outFd = raiiOpen(outputFile, O_WRONLY | O_TRUNC | O_CREAT);
    }

    kj::FdOutputStream out(kj::mv(outFd));

    auto content = kj::str(
        "@0x", kj::hex(generateCapnpId()), ";\n"
        "\n"
        "using Spk = import \"/sandstorm/package.capnp\";\n"
        "# This imports:\n"
        "#   $SANDSTORM_HOME/latest/usr/include/sandstorm/package.capnp\n"
        "# Check out that file to see the full, documented package definition format.\n"
        "\n"
        "const pkgdef :Spk.PackageDefinition = (\n"
        "  # The package definition. Note that the spk tool looks specifically for the\n"
        "  # \"pkgdef\" constant.\n"
        "\n"
        "  id = \"", appIdForInit, "\",\n"
        "  # Your app ID is actually its public key. The private key was placed in\n"
        "  # your keyring. All updates must be signed with the same key.\n"
        "\n"
        "  manifest = (\n"
        "    # This manifest is included in your app package to tell Sandstorm\n"
        "    # about your app.\n"
        "\n"
        "    appVersion = 0,  # Increment this for every release.\n"
        "\n"
        "    actions = [\n"
        "      # Define your \"new document\" handlers here.\n"
        "      ( title = (defaultText = \"New Example App Instance\"),\n"
        "        command = .myCommand\n"
        "        # The command to run when starting for the first time. (\".myCommand\"\n"
        "        # is just a constant defined at the bottom of the file.)\n"
        "      )\n"
        "    ],\n"
        "\n"
        "    continueCommand = .myCommand\n"
        "    # This is the command called to start your app back up after it has been\n"
        "    # shut down for inactivity. Here we're using the same command as for\n"
        "    # starting a new instance, but you could use different commands for each\n"
        "    # case.\n"
        "  ),\n"
        "\n"
        "  sourceMap = (\n",
        includeAllForInit
        ? "    # The following directories will be copied into your package.\n"
        : "    # Here we defined where to look for files to copy into your package. The\n"
          "    # `spk dev` command actually figures out what files your app needs\n"
          "    # automatically by running it on a FUSE filesystem. So, the mappings\n"
          "    # here are only to tell it where to find files that the app wants.\n",
        "    searchPath = [\n",
               searchPath,
        "    ]\n"
        "  ),\n"
        "\n",
        includeAllForInit
        ? "  alwaysInclude = [ \".\" ]\n"
          "  # This says that we always want to include all files from the source map.\n"
          "  # (An alternative is to automatically detect dependencies by watching what\n"
          "  # the app opens while running in dev mode. To see what that looks like,\n"
          "  # run `spk init` without the -A option.)\n"
        : "  fileList = \"sandstorm-files.list\",\n"
          "  # `spk dev` will write a list of all the files your app uses to this file.\n"
          "  # You should review it later, before shipping your app.\n"
          "\n"
          "  alwaysInclude = []\n"
          "  # Fill this list with more names of files or directories that should be\n"
          "  # included in your package, even if not listed in sandstorm-files.list.\n"
          "  # Use this to force-include stuff that you know you need but which may\n"
          "  # not have been detected as a dependency during `spk dev`. If you list\n"
          "  # a directory here, its entire contents will be included recursively.\n",
        ");\n"
        "\n"
        "const myCommand :Spk.Manifest.Command = (\n"
        "  # Here we define the command used to start up your server.\n"
        "  argv = [", argv, "],\n"
        "  environ = [\n"
        "    # Note that this defines the *entire* environment seen by your app.\n"
        "    (key = \"PATH\", value = \"/usr/local/bin:/usr/bin:/bin\")\n"
        "  ]\n"
        ");\n");

    out.write(content.begin(), content.size());

    context.exitInfo(kj::str("wrote: ", outputFile));
  }

  // =====================================================================================

  kj::String spkfile;

  kj::MainFunc getPackMain() {
    return addCommonOptions(OptionSet::ALL_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Package the app as an spk, writing it to <output>.")
        .expectArg("<output>", KJ_BIND_METHOD(*this, setSpkfile))
        .callAfterParsing(KJ_BIND_METHOD(*this, doPack)))
        .build();
  }

  kj::MainBuilder::Validity setSpkfile(kj::StringPtr name) {
    spkfile = kj::heapString(name);
    return true;
  }

  kj::MainBuilder::Validity doPack() {
    ensurePackageDefParsed();

    spk::KeyFile::Reader key = lookupKey(packageDef.getId());

    kj::AutoCloseFd tmpfile = packToTempFile();

    // Map the temp file back in.
    MemoryMapping tmpMapping(tmpfile, spkfile);
    kj::ArrayPtr<const byte> tmpData = tmpMapping;

    if (tmpData.size() > APP_SIZE_LIMIT) {
      context.exitError(kj::str(
          "App exceeds uncompressed size limit of ", APP_SIZE_LIMIT >> 30, " GiB. This limit "
          "exists for the safety of hosts, but if you feel there is a strong case for allowing "
          "larger apps, please contact the Sandstorm developers."));
    }

    // Hash it.
    byte hash[crypto_hash_BYTES];
    crypto_hash(hash, tmpData.begin(), tmpData.size());

    // Generate the signature.
    capnp::MallocMessageBuilder signatureMessage;
    spk::Signature::Builder signature = signatureMessage.getRoot<spk::Signature>();
    signature.setPublicKey(key.getPublicKey());
    unsigned long long siglen = crypto_hash_BYTES + crypto_sign_BYTES;
    crypto_sign(signature.initSignature(siglen).begin(), &siglen,
                hash, sizeof(hash), key.getPrivateKey().begin());

    // Now write the whole thing out.
    {
      auto finalFile = raiiOpen(spkfile, O_WRONLY | O_CREAT | O_TRUNC);

      // Write magic number uncompressed.
      auto magic = spk::MAGIC_NUMBER.get();
      kj::FdOutputStream(finalFile.get()).write(magic.begin(), magic.size());

      // Pipe content through xz compressor.
      ChildProcess child("xz", "-zc", kj::mv(finalFile), ChildProcess::OUTPUT);

      // Write signature and archive out to the pipe.
      kj::FdOutputStream out(child.getPipe());
      capnp::writeMessage(out, signatureMessage);
      out.write(tmpData.begin(), tmpData.size());
    }

    printAppId(key.getPublicKey());

    return true;
  }

  kj::AutoCloseFd packToTempFile() {
    // Read in the file list.
    ArchiveNode root;

    // Set up special files that will be over-mounted by the supervisor.
    root.followPath("dev");
    root.followPath("tmp");
    root.followPath("var");
    root.followPath("proc").followPath("cpuinfo").setData(nullptr);

    auto sourceMap = packageDef.getSourceMap();

    if (packageDef.hasFileList()) {
      auto fileListFile = packageDef.getFileList();
      if (access(fileListFile.cStr(), F_OK) != 0) {
        context.exitInfo(kj::str("\"", fileListFile,
            "\" does not exist. Have you run `spk dev` yet?"));
      }

      for (auto& line: splitLines(readAll(raiiOpen(fileListFile, O_RDONLY)))) {
        addNode(root, line, sourceMap, false);
      }
    }
    for (auto file: packageDef.getAlwaysInclude()) {
      addNode(root, file, sourceMap, true);
    }

    auto tmpfile = openTemporary(spkfile);

    // Write the archive.
    capnp::MallocMessageBuilder archiveMessage;
    auto archive = archiveMessage.getRoot<spk::Archive>();
    struct timespec defaultMTime;
    KJ_SYSCALL(clock_gettime(CLOCK_REALTIME, &defaultMTime));
    archive.adoptFiles(root.packChildren(archiveMessage.getOrphanage(), context, defaultMTime));
    capnp::writeMessageToFd(tmpfile, archiveMessage);

    return tmpfile;
  }

  class ArchiveNode {
    // A tree of files.
  public:
    ArchiveNode() {}

    inline void setTarget(kj::String&& target) { this->target = kj::mv(target); }
    inline void setData(kj::Array<capnp::word>&& data) { this->data = kj::mv(data); }

    ArchiveNode& followPath(kj::StringPtr path) {
      if (path == nullptr) return *this;

      kj::String pathPart;
      KJ_IF_MAYBE(slashPos, path.findFirst('/')) {
        pathPart = kj::heapString(path.slice(0, *slashPos));
        path = path.slice(*slashPos + 1);
      } else {
        pathPart = kj::heapString(path);
        path = nullptr;
      }

      return children[kj::mv(pathPart)].followPath(path);
    }

    void pack(spk::Archive::File::Builder builder, kj::ProcessContext& context,
              struct timespec defaultMTime) {
      auto orphanage = capnp::Orphanage::getForMessageContaining(builder);

      KJ_IF_MAYBE(d, data) {
        KJ_ASSERT(children.empty(), "got file, expected directory", target);
        auto bytes = kj::arrayPtr(reinterpret_cast<const kj::byte*>(d->begin()),
                                  d->size() * sizeof(capnp::word));
        builder.adoptRegular(orphanage.referenceExternalData(bytes));
        return;
      }

      struct stat stats;

      if (target == nullptr) {
        stats.st_mode = S_IFDIR;
        stats.st_mtim = defaultMTime;
      } else {
        KJ_SYSCALL(lstat(target.cStr(), &stats), target);
      }

      auto mtime = stats.st_mtim.tv_sec * kj::SECONDS + stats.st_mtim.tv_nsec * kj::NANOSECONDS;
      builder.setLastModificationTimeNs(mtime / kj::NANOSECONDS);

      if (S_ISREG(stats.st_mode)) {
        KJ_ASSERT(children.empty(), "got file, expected directory", target);

        mapping = MemoryMapping(raiiOpen(target, O_RDONLY), target);

        if (mapping.size() >= (1ull << 29)) {
          context.exitError(kj::str(target, ": file too large. The spk format currently only "
            "supports files up to 512MB in size. Please let the Sandstorm developers know "
            "if you have a strong reason for needing larger files."));
        }

        auto content = orphanage.referenceExternalData(mapping);

        if (stats.st_mode & S_IXUSR) {
          builder.adoptExecutable(kj::mv(content));

          if (target.endsWith("/mongod") || target == "mongod") {
            context.warning(
              "** WARNING: It looks like your app uses MongoDB. PLEASE verify that the size\n"
              "**   of a typical instance of your app is reasonable before you distribute\n"
              "**   it. App instance storage is found in:\n"
              "**     $SANDSORM_HOME/var/sandstorm/grains/$GRAIN_ID\n"
              "**   Mongo likes to pre-allocate lots of space, while Sandstorm grains\n"
              "**   should be small, which can lead to waste. Please consider using\n"
              "**   Kenton's fork of Mongo that preallocates less data, found here:\n"
              "**     https://github.com/kentonv/mongo/tree/niscu\n"
              "**   This warning will disappear if the name of the binary on your disk is\n"
              "**   something other than \"mongod\" -- you can still map it to the name\n"
              "**   \"mongod\" inside your package, e.g. with a mapping like:\n"
              "**     (packagePath=\"usr/bin/mongod\", sourcePath=\"niscud\")");
          }
        } else {
          builder.adoptRegular(kj::mv(content));
        }
      } else if (S_ISLNK(stats.st_mode)) {
        KJ_ASSERT(children.empty(), "got symlink, expected directory", target);

        auto symlink = builder.initSymlink(stats.st_size);

        ssize_t linkSize;
        KJ_SYSCALL(linkSize = readlink(target.cStr(), symlink.begin(), stats.st_size), target);
      } else if (S_ISDIR(stats.st_mode)) {
        builder.adoptDirectory(packChildren(orphanage, context, defaultMTime));
      } else {
        context.warning(kj::str("Cannot pack irregular file: ", target));
        builder.initRegular(0);
      }
    }

    capnp::Orphan<capnp::List<spk::Archive::File>> packChildren(
        capnp::Orphanage orphanage, kj::ProcessContext& context, struct timespec defaultMTime) {
      auto orphan = orphanage.newOrphan<capnp::List<spk::Archive::File>>(children.size());
      auto builder = orphan.get();

      uint i = 0;
      for (auto& child: children) {
        auto childBuilder = builder[i++];
        childBuilder.setName(child.first);
        child.second.pack(childBuilder, context, defaultMTime);
      }

      return orphan;
    }

  private:
    kj::String target;
    // The disk path which should be used to initialize this node.

    std::map<kj::String, ArchiveNode> children;
    // Contents of this node if it is a directory.

    MemoryMapping mapping;
    // May be initialized during pack().

    kj::Maybe<kj::Array<capnp::word>> data;
    // Raw data comprising this node. Mutually exclusive with all other members.
  };

  bool isHttpBridgeCommand(spk::Manifest::Command::Reader command) {
    // Hacky heuristic to decide if the package uses sandstorm-http-bridge.
    auto argv = command.getArgv();
    if (argv.size() == 0) return false;

    auto exe = argv[0];

    return exe == "/sandstorm-http-bridge" ||
           exe == "./sandstorm-http-bridge" ||
           exe == "sandstorm-http-bridge";
  }

  void addNode(ArchiveNode& root, kj::StringPtr path, const spk::SourceMap::Reader& sourceMap,
               bool recursive) {
    if (path.startsWith("/")) {
      context.exitError(kj::str("Destination (in-package) path must not start with '/': ", path));
    }
    if (path == ".") {
      path = "";
    }

    auto& node = root.followPath(path);
    if (path == "sandstorm-manifest") {
      // Serialize the manifest.
      auto manifestReader = packageDef.getManifest();
      capnp::MallocMessageBuilder manifestMessage(manifestReader.totalSize().wordCount + 4);
      manifestMessage.setRoot(manifestReader);
      node.setData(capnp::messageToFlatArray(manifestMessage));
    } else if (path == "sandstorm-http-bridge-config") {
      // Serialize the bridgeConfig.
      auto bridgeConfigReader = packageDef.getBridgeConfig();
      capnp::MallocMessageBuilder bridgeConfigMessage(bridgeConfigReader.totalSize().wordCount + 4);
      bridgeConfigMessage.setRoot(bridgeConfigReader);
      node.setData(capnp::messageToFlatArray(bridgeConfigMessage));
    } else if (path == "sandstorm-http-bridge") {
      node.setTarget(getHttpBridgeExe());
    } else {
      if (path.size() == 0 && recursive) {
        addNode(root, "sandstorm-manifest", sourceMap, true);
        if (packageDef.hasBridgeConfig() ||
            isHttpBridgeCommand(packageDef.getManifest().getContinueCommand())) {
          addNode(root, "sandstorm-http-bridge-config", sourceMap, true);
          addNode(root, "sandstorm-http-bridge", sourceMap, true);
        }
      }

      auto mapping = mapFile(sourceDir, sourceMap, path);
      if (mapping.sourcePaths.size() == 0 && mapping.virtualChildren.size() == 0) {
        context.exitError(kj::str("No file found to satisfy requirement: ", path));
      } else {
        initNode(node, path, kj::mv(mapping), sourceMap, recursive);
      }
    }
  }

  void initNode(ArchiveNode& node, kj::StringPtr srcPath, FileMapping&& mapping,
                const spk::SourceMap::Reader& sourceMap, bool recursive) {
    if (mapping.sourcePaths.size() == 0 && mapping.virtualChildren.size() == 0) {
      // Nothing here.
      return;
    }

    if (recursive && (mapping.sourcePaths.size() == 0 || isDirectory(mapping.sourcePaths[0]))) {
      // Primary match is a directory, so merge all of the matching directories.
      std::set<kj::String> seen;
      for (auto& child: mapping.virtualChildren) {
        seen.insert(kj::mv(child));
      }
      for (auto& target: mapping.sourcePaths) {
        if (isDirectory(target)) {
          // This is one of the directories to be merged. List it.
          for (auto& child: listDirectory(target)) {
            if (child != "." && child != "..") {
              seen.insert(kj::mv(child));
            }
          }
        }
      }

      for (auto& child: seen) {
        // Note that this child node could be hidden. We need to use mapFile() on it directly
        // in order to make sure it maps to a real file.
        auto subPath = srcPath.size() == 0 ?
            kj::str(child) : kj::str(srcPath, '/', child);
        auto subMapping = mapFile(sourceDir, sourceMap, subPath);
        initNode(node.followPath(child), subPath, kj::mv(subMapping), sourceMap,
                 recursive);
      }
    }

    node.setTarget(kj::mv(mapping.sourcePaths[0]));
  }

  kj::String getHttpBridgeExe() {
    KJ_IF_MAYBE(slashPos, exePath.findLast('/')) {
      return kj::str(exePath.slice(0, *slashPos), "/sandstorm-http-bridge");
    } else {
      return kj::heapString("/sandstorm-http-bridge");
    }
  }

  // =====================================================================================

  kj::String dirname;

  kj::MainFunc getUnpackMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Check that <spkfile>'s signature is valid.  If so, unpack it to <outdir> and "
            "print the app ID and filename.  If <outdir> is not specified, it will be "
            "chosen by removing the suffix \".spk\" from the input file name.")
        .expectArg("<spkfile>", KJ_BIND_METHOD(*this, setUnpackSpkfile))
        .expectOptionalArg("<outdir>", KJ_BIND_METHOD(*this, setUnpackDirname))
        .callAfterParsing(KJ_BIND_METHOD(*this, doUnpack))
        .build();
  }

  kj::MainBuilder::Validity setUnpackSpkfile(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) < 0) {
      return "Not found.";
    }

    spkfile = kj::heapString(name);
    if (spkfile.endsWith(".spk")) {
      dirname = kj::heapString(spkfile.slice(0, spkfile.size() - 4));
    }

    return true;
  }

  kj::MainBuilder::Validity setUnpackDirname(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) == 0) {
      return "Already exists.";
    }

    dirname = kj::heapString(name);
    return true;
  }

  kj::MainBuilder::Validity validationError(kj::StringPtr filename, kj::StringPtr problem) {
    context.exitError(kj::str("*** ", filename, ": ", problem));
  }

  kj::MainBuilder::Validity doUnpack() {
    if (access(dirname.cStr(), F_OK) == 0) {
      return "Output directory already exists.";
    }

    byte publicKey[crypto_sign_PUBLICKEYBYTES];
    byte sigBytes[crypto_hash_BYTES + crypto_sign_BYTES];
    byte expectedHash[sizeof(sigBytes)];
    unsigned long long hashLength = 0;  // will be overwritten later

    auto tmpfile = openTemporary(spkfile);

    // Read the spk, checking the magic number, reading the signature header, and decompressing the
    // archive to a temp file.
    {
      // Open the spk.
      auto spkfd = raiiOpen(spkfile, O_RDONLY);

      // TODO(security):  We could at this point chroot into the output directory and unshare
      //   various resources for extra security, if not for the fact that we need to invoke xz
      //   later on.  Maybe link against the xz library so that we don't have to exec it?

      // Check the magic number.
      auto expectedMagic = spk::MAGIC_NUMBER.get();
      byte magic[expectedMagic.size()];
      kj::FdInputStream(spkfd.get()).read(magic, expectedMagic.size());
      for (uint i: kj::indices(expectedMagic)) {
        if (magic[i] != expectedMagic[i]) {
          return validationError(spkfile, "Does not appear to be an .spk (bad magic number).");
        }
      }

      // Decompress the remaining bytes in the SPK using xz.
      auto child = kj::heap<ChildProcess>("xz", "-dc", kj::mv(spkfd), ChildProcess::INPUT);
      kj::FdInputStream in(child->getPipe());

      // Read in the signature.
      {
        // TODO(security): Set a small limit on signature size?
        capnp::InputStreamMessageReader signatureMessage(in);
        auto signature = signatureMessage.getRoot<spk::Signature>();
        auto pkReader = signature.getPublicKey();
        if (pkReader.size() != sizeof(publicKey)) {
          return validationError(spkfile, "Invalid public key.");
        }
        memcpy(publicKey, pkReader.begin(), sizeof(publicKey));
        auto sigReader = signature.getSignature();
        if (sigReader.size() != sizeof(sigBytes)) {
          return validationError(spkfile, "Invalid signature format.");
        }
        memcpy(sigBytes, sigReader.begin(), sizeof(sigBytes));
      }

      // Verify the signature.
      int result = crypto_sign_open(
          expectedHash, &hashLength, sigBytes, sizeof(sigBytes), publicKey);
      if (result != 0) {
        return validationError(spkfile, "Invalid signature.");
      }
      if (hashLength != crypto_hash_BYTES) {
        return validationError(spkfile, "Wrong signature size.");
      }

      // Copy archive part to a temp file.
      kj::FdOutputStream tmpOut(tmpfile.get());
      uint64_t totalRead = 0;
      for (;;) {
        byte buffer[8192];
        size_t n = in.tryRead(buffer, 1, sizeof(buffer));
        if (n == 0) break;
        totalRead += n;
        KJ_REQUIRE(totalRead <= APP_SIZE_LIMIT, "App too big after decompress.");
        tmpOut.write(buffer, n);
      }
    }

    // mmap the temp file.
    MemoryMapping tmpMapping(tmpfile, "(temp file)");
    tmpfile = nullptr;  // We have the mapping now; don't need the fd.

    // Hash the archive.
    kj::ArrayPtr<const byte> tmpBytes = tmpMapping;
    byte hash[crypto_hash_BYTES];
    crypto_hash(hash, tmpBytes.begin(), tmpBytes.size());

    // Check that hashes match.
    if (memcmp(expectedHash, hash, crypto_hash_BYTES) != 0) {
      return validationError(spkfile, "Signature didn't match package contents.");
    }

    // Set up archive reader.
    kj::ArrayPtr<const capnp::word> tmpWords = tmpMapping;
    capnp::ReaderOptions options;
    options.traversalLimitInWords = tmpWords.size();
    capnp::FlatArrayMessageReader archiveMessage(tmpWords, options);

    // Unpack.
    KJ_SYSCALL(mkdir(dirname.cStr(), 0777), dirname);
    unpackDir(archiveMessage.getRoot<spk::Archive>().getFiles(), dirname);

    // Note the appid.
    printAppId(publicKey);

    return true;
  }

  void unpackDir(capnp::List<spk::Archive::File>::Reader files, kj::StringPtr dirname) {
    std::set<kj::StringPtr> seen;

    for (auto file: files) {
      kj::StringPtr name = file.getName();
      KJ_REQUIRE(name.size() != 0 && name != "." && name != ".." &&
                 name.findFirst('/') == nullptr && name.findFirst('\0') == nullptr,
                 "Archive contained invalid file name.", name);

      KJ_REQUIRE(seen.insert(name).second, "Archive contained duplicate file name.", name);

      auto path = kj::str(dirname, '/', name);

      KJ_ASSERT(access(path.cStr(), F_OK) != 0, "Unpacked file already exists.", path);

      switch (file.which()) {
        case spk::Archive::File::REGULAR: {
          auto bytes = file.getRegular();
          kj::FdOutputStream(raiiOpen(path, O_WRONLY | O_CREAT | O_EXCL, 0666))
              .write(bytes.begin(), bytes.size());
          break;
        }

        case spk::Archive::File::EXECUTABLE: {
          auto bytes = file.getExecutable();
          kj::FdOutputStream(raiiOpen(path, O_WRONLY | O_CREAT | O_EXCL, 0777))
              .write(bytes.begin(), bytes.size());
          break;
        }

        case spk::Archive::File::SYMLINK: {
          KJ_SYSCALL(symlink(file.getSymlink().cStr(), path.cStr()), path);
          break;
        }

        case spk::Archive::File::DIRECTORY: {
          KJ_SYSCALL(mkdir(path.cStr(), 0777), path);
          unpackDir(file.getDirectory(), path);
          break;
        }

        default:
          KJ_FAIL_REQUIRE("Unknown file type in archive.");
      }

      struct timespec times[2];
      auto ns = file.getLastModificationTimeNs();
      times[0].tv_sec = ns / 1000000000ll;
      times[0].tv_nsec = ns % 1000000000ll;
      if (times[0].tv_nsec < 0) {
        // C division rounds towards zero. :(
        ++times[0].tv_sec;
        times[0].tv_nsec += 1000000000ll;
      }
      times[1] = times[0];  // Also use mtime as atime.
      KJ_SYSCALL(utimensat(AT_FDCWD, path.cStr(), times, AT_SYMLINK_NOFOLLOW));
    }
  }

  // =====================================================================================
  // "dev" command

  kj::String serverBinary;
  kj::StringPtr mountDir;

  kj::MainFunc getDevMain() {
    return addCommonOptions(OptionSet::ALL_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Register an under-development app with a local Sandstorm server for testing "
            "purposes, and optionally output a list of all files it depends on. While this "
            "command is running, the app will replace the current package for the app's ID "
            "installed on the server. Note that you do not need the private key corresponding "
            "to the app ID for this, so that the key need not be distributed to all developers. "
            "Your user account must be a member of the server's group, typically \"sandstorm\".")
        .addOptionWithArg({'s', "server"}, KJ_BIND_METHOD(*this, setServerDir), "<dir>",
            "Connect to the Sandstorm server installed in <dir>. Default is to detect based on "
            "the location of the spk executable or, failing that, the location pointed to by "
            "the intsalled init script.")
        .addOptionWithArg({'m', "mount"}, KJ_BIND_METHOD(*this, setMountDir), "<dir>",
            "Don't actually connect to the server. Mount the package at <dir>, so you can poke "
            "at it.")
        .callAfterParsing(KJ_BIND_METHOD(*this, doDev)))
        .build();
  }

  kj::MainBuilder::Validity setServerDir(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) != 0) {
      return "not found";
    }
    serverBinary = kj::str(name, "/sandstorm");
    return true;
  }

  kj::MainBuilder::Validity setMountDir(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) != 0) {
      return "not found";
    }
    mountDir = name;
    return true;
  }

  kj::MainBuilder::Validity addImportPath(kj::StringPtr arg) {
    importPath.add(kj::heapString(arg));
    return true;
  }

  kj::MainBuilder::Validity doDev() {
    ensurePackageDefParsed();

    if (serverBinary == nullptr) {
      // Try to find the server. First try looking where `spk` is installed.
      KJ_IF_MAYBE(i, installHome) {
        auto candidate = kj::str(*i, "/sandstorm");
        if (access(candidate.cStr(), F_OK) == 0) {
          struct stat stats;
          KJ_SYSCALL(stat(candidate.cStr(), &stats));
          if (S_ISREG(stats.st_mode) && stats.st_mode & S_IXUSR) {
            // Indeed!
            serverBinary = kj::mv(candidate);
          }
        }
      }

      if (serverBinary == nullptr) {
        // Try checking for an init script.
        kj::StringPtr candidate = "/etc/init.d/sandstorm";
        if (access(candidate.cStr(), F_OK) == 0) {
          serverBinary = kj::str(candidate);
        }
      }

      if (serverBinary == nullptr) {
        return "Couldn't find Sandstorm server installation. Please use -s to specify it.";
      }
    }

    kj::AutoCloseFd fuseFd;
    kj::Maybe<kj::AutoCloseFd> connection;
    kj::Maybe<kj::Own<FuseMount>> fuseMount;

    if (mountDir == nullptr) {
      // call "sandstorm dev"

      // Create a unix socket over which to receive the fuse FD.
      int serverSocket[2];
      KJ_SYSCALL(socketpair(AF_UNIX, SOCK_STREAM | SOCK_CLOEXEC, 0, serverSocket));
      kj::AutoCloseFd clientEnd(serverSocket[0]);
      kj::AutoCloseFd serverEnd(serverSocket[1]);

      // Run "sandstorm dev".
      pid_t sandstormPid = fork();
      if (sandstormPid == 0) {
        dup2(serverEnd, STDIN_FILENO);
        dup2(serverEnd, STDOUT_FILENO);

        KJ_SYSCALL(execl(serverBinary.cStr(), serverBinary.cStr(), "dev", (char*)nullptr),
                   serverBinary);
        KJ_UNREACHABLE;
      }

      serverEnd = nullptr;

      // Write the app ID to the socket.
      {
        auto msg = kj::str(packageDef.getId(), "\n");
        kj::FdOutputStream((int)clientEnd).write(msg.begin(), msg.size());
      }

      // The server connection starts by sending us the FUSE FD.
      fuseFd = receiveFd(clientEnd, [](kj::ArrayPtr<const kj::byte> bytes) {
        // Got some data. Pipe it to stdout.
        kj::FdOutputStream(STDOUT_FILENO).write(bytes.begin(), bytes.size());
      });

      // Switch connection to async I/O.
      {
        int flags;
        KJ_SYSCALL(flags = fcntl(clientEnd, F_GETFL));
        if ((flags & O_NONBLOCK) == 0) {
          KJ_SYSCALL(fcntl(clientEnd, F_SETFL, flags | O_NONBLOCK));
        }
      }

      connection = kj::mv(clientEnd);
    } else {
      // Just mount directly.

      auto mount = kj::heap<FuseMount>(mountDir, "");
      fuseFd = mount->disownFd();
      fuseMount = kj::mv(mount);
    }

    std::set<kj::String> usedFiles;

    {
      kj::UnixEventPort::captureSignal(SIGINT);
      kj::UnixEventPort::captureSignal(SIGQUIT);
      kj::UnixEventPort::captureSignal(SIGTERM);
      kj::UnixEventPort::captureSignal(SIGHUP);

      kj::UnixEventPort eventPort;
      kj::EventLoop eventLoop(eventPort);
      kj::WaitScope waitScope(eventLoop);

      kj::Function<void(kj::StringPtr)> callback = [&](kj::StringPtr path) {
        usedFiles.insert(kj::heapString(path));
      };
      auto rootNode = makeUnionFs(sourceDir, packageDef.getSourceMap(), packageDef.getManifest(),
                                  packageDef.getBridgeConfig(), getHttpBridgeExe(), callback);

      FuseOptions options;

      // Caching improves performance significantly... but the ability to update code and see those
      // updates live without restarting seems more important for this use case.
      // TODO(perf): Implement active cache invalidation. FUSE has protocol support for it. Use
      //   inotify at the other end to detect changes.
//      options.cacheForever = true;

      auto onSignal = eventPort.onSignal(SIGINT)
          .exclusiveJoin(eventPort.onSignal(SIGQUIT))
          .exclusiveJoin(eventPort.onSignal(SIGTERM))
          .exclusiveJoin(eventPort.onSignal(SIGHUP))
          .then([&](siginfo_t&& sig) {
        context.warning(kj::str("Requesting shutdown due to signal: ", strsignal(sig.si_signo)));

        KJ_IF_MAYBE(c, connection) {
          // Close pipe to request unmount.
          KJ_SYSCALL(shutdown(*c, SHUT_WR));
        }
        fuseMount = nullptr;

        return eventPort.onSignal(SIGINT)
            .exclusiveJoin(eventPort.onSignal(SIGQUIT))
            .exclusiveJoin(eventPort.onSignal(SIGTERM))
            .exclusiveJoin(eventPort.onSignal(SIGHUP))
            .then([&](siginfo_t&& sig) {
          context.exitError("Received second signal. Aborting. You may want to restart Sandstorm.");
        });
      }).eagerlyEvaluate(nullptr);

      kj::Maybe<kj::Promise<void>> logPipe;
      KJ_IF_MAYBE(c, connection) {
        logPipe = pipeToStdout(eventPort, *c).eagerlyEvaluate(nullptr);
      }

      if (connection == nullptr) {
        context.warning("App mounted. Ctrl+C to disconnect.");
      } else {
        context.warning("App is now available from Sandstorm server. Ctrl+C to disconnect.");
      }

      bindFuse(eventPort, fuseFd, rootNode, options)
          .then([&]() {
            context.warning("Unmounted cleanly.");
            KJ_IF_MAYBE(m, fuseMount) {
              m->get()->dontUnmount();
            }
          })
          .wait(waitScope);

      KJ_IF_MAYBE(p, logPipe) {
        p->wait(waitScope);
      }
    }

    // OK, we're done running. Output the file list.
    if (packageDef.hasFileList()) {
      context.warning("Updating file list.");

      // Merge with the existing file list.
      auto path = packageDef.getFileList();
      if (access(path.cStr(), F_OK) == 0) {
        auto fileList = raiiOpen(packageDef.getFileList(), O_RDONLY);
        for (auto& line: splitLines(readAll(fileList))) {
          usedFiles.insert(kj::mv(line));
        }
      }

      // Now write back out.
      ReplacementFile newFileList(path);
      auto content = kj::str(
          "# *** WARNING: GENERATED FILE ***\n"
          "# This file is automatically updated and rewritten in sorted order every time\n"
          "# the app runs in dev mode. You may manually add or remove files, but don't\n"
          "# expect comments or ordering to be retained.\n",
          kj::StringTree(KJ_MAP(file, usedFiles) { return kj::strTree(file); }, "\n"),
          "\n");
      kj::FdOutputStream(newFileList.getFd()).write(content.begin(), content.size());
      newFileList.commit();
    } else {
      // If alwaysInclude contains "." then the user doesn't care about the used files list, so
      // don't print in that case.
      bool includeAll = false;
      for (auto alwaysInclude: packageDef.getAlwaysInclude()) {
        if (alwaysInclude == ".") {
          includeAll = true;
          break;
        }
      }

      if (!includeAll) {
        context.warning(
            "Your program used the following files. (If you would specify `fileList` in \n"
            "the package definition, I could write the list there.)\n\n");
        auto msg = kj::str(
            kj::StringTree(KJ_MAP(file, usedFiles) { return kj::strTree(file); }, "\n"), "\n");
        kj::FdOutputStream(STDOUT_FILENO).write(msg.begin(), msg.size());
      }
    }

    return true;
  }

  static kj::Promise<void> pipeToStdout(kj::UnixEventPort& eventPort, int fd) {
    // Asynchronously read all data from fd and write it to STDOUT.
    // TODO(cleanup): Use KJ I/O facilities. Requires making it possible to construct
    //   kj::LowLevelAsyncIoProvider directly from UnixEventPort.

    for (;;) {
      ssize_t n;
      char buffer[1024];
      KJ_NONBLOCKING_SYSCALL(n = read(fd, buffer, sizeof(buffer)));

      if (n < 0) {
        // Got EAGAIN.
        return eventPort.onFdEvent(fd, POLLIN).then([&eventPort, fd](short) {
          return pipeToStdout(eventPort, fd);
        });
      } else if (n == 0) {
        return kj::READY_NOW;
      }

      kj::FdOutputStream(STDOUT_FILENO).write(buffer, n);
    }
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::SpkTool)
