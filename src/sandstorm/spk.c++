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

#include "spk.h"
#include <kj/debug.h>
#include <kj/io.h>
#include <kj/encoding.h>
#include <capnp/serialize.h>
#include <capnp/serialize-packed.h>
#include <capnp/compat/json.h>
#include <sodium/crypto_sign.h>
#include <sodium/crypto_hash_sha256.h>
#include <sodium/crypto_hash_sha512.h>
#include <unistd.h>
#include <fcntl.h>
#include <stdio.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/mman.h>
#include <errno.h>
#include <sandstorm/package.capnp.h>
#include <sandstorm/appid-replacements.capnp.h>
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
#include <poll.h>
#include <sandstorm/app-index/submit.capnp.h>
#include <sodium/crypto_generichash_blake2b.h>

#include "version.h"
#include "fuse.h"
#include "union-fs.h"
#include "send-fd.h"
#include "util.h"
#include "id-to-text.h"
#include "appid-replacements.h"

namespace sandstorm {

typedef kj::byte byte;

static const uint64_t APP_SIZE_LIMIT = 1ull << 30;
// For now, we will refuse to unpack an app over 1 GB (decompressed size).

static const uint32_t MAX_DEFINED_APIVERSION = 0;
// The maximum API version that has been defined, as of this source code's compilation.  We should
// outright refuse to pack an app claiming compatibility with a newer API version than this, because
// we can't possibly know what the constraints are on that API.

// =======================================================================================
// JSON handlers for very large data or text blobs, which we don't want to print along with
// `spk verify`. Also base64's data blobs (if they are small enough).

class OversizeDataHandler: public capnp::JsonCodec::Handler<capnp::Data> {
public:
  void encode(const capnp::JsonCodec& codec, capnp::Data::Reader input,
              capnp::JsonValue::Builder output) const override {
    if (input.size() > 256) {
      auto call = output.initCall();
      call.setFunction("LargeDataBlob");
      call.initParams(1)[0].setNumber(input.size());
    } else {
      auto call = output.initCall();
      call.setFunction("Base64");
      call.initParams(1)[0].setString(kj::encodeBase64(input, false));
    }
  }

  capnp::Orphan<capnp::Data> decode(
      const capnp::JsonCodec& codec, capnp::JsonValue::Reader input,
      capnp::Orphanage orphanage) const override {
    KJ_UNIMPLEMENTED("OversizeDataHandler::decode");
  }
};

class OversizeTextHandler: public capnp::JsonCodec::Handler<capnp::Text> {
public:
  void encode(const capnp::JsonCodec& codec, capnp::Text::Reader input,
              capnp::JsonValue::Builder output) const override {
    if (input.size() > 256) {
      auto call = output.initCall();
      call.setFunction("LargeTextBlob");
      call.initParams(1)[0].setNumber(input.size());
    } else {
      output.setString(input);
    }
  }

  capnp::Orphan<capnp::Text> decode(
      const capnp::JsonCodec& codec, capnp::JsonValue::Reader input,
      capnp::Orphanage orphanage) const override {
    KJ_UNIMPLEMENTED("OversizeTextHandler::decode");
  }
};

// =======================================================================================

class ReplacementFile {
  // Encapsulates writing a file to a temporary location and then using it to atomically
  // replace some existing file.

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

class SpkTool: public AbstractMain {
  // Main class for the Sandstorm spk tool.

public:
  SpkTool(kj::ProcessContext& context): context(context) {
    char buf[PATH_MAX + 1];
    ssize_t n;
    KJ_SYSCALL(n = readlink("/proc/self/exe", buf, sizeof(buf)));
    buf[n] = '\0';
    exePath = kj::heapString(buf, n);
    if (exePath.endsWith("/sandstorm")) {
      installHome = kj::heapString(buf, n - strlen("/sandstorm"));
    } else if (exePath.endsWith("/bin/spk")) {
      installHome = kj::heapString(buf, n - strlen("/bin/spk"));
    }
  }

  kj::MainFunc getMain() override {
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
        .addSubCommand("verify", KJ_BIND_METHOD(*this, getVerifyMain),
                       "Verify signature on an spk and output the app ID (without unpacking).")
        .addSubCommand("dev", KJ_BIND_METHOD(*this, getDevMain),
                       "Run an app in dev mode.")
        .addSubCommand("publish", KJ_BIND_METHOD(*this, getPublishMain),
                       "Publish a package to the app market."))
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
        sawPkgDef = true;

        auto manifest = packageDef.getManifest();
        if (!manifest.hasAppTitle()) {
          return kj::str("missing `appTitle`\n"
                         "Under ", constantName, ".manifest, add something like ",
                         "`appTitle = (defaultText = \"My App\")`.");
        }

        if (!manifest.hasAppMarketingVersion()) {
          return kj::str("missing `appMarketingVersion`\n"
                         "Under ", constantName, ".manifest, add something like ",
                         "`appMarketingVersion = (defaultText = \"0.0.0\")`.");
        }

        if (manifest.getMinApiVersion() > MAX_DEFINED_APIVERSION) {
          return kj::str("The minimum API version this app claims it can run on is ",
                         manifest.getMinApiVersion(), ", but the maximum API version "
                         "known to this version of spk is ", MAX_DEFINED_APIVERSION, ".\n"
                         "Please upgrade sandstorm to the latest version to pack this app.");
        }

        if (manifest.getMaxApiVersion() > MAX_DEFINED_APIVERSION) {
          return kj::str("The maximum API version this app claims it can run on is ",
                         manifest.getMaxApiVersion(), ", but the maximum API version known "
                         "to this version of spk is ", MAX_DEFINED_APIVERSION, ".\n"
                         "Please upgrade sandstorm to the latest version.");
        }

        if (manifest.getMinApiVersion() > manifest.getMaxApiVersion()) {
          return kj::str("Your manifest specifies a maxApiVersion of ", manifest.getMaxApiVersion(),
                         " which is less than its minApiVersion of ", manifest.getMinApiVersion(),
                         ".\nPlease correct this.");
        }

        if (manifest.totalSize().wordCount > spk::Manifest::SIZE_LIMIT_IN_WORDS) {
          return kj::str(
              "Your app metadata is too large. Metadata must be less than 8MB in total -- "
              "including icons, screenshots, licenses, etc. -- and should be much smaller than "
              "that in order to ensure an acceptable experience for users browsing the app store "
              "on slow connections.");
        }

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

    printAppId(appIdString(publicKey));
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

  spk::KeyFile::Reader lookupKey(kj::StringPtr appid, bool withReplacements = true) {
    // We actually want to sign packages using the current replacement key for the app ID.
    byte appidBytes[APP_ID_BYTE_SIZE];
    KJ_REQUIRE(tryParseAppId(appid, appidBytes), "invalid appid", appid);
    auto replacement = appIdString(getPublicKeyForApp(appidBytes));
    if (withReplacements) {
      appid = replacement;
    } else {
      if (appid != replacement) {
        KJ_LOG(WARNING, "the requested key is obsolete", appid, replacement);
      }
    }

    if (keyringMapping == nullptr) {
      auto mapping = kj::heap<MemoryMapping>(openKeyring(O_RDONLY), "(keyring)");
      kj::ArrayPtr<const capnp::word> words = *mapping;
      keyringMapping = kj::mv(mapping);

      while (words.size() > 0) {
        auto reader = kj::heap<capnp::FlatArrayMessageReader>(words);
        auto key = reader->getRoot<spk::KeyFile>();
        words = kj::arrayPtr(reader->getEnd(), words.end());
        keyMap.insert(std::make_pair(appIdString(key.getPublicKey()), kj::mv(reader)));
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

    return appIdString(builder.getPublicKey());
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

    auto key = lookupKey(appid, false);  // Don't get a replacement; get the original.
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
          "        hidePaths = [ \"home\", \"proc\", \"sys\",\n"
          "                      \"etc/passwd\", \"etc/hosts\", \"etc/host.conf\",\n"
          "                      \"etc/nsswitch.conf\", \"etc/resolv.conf\" ]\n"
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
        "    appTitle = (defaultText = \"Example App\"),\n"
        "\n"
        "    appVersion = 0,  # Increment this for every release.\n"
        "\n"
        "    appMarketingVersion = (defaultText = \"0.0.0\"),\n"
        "    # Human-readable representation of appVersion. Should match the way you\n"
        "    # identify versions of your app in documentation and marketing.\n"
        "\n"
        "    actions = [\n"
        "      # Define your \"new document\" handlers here.\n"
        "      ( nounPhrase = (defaultText = \"instance\"),\n"
        "        command = .myCommand\n"
        "        # The command to run when starting for the first time. (\".myCommand\"\n"
        "        # is just a constant defined at the bottom of the file.)\n"
        "      )\n"
        "    ],\n"
        "\n"
        "    continueCommand = .myCommand,\n"
        "    # This is the command called to start your app back up after it has been\n"
        "    # shut down for inactivity. Here we're using the same command as for\n"
        "    # starting a new instance, but you could use different commands for each\n"
        "    # case.\n"
        "\n"
        "    metadata = (\n"
        "      # Data which is not needed specifically to execute the app, but is useful\n"
        "      # for purposes like marketing and display.  These fields are documented at\n"
        "      # https://docs.sandstorm.io/en/latest/developing/publishing-apps/#add-required-metadata\n"
        "      # and (in deeper detail) in the sandstorm source code, in the Metadata section of\n"
        "      # https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/package.capnp\n"
        "      icons = (\n"
        "        # Various icons to represent the app in various contexts.\n"
        "        #appGrid = (svg = embed \"path/to/appgrid-128x128.svg\"),\n"
        "        #grain = (svg = embed \"path/to/grain-24x24.svg\"),\n"
        "        #market = (svg = embed \"path/to/market-150x150.svg\"),\n"
        "        #marketBig = (svg = embed \"path/to/market-big-300x300.svg\"),\n"
        "      ),\n"
        "\n"
        "      website = \"http://example.com\",\n"
        "      # This should be the app's main website url.\n"
        "\n"
        "      codeUrl = \"http://example.com\",\n"
        "      # URL of the app's source code repository, e.g. a GitHub URL.\n"
        "      # Required if you specify a license requiring redistributing code, but optional otherwise.\n"
        "\n"
        "      license = (none = void),\n"
        "      # The license this package is distributed under.  See\n"
        "      # https://docs.sandstorm.io/en/latest/developing/publishing-apps/#license\n"
        "\n"
        "      categories = [],\n"
        "      # A list of categories/genres to which this app belongs, sorted with best fit first.\n"
        "      # See the list of categories at\n"
        "      # https://docs.sandstorm.io/en/latest/developing/publishing-apps/#categories\n"
        "\n"
        "      author = (\n"
        "        # Fields relating to the author of this app.\n"
        "\n"
        "        contactEmail = \"youremail@example.com\",\n"
        "        # Email address to contact for any issues with this app. This includes end-user support\n"
        "        # requests as well as app store administrator requests, so it is very important that this be a\n"
        "        # valid address with someone paying attention to it.\n"
        "\n"
        "        #pgpSignature = embed \"path/to/pgp-signature\",\n"
        "        # PGP signature attesting responsibility for the app ID. This is a binary-format detached\n"
        "        # signature of the following ASCII message (not including the quotes, no newlines, and\n"
        "        # replacing <app-id> with the standard base-32 text format of the app's ID):\n"
        "        #\n"
        "        # \"I am the author of the Sandstorm.io app with the following ID: <app-id>\"\n"
        "        #\n"
        "        # You can create a signature file using `gpg` like so:\n"
        "        #\n"
        "        #     echo -n \"I am the author of the Sandstorm.io app with the following ID: <app-id>\" | gpg --sign > pgp-signature\n"
        "        #\n"
        "        # Further details including how to set up GPG and how to use keybase.io can be found\n"
        "        # at https://docs.sandstorm.io/en/latest/developing/publishing-apps/#verify-your-identity\n"
        "\n"
        "        upstreamAuthor = \"Example App Team\",\n"
        "        # Name of the original primary author of this app, if it is different from the person who\n"
        "        # produced the Sandstorm package. Setting this implies that the author connected to the PGP\n"
        "        # signature only \"packaged\" the app for Sandstorm, rather than developing the app.\n"
        "        # Remove this line if you consider yourself as the author of the app.\n"
        "      ),\n"
        "\n"
        "      #pgpKeyring = embed \"path/to/pgp-keyring\",\n"
        "      # A keyring in GPG keyring format containing all public keys needed to verify PGP signatures in\n"
        "      # this manifest (as of this writing, there is only one: `author.pgpSignature`).\n"
        "      #\n"
        "      # To generate a keyring containing just your public key, do:\n"
        "      #\n"
        "      #     gpg --export <key-id> > keyring\n"
        "      #\n"
        "      # Where `<key-id>` is a PGP key ID or email address associated with the key.\n"
        "\n"
        "      #description = (defaultText = embed \"path/to/description.md\"),\n"
        "      # The app's description in Github-flavored Markdown format, to be displayed e.g.\n"
        "      # in an app store. Note that the Markdown is not permitted to contain HTML nor image tags (but\n"
        "      # you can include a list of screenshots separately).\n"
        "\n"
        "      shortDescription = (defaultText = \"one-to-three words\"),\n"
        "      # A very short (one-to-three words) description of what the app does. For example,\n"
        "      # \"Document editor\", or \"Notetaking\", or \"Email client\". This will be displayed under the app\n"
        "      # title in the grid view in the app market.\n"
        "\n"
        "      screenshots = [\n"
        "        # Screenshots to use for marketing purposes.  Examples below.\n"
        "        # Sizes are given in device-independent pixels, so if you took these\n"
        "        # screenshots on a Retina-style high DPI screen, divide each dimension by two.\n"
        "\n"
        "        #(width = 746, height = 795, jpeg = embed \"path/to/screenshot-1.jpeg\"),\n"
        "        #(width = 640, height = 480, png = embed \"path/to/screenshot-2.png\"),\n"
        "      ],\n"
        "      #changeLog = (defaultText = embed \"path/to/sandstorm-specific/changelog.md\"),\n"
        "      # Documents the history of changes in Github-flavored markdown format (with the same restrictions\n"
        "      # as govern `description`). We recommend formatting this with an H1 heading for each version\n"
        "      # followed by a bullet list of changes.\n"
        "    ),\n"
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
        ? "  alwaysInclude = [ \".\" ],\n"
          "  # This says that we always want to include all files from the source map.\n"
          "  # (An alternative is to automatically detect dependencies by watching what\n"
          "  # the app opens while running in dev mode. To see what that looks like,\n"
          "  # run `spk init` without the -A option.)\n"
        : "  fileList = \"sandstorm-files.list\",\n"
          "  # `spk dev` will write a list of all the files your app uses to this file.\n"
          "  # You should review it later, before shipping your app.\n"
          "\n"
          "  alwaysInclude = [],\n"
          "  # Fill this list with more names of files or directories that should be\n"
          "  # included in your package, even if not listed in sandstorm-files.list.\n"
          "  # Use this to force-include stuff that you know you need but which may\n"
          "  # not have been detected as a dependency during `spk dev`. If you list\n"
          "  # a directory here, its entire contents will be included recursively.\n",
          "\n"
          "  #bridgeConfig = (\n"
          "  #  # Used for integrating permissions and roles into the Sandstorm shell\n"
          "  #  # and for sandstorm-http-bridge to pass to your app.\n"
          "  #  # Uncomment this block and adjust the permissions and roles to make\n"
          "  #  # sense for your app.\n"
          "  #  # For more information, see high-level documentation at\n"
          "  #  # https://docs.sandstorm.io/en/latest/developing/auth/\n"
          "  #  # and advanced details in the \"BridgeConfig\" section of\n"
          "  #  # https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/package.capnp\n"
          "  #  viewInfo = (\n"
          "  #    # For details on the viewInfo field, consult \"ViewInfo\" in\n"
          "  #    # https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp\n"
          "  #\n"
          "  #    permissions = [\n"
          "  #    # Permissions which a user may or may not possess.  A user's current\n"
          "  #    # permissions are passed to the app as a comma-separated list of `name`\n"
          "  #    # fields in the X-Sandstorm-Permissions header with each request.\n"
          "  #    #\n"
          "  #    # IMPORTANT: only ever append to this list!  Reordering or removing fields\n"
          "  #    # will change behavior and permissions for existing grains!  To deprecate a\n"
          "  #    # permission, or for more information, see \"PermissionDef\" in\n"
          "  #    # https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp\n"
          "  #      (\n"
          "  #        name = \"editor\",\n"
          "  #        # Name of the permission, used as an identifier for the permission in cases where string\n"
          "  #        # names are preferred.  Used in sandstorm-http-bridge's X-Sandstorm-Permissions HTTP header.\n"
          "  #\n"
          "  #        title = (defaultText = \"editor\"),\n"
          "  #        # Display name of the permission, e.g. to display in a checklist of permissions\n"
          "  #        # that may be assigned when sharing.\n"
          "  #\n"
          "  #        description = (defaultText = \"grants ability to modify data\"),\n"
          "  #        # Prose describing what this role means, suitable for a tool tip or similar help text.\n"
          "  #      ),\n"
          "  #    ],\n"
          "  #    roles = [\n"
          "  #      # Roles are logical collections of permissions.  For instance, your app may have\n"
          "  #      # a \"viewer\" role and an \"editor\" role\n"
          "  #      (\n"
          "  #        title = (defaultText = \"editor\"),\n"
          "  #        # Name of the role.  Shown in the Sandstorm UI to indicate which users have which roles.\n"
          "  #\n"
          "  #        permissions  = [true],\n"
          "  #        # An array indicating which permissions this role carries.\n"
          "  #        # It should be the same length as the permissions array in\n"
          "  #        # viewInfo, and the order of the lists must match.\n"
          "  #\n"
          "  #        verbPhrase = (defaultText = \"can make changes to the document\"),\n"
          "  #        # Brief explanatory text to show in the sharing UI indicating\n"
          "  #        # what a user assigned this role will be able to do with the grain.\n"
          "  #\n"
          "  #        description = (defaultText = \"editors may view all site data and change settings.\"),\n"
          "  #        # Prose describing what this role means, suitable for a tool tip or similar help text.\n"
          "  #      ),\n"
          "  #      (\n"
          "  #        title = (defaultText = \"viewer\"),\n"
          "  #        permissions  = [false],\n"
          "  #        verbPhrase = (defaultText = \"can view the document\"),\n"
          "  #        description = (defaultText = \"viewers may view what other users have written.\"),\n"
          "  #      ),\n"
          "  #    ],\n"
          "  #  ),\n"
          "  #  #apiPath = \"/api\",\n"
          "  #  # Apps can export an API to the world.  The API is to be used primarily by Javascript\n"
          "  #  # code and native apps, so it can't serve out regular HTML to browsers.  If a request\n"
          "  #  # comes in to your app's API, sandstorm-http-bridge will prefix the request's path with\n"
          "  #  # this string, if specified.\n"
          "  #),\n"
        ");\n"
        "\n"
        "const myCommand :Spk.Manifest.Command = (\n"
        "  # Here we define the command used to start up your server.\n"
        "  argv = [", argv, "],\n"
        "  environ = [\n"
        "    # Note that this defines the *entire* environment seen by your app.\n"
        "    (key = \"PATH\", value = \"/usr/local/bin:/usr/bin:/bin\"),\n"
        "    (key = \"SANDSTORM\", value = \"1\"),\n"
        "    # Export SANDSTORM=1 into the environment, so that apps running within Sandstorm\n"
        "    # can detect if $SANDSTORM=\"1\" at runtime, switching UI and/or backend to use\n"
        "    # the app's Sandstorm-specific integration code.\n"
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
    byte hash[crypto_hash_sha512_BYTES];
    crypto_hash_sha512(hash, tmpData.begin(), tmpData.size());

    // Generate the signature.
    capnp::MallocMessageBuilder signatureMessage;
    spk::Signature::Builder signature = signatureMessage.getRoot<spk::Signature>();
    signature.setPublicKey(key.getPublicKey());
    unsigned long long siglen = crypto_hash_sha512_BYTES + crypto_sign_BYTES;
    crypto_sign(signature.initSignature(siglen).begin(), &siglen,
                hash, sizeof(hash), key.getPrivateKey().begin());

    // Now write the whole thing out.
    {
      auto finalFile = raiiOpen(spkfile, O_WRONLY | O_CREAT | O_TRUNC);

      // Write magic number uncompressed.
      auto magic = spk::MAGIC_NUMBER.get();
      kj::FdOutputStream(finalFile.get()).write(magic.begin(), magic.size());

      // Pipe content through xz compressor.
      auto pipe = Pipe::make();
      Subprocess::Options childOptions({"xz", "--threads=0", "--compress", "--stdout"});
      childOptions.stdin = pipe.readEnd.get();
      childOptions.stdout = finalFile.get();
      Subprocess child(kj::mv(childOptions));
      pipe.readEnd = nullptr;

      // Write signature and archive out to the pipe, then close the pipe.
      {
        kj::FdOutputStream out(kj::mv(pipe.writeEnd));
        capnp::writeMessage(out, signatureMessage);
        out.write(tmpData.begin(), tmpData.size());
      }

      // Wait until xz is done compressing.
      child.waitForSuccess();
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

        kj::AutoCloseFd fd = raiiOpen(target, O_RDONLY);
        size_t size = getFileSize(fd, target);

        if (size >= (1ull << 29)) {
          context.exitError(kj::str(target, ": file too large. The spk format currently only "
            "supports files up to 512MB in size. Please let the Sandstorm developers know "
            "if you have a strong reason for needing larger files."));
        }

        // Reading the entirety of a file into memory can take up a sizable
        // chunk of RAM, so we'd prefer to not pay that cost if we don't need
        // it.
        //
        // MemoryMapping doesn't keep a copy in RAM, but it does keep an mmap()
        // to the file open until we clean up the whole arena, which can wind
        // up taking a lot of file table entries.  In particular, VirtualBox
        // shared folders cannot handle >4096 concurrent mmap()s of files from
        // the host.  So we have to be cautious using MemoryMapping for all files.
        //
        // It is generally the case that most files are small, but most of your
        // data is in large files.  This suggests the following heuristic as a
        // compromise: use MemoryMapping for files larger than 128k (specific
        // number adjustable) and read the whole file into memory for anything
        // smaller.  So we do that.
        if (size > 1ull << 17) {
          // File larger than 128k, mmap preferred
          mapping = MemoryMapping(kj::mv(fd), target);
          auto content = orphanage.referenceExternalData(mapping);
          if (stats.st_mode & S_IXUSR) {
            builder.adoptExecutable(kj::mv(content));
          } else {
            builder.adoptRegular(kj::mv(content));
          }
        } else {
          // Small file; direct read preferable.
          ::capnp::Data::Builder buf = nullptr;
          if (stats.st_mode & S_IXUSR) {
            buf = builder.initExecutable(size);
          } else {
            buf = builder.initRegular(size);
          }
          kj::FdInputStream stream(kj::mv(fd));
          stream.read(buf.begin(), size);
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
    } else if (path == "proc/cpuinfo") {
      // Empty /proc/cpuinfo will be overmounted by the supervisor.
      node.setData(nullptr);
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

    if (mapping.sourcePaths.size() > 0) {
      node.setTarget(kj::mv(mapping.sourcePaths[0]));
    }
  }

  kj::String getHttpBridgeExe() {
    KJ_IF_MAYBE(slashPos, exePath.findLast('/')) {
      return kj::str(exePath.slice(0, *slashPos), "/bin/sandstorm-http-bridge");
    } else {
      return kj::heapString("/bin/sandstorm-http-bridge");
    }
  }

  // =====================================================================================

  kj::String dirname;

  kj::MainFunc getUnpackMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Check that <spkfile>'s signature is valid.  If so, unpack it to <outdir> and "
            "print the app ID.  If <outdir> is not specified, it will be "
            "chosen by removing the suffix \".spk\" from the input file name.")
        .expectArg("<spkfile>", KJ_BIND_METHOD(*this, setUnpackSpkfile))
        .expectOptionalArg("<outdir>", KJ_BIND_METHOD(*this, setUnpackDirname))
        .callAfterParsing(KJ_BIND_METHOD(*this, doUnpack))
        .build();
  }

  kj::MainBuilder::Validity setUnpackSpkfile(kj::StringPtr name) {
    if (name != "-" && access(name.cStr(), F_OK) < 0) {
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

  [[noreturn]] void validationError(kj::StringPtr filename, kj::StringPtr problem) {
    context.exitError(kj::str("*** ", filename, ": ", problem));
  }

  kj::MainBuilder::Validity doUnpack() {
    if (dirname == nullptr) {
      return "must specify directory name when filename doesn't end with \".spk\"";
    }
    if (access(dirname.cStr(), F_OK) == 0) {
      return "output directory already exists";
    }
    KJ_SYSCALL(mkdir(dirname.cStr(), 0777), dirname);

    kj::AutoCloseFd ownFd;
    int spkfd;

    kj::StringPtr tmpNear;
    if (spkfile == "-") {
      spkfd = STDIN_FILENO;
      tmpNear = "/tmp/spk-unpack";
    } else {
      ownFd = raiiOpen(spkfile, O_RDONLY);
      spkfd = ownFd;
      tmpNear = spkfile;
    }

    printAppId(unpackImpl(spkfd, dirname, tmpNear,
        [&](kj::StringPtr problem) -> kj::String {
      rmdir(dirname.cStr());
      validationError(spkfile, problem);
    }));

    return true;
  }

  friend kj::String unpackSpk(int spkfd, kj::StringPtr outdir, kj::StringPtr tmpdir);
  friend void verifySpk(int spkfd, int tmpfile, spk::VerifiedInfo::Builder output);
  friend kj::Maybe<kj::String> checkPgpSignature(
      kj::StringPtr appIdString, spk::Metadata::Reader metadata, kj::Maybe<uid_t> sandboxUid);

  static kj::String verifyImpl(
      int spkfd, int tmpfile, kj::Maybe<spk::VerifiedInfo::Builder> maybeInfo,
      kj::Function<kj::String(kj::StringPtr problem)> validationError) {
    // Read package form spkfd, check the validity and signature, and return the appId. Also write
    // the uncompressed archive to `tmpfile`.

    // We need to compute the hash of the input. The input could be a pipe (not a file), therefore
    // we need to read it in chunks, hash the content, and write back out to the pipe that xz will
    // use as input below. We'll do all that in a thread to keep the code simple.
    byte packageHash[crypto_hash_sha256_BYTES];
    Pipe spkPipe = Pipe::make();
    auto hashThread = new kj::Thread([&]() {
      crypto_hash_sha256_state packageHashState;
      KJ_ASSERT(crypto_hash_sha256_init(&packageHashState) == 0);

      byte buffer[8192];
      kj::FdOutputStream out(kj::mv(spkPipe.writeEnd));
      for (;;) {
        ssize_t n;
        KJ_SYSCALL(n = read(spkfd, buffer, sizeof(buffer)));
        if (n == 0) break;
        KJ_ASSERT(crypto_hash_sha256_update(&packageHashState, buffer, n) == 0);
        out.write(buffer, n);
      }

      KJ_ASSERT(crypto_hash_sha256_final(&packageHashState, packageHash));
    });

    // Check the magic number.
    auto expectedMagic = spk::MAGIC_NUMBER.get();
    byte magic[expectedMagic.size()];
    kj::FdInputStream(spkPipe.readEnd.get()).read(magic, expectedMagic.size());
    for (uint i: kj::indices(expectedMagic)) {
      if (magic[i] != expectedMagic[i]) {
        return validationError("Does not appear to be an .spk (bad magic number).");
      }
    }

    // Decompress the remaining bytes in the SPK using xz.
    Pipe pipe = Pipe::make();

    Subprocess::Options childOptions({"xz", "-dc"});
    childOptions.stdin = spkPipe.readEnd;
    childOptions.stdout = pipe.writeEnd;
    Subprocess child(kj::mv(childOptions));

    spkPipe.readEnd = nullptr;
    pipe.writeEnd = nullptr;
    kj::FdInputStream in(kj::mv(pipe.readEnd));

    // Read in the signature.
    byte publicKey[crypto_sign_PUBLICKEYBYTES];
    byte sigBytes[crypto_hash_sha512_BYTES + crypto_sign_BYTES];
    {
      // TODO(security): Set a small limit on signature size?
      capnp::InputStreamMessageReader signatureMessage(in);
      auto signature = signatureMessage.getRoot<spk::Signature>();
      auto pkReader = signature.getPublicKey();
      if (pkReader.size() != sizeof(publicKey)) {
        return validationError("Invalid public key.");
      }
      memcpy(publicKey, pkReader.begin(), sizeof(publicKey));
      auto sigReader = signature.getSignature();
      if (sigReader.size() != sizeof(sigBytes)) {
        return validationError("Invalid signature format.");
      }
      memcpy(sigBytes, sigReader.begin(), sizeof(sigBytes));
    }

    // Verify the signature.
    byte expectedHash[sizeof(sigBytes)];
    unsigned long long hashLength = 0;  // will be overwritten later
    int result = crypto_sign_open(
        expectedHash, &hashLength, sigBytes, sizeof(sigBytes), publicKey);
    if (result != 0) {
      return validationError("Invalid signature.");
    }
    if (hashLength != crypto_hash_sha512_BYTES) {
      return validationError("Wrong signature size.");
    }

    // Copy archive part to a temp file, computing hash in the meantime.
    crypto_hash_sha512_state hashState;
    crypto_hash_sha512_init(&hashState);
    kj::FdOutputStream tmpOut(tmpfile);
    uint64_t totalRead = 0;
    for (;;) {
      byte buffer[8192];
      size_t n = in.tryRead(buffer, 1, sizeof(buffer));
      if (n == 0) break;
      crypto_hash_sha512_update(&hashState, buffer, n);
      totalRead += n;
      KJ_REQUIRE(totalRead <= APP_SIZE_LIMIT, "App too big after decompress.");
      tmpOut.write(buffer, n);
    }

    child.waitForSuccess();
    hashThread = nullptr;  // joins thread

    // The spk pipe thread should have exited now, completing the hash.
    static_assert(PACKAGE_ID_BYTE_SIZE <= crypto_hash_sha256_BYTES, "package ID size changed?");
    auto packageIdBytes = kj::arrayPtr(packageHash, PACKAGE_ID_BYTE_SIZE);

    // Check that hashes match.
    byte hash[crypto_hash_sha512_BYTES];
    crypto_hash_sha512_final(&hashState, hash);
    if (memcmp(expectedHash, hash, crypto_hash_sha512_BYTES) != 0) {
      return validationError("Signature didn't match package contents.");
    }

    // Get the canonical app ID based on the replacements table (see appid-replacements.capnp).
    // This also throws if the key is revoked.
    applyAppidReplacements(publicKey, packageIdBytes);

    auto appIdString = sandstorm::appIdString(publicKey);

    KJ_IF_MAYBE(info, maybeInfo) {
      // mmap the temp file.
      MemoryMapping tmpMapping(tmpfile, "(temp file)");

      // Set up archive reader.
      kj::ArrayPtr<const capnp::word> tmpWords = tmpMapping;
      capnp::ReaderOptions options;
      options.traversalLimitInWords = tmpWords.size();
      capnp::FlatArrayMessageReader archiveMessage(tmpWords, options);

      bool foundManifest = false;
      for (auto file: archiveMessage.getRoot<spk::Archive>().getFiles()) {
        if (file.getName() == "sandstorm-manifest") {
          if (!file.isRegular()) {
            return validationError("sandstorm-manifest is not a regular file");
          }

          auto data = file.getRegular();

          capnp::ReaderOptions manifestLimits;
          manifestLimits.traversalLimitInWords = spk::Manifest::SIZE_LIMIT_IN_WORDS;

          // Data fields are always word-aligned.
          capnp::FlatArrayMessageReader manifestMessage(
              kj::arrayPtr(reinterpret_cast<const capnp::word*>(data.begin()),
                           data.size() / sizeof(capnp::word)), manifestLimits);

          auto manifest = manifestMessage.getRoot<spk::Manifest>();

          // TODO(someday): Support localization properly?

          {
            auto appId = capnp::AnyStruct::Builder(info->initAppId()).getDataSection();
            KJ_ASSERT(appId.size() == sizeof(publicKey));
            memcpy(appId.begin(), publicKey, sizeof(publicKey));
          }
          {
            auto packageId = capnp::AnyStruct::Builder(info->initPackageId()).getDataSection();
            KJ_ASSERT(packageId.size() == packageIdBytes.size());
            memcpy(packageId.begin(), packageIdBytes.begin(), packageIdBytes.size());
          }

          info->setTitle(manifest.getAppTitle());
          info->setVersion(manifest.getAppVersion());
          info->setMarketingVersion(manifest.getAppMarketingVersion());
          auto metadata = manifest.getMetadata();
          info->setMetadata(metadata);

          // Validate some things.
          if (metadata.hasWebsite()) requireHttpUrl(metadata.getWebsite());
          if (metadata.hasCodeUrl()) requireHttpUrl(metadata.getCodeUrl());

          // Check author PGP key.
          auto author = metadata.getAuthor();
          if (author.hasPgpSignature()) {
            if (!metadata.hasPgpKeyring()) {
              return validationError(
                  "author's PGP signature is present but no PGP keyring is provided");
            }

            info->setAuthorPgpKeyFingerprint(checkPgpSignature(appIdString,
                author.getPgpSignature(), metadata.getPgpKeyring(), validationError));
          }

          foundManifest = true;
          break;
        }
      }

      if (!foundManifest) {
        return validationError("SPK contains no manifest file.");
      }
    }

    return appIdString;
  }

  static void requireHttpUrl(kj::StringPtr url) {
    KJ_REQUIRE(url.startsWith("http://") || url.startsWith("https://"),
               "web URLs must be HTTP", url);
  }

  static kj::String checkPgpSignature(
      kj::StringPtr appIdString, kj::ArrayPtr<const byte> sig, kj::ArrayPtr<const byte> key,
      kj::Function<kj::String(kj::StringPtr problem)>& validationError,
      kj::Maybe<uid_t> sandboxUid = nullptr) {
    auto expectedContent = kj::str(
        "I am the author of the Sandstorm.io app with the following ID: ",
        appIdString);

    char keyfile[] = "/tmp/spk-pgp-key.XXXXXX";
    int keyfd;
    KJ_SYSCALL(keyfd = mkstemp(keyfile));
    KJ_DEFER(unlink(keyfile));
    kj::FdOutputStream(kj::AutoCloseFd(keyfd)).write(key.begin(), key.size());

    char sigfile[] = "/tmp/spk-pgp-sig.XXXXXX";
    int sigfd;
    KJ_SYSCALL(sigfd = mkstemp(sigfile));
    KJ_DEFER(unlink(sigfile));
    kj::FdOutputStream(kj::AutoCloseFd(sigfd)).write(sig.begin(), sig.size());

    // GPG unfortunately DEMANDS to read from its "home directory", which is expected to contain
    // user configuration. We actively don't want this: we want it to run in a reproducible manner.
    // So we create a fake home.
    char gpghome[] = "/tmp/spk-fake-gpg-home.XXXXXX";
    if (mkdtemp(gpghome) == nullptr) {
      KJ_FAIL_SYSCALL("mkdtemp(gpghome)", errno, gpghome);
    }
    KJ_DEFER(recursivelyDelete(gpghome));

    auto outPipe = Pipe::make();       // stdout -> signed text
    auto messagePipe = Pipe::make();   // stderr -> human-readable messages
    auto statusPipe = Pipe::make();    // fd 3 -> machine-readable messages

    Subprocess::Options gpgOptions({
        "gpg", "--homedir", gpghome, "--status-fd", "3", "--no-default-keyring",
        "--keyring", keyfile, "--decrypt", sigfile});
    gpgOptions.uid = sandboxUid;
    gpgOptions.stdout = outPipe.writeEnd;
    gpgOptions.stderr = messagePipe.writeEnd;
    int moreFds[1] = { statusPipe.writeEnd };
    gpgOptions.moreFds = moreFds;
    Subprocess gpg(kj::mv(gpgOptions));

    outPipe.writeEnd = nullptr;
    messagePipe.writeEnd = nullptr;
    statusPipe.writeEnd = nullptr;

    // Gather output from GPG.
    // TODO(cleanup): This really belongs in a library, perhaps in `Subprocess`.
    kj::Vector<char> out, message, status;
    bool outDone = false, messageDone = false, statusDone = false;
    for (;;) {
      kj::Vector<struct pollfd> pollfds;
      typedef struct pollfd PollFd;
      if (!outDone) pollfds.add(PollFd {outPipe.readEnd, POLLIN, 0});
      if (!messageDone) pollfds.add(PollFd {messagePipe.readEnd, POLLIN, 0});
      if (!statusDone) pollfds.add(PollFd {statusPipe.readEnd, POLLIN, 0});
      if (pollfds.size() == 0) break;
      KJ_SYSCALL(poll(pollfds.begin(), pollfds.size(), -1));
      for (auto& item: pollfds) {
        if (item.revents & POLLIN) {
          // Data to read!
          char buffer[1024];
          size_t n = kj::FdInputStream(item.fd).read(buffer, 1, sizeof(buffer));
          if (item.fd == outPipe.readEnd.get()) {
            out.addAll(kj::arrayPtr(buffer, n));
          } else if (item.fd == messagePipe.readEnd.get()) {
            message.addAll(kj::arrayPtr(buffer, n));
          } else if (item.fd == statusPipe.readEnd.get()) {
            status.addAll(kj::arrayPtr(buffer, n));
          } else {
            KJ_FAIL_ASSERT("unexpected FD returned by poll()?");
          }
        } else if (item.revents != 0) {
          // Woke up with no data available; must be EOF.
          if (item.fd == outPipe.readEnd.get()) {
            outDone = true;
          } else if (item.fd == messagePipe.readEnd.get()) {
            messageDone = true;
          } else if (item.fd == statusPipe.readEnd.get()) {
            statusDone = true;
          } else {
            KJ_FAIL_ASSERT("unexpected FD returned by poll()?");
          }
        }
      }
    }

    if (gpg.waitForExitOrSignal() != 0) {
      return validationError(kj::str(
          "SPK PGP signature check validation failed. GPG output follows.\n",
          kj::implicitCast<kj::ArrayPtr<const char>>(message)));
    }

    auto content = trim(out);
    if (content != expectedContent) {
      return validationError(kj::str(
          "SPK PGP signature signed incorrect text."
          "\nExpected: ", expectedContent,
          "\nActual:   ", content));
    }

    // Look for the VALIDSIG line which provides the PGP key fingerprint.
    kj::String fingerprint;
    for (auto& statusLine: split(status, '\n')) {
      auto words = splitSpace(statusLine);
      if (words.size() >= 3 &&
          kj::heapString(words[0]) == "[GNUPG:]" &&
          kj::heapString(words[1]) == "VALIDSIG") {
        // This is the line we're looking for!

        // words[11] is privacy-key-fpr, i.e. the fingerprint of the user's main key rather than
        // the subkey used for this signature. The docs suggest it might not be present. words[2]
        // is always the fingerprint of the exact key that did the signing, so fall back to that
        // if needed.
        return kj::heapString(words.size() > 11 ? words[11] : words[2]);
      }
    }

    KJ_FAIL_ASSERT("couldn't find expected '[GNUPG:] VALIDSIG' line in GPG status output",
                   kj::str(status.asPtr()));
  }

  static kj::String unpackImpl(
      int spkfd, kj::StringPtr dirname, kj::StringPtr tmpNear,
      kj::Function<kj::String(kj::StringPtr problem)> validationError) {
    // TODO(security):  We could at this point chroot into the output directory and unshare
    //   various resources for extra security, if not for the fact that we need to invoke xz
    //   later on.  Maybe link against the xz library so that we don't have to exec it?

    auto tmpfile = openTemporary(tmpNear);
    auto appId = verifyImpl(spkfd, tmpfile, nullptr, kj::mv(validationError));

    // mmap the temp file.
    MemoryMapping tmpMapping(tmpfile, "(temp file)");
    tmpfile = nullptr;  // We have the mapping now; don't need the fd.

    // Set up archive reader.
    kj::ArrayPtr<const capnp::word> tmpWords = tmpMapping;
    capnp::ReaderOptions options;
    options.traversalLimitInWords = tmpWords.size();

    // We've observed that apps which use npm can have insanely deep directory trees due to npm's
    // insane approach to dependency management. We've seen at least one app creep over the default
    // nesting limit of 64, so we double it to 128. (We can't just set this to infinity for the
    // same security reasons this limit exists in the first place.)
    options.nestingLimit = 128;

    capnp::FlatArrayMessageReader archiveMessage(tmpWords, options);

    // Unpack.
    unpackDir(archiveMessage.getRoot<spk::Archive>().getFiles(), dirname);

    // Note the appid.
    return appId;
  }

  static void unpackDir(capnp::List<spk::Archive::File>::Reader files, kj::StringPtr dirname) {
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
  // "verify" command

  kj::MainFunc getVerifyMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Check that <spkfile>'s signature is valid. If so, print the app ID to stdout.")
        .addOption({'d', "details"}, KJ_BIND_METHOD(*this, setDetailed),
            // `spk verify` now prints details by default, but the --details switch is left here for
            // backwards compatibility for callers.
            "Print detailed metadata extracted from the app manifest. The output is intended to "
            "be machine-parseable.  This flag is now enabled by default.")
        .expectArg("<spkfile>", KJ_BIND_METHOD(*this, setUnpackSpkfile))
        .callAfterParsing(KJ_BIND_METHOD(*this, doVerify))
        .build();
  }

  bool detailed = true;
  // Print verbose details by default when verifying, since that's the primary
  // reason anyone will call the verify subcommand.

  bool setDetailed() {
    detailed = true;
    return true;
  }

  kj::MainBuilder::Validity doVerify() {
    kj::AutoCloseFd ownFd;
    int spkfd;

    if (spkfile == "-") {
      spkfd = STDIN_FILENO;
    } else {
      ownFd = raiiOpen(spkfile, O_RDONLY);
      spkfd = ownFd;
    }

    if (detailed) {
      kj::AutoCloseFd tmpfile = openTemporary("/tmp/spk-verify-tmp");
      capnp::MallocMessageBuilder message;
      auto info = message.getRoot<spk::VerifiedInfo>();
      verifyImpl(spkfd, tmpfile, info, [&](kj::StringPtr problem) -> kj::String {
        validationError(spkfile, problem);
      });
      tmpfile = nullptr;

      AppIdJsonHandler appIdHandler;
      PackageIdJsonHandler packageIdHandler;
      OversizeDataHandler oversizeDataHandler;
      OversizeTextHandler oversizeTextHandler;
      capnp::JsonCodec json;
      json.addTypeHandler(appIdHandler);
      json.addTypeHandler(packageIdHandler);
      json.addTypeHandler(oversizeDataHandler);
      json.addTypeHandler(oversizeTextHandler);
      json.setPrettyPrint(true);

      auto text = json.encode(info);
      kj::FdOutputStream(STDOUT_FILENO).write(text.begin(), text.size());
      kj::FdOutputStream(STDOUT_FILENO).write("\n", 1);
      context.exit();
    } else {
      kj::AutoCloseFd tmpfile = raiiOpen("/dev/null", O_WRONLY | O_CLOEXEC);;
      auto appId = verifyImpl(spkfd, tmpfile, nullptr, [&](kj::StringPtr problem) -> kj::String {
        validationError(spkfile, problem);
      });
      printAppId(appId);
    }

    return true;
  }

  // =====================================================================================
  // "dev" command

  kj::String serverBinary;
  kj::StringPtr mountDir;
  bool fuseCaching = false;
  bool mountProc = false;

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
            "the installed init script.")
        .addOptionWithArg({'m', "mount"}, KJ_BIND_METHOD(*this, setMountDir), "<dir>",
            "Don't actually connect to the server. Mount the package at <dir>, so you can poke "
            "at it.")
        .addOption({'c', "cache"}, KJ_BIND_METHOD(*this, enableFuseCaching),
            "Enable aggressive caching over the FUSE filesystem used to detect dependencies. "
            "This may improve performance but means that you will have to restart `spk dev` "
            "any time you make a change to your code.")
        .addOption({"proc"}, KJ_BIND_METHOD(*this, enableMountProc),
            "Mount /proc inside the sandbox. This can be useful for debugging. For security "
            "reasons, this option is only available when you are developing an app; packaged "
            "apps do not get access to /proc.")
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

  kj::MainBuilder::Validity enableFuseCaching() {
    fuseCaching = true;
    return true;
  }

  kj::MainBuilder::Validity enableMountProc() {
    mountProc = true;
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

      // Write the mountProc option to the socket.
      {
        auto msg = kj::str(mountProc ? "1" : "0", "\n");
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
      options.cacheForever = fuseCaching;

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
        kj::Own<kj::UnixEventPort::FdObserver> logObserver =
            kj::heap<kj::UnixEventPort::FdObserver>(eventPort, *c,
                kj::UnixEventPort::FdObserver::OBSERVE_READ);
        auto promise = pipeToStdout(*logObserver, *c);
        logPipe = promise.attach(kj::mv(logObserver)).eagerlyEvaluate(nullptr);
      }

      if (connection == nullptr) {
        context.warning("App mounted. Ctrl+C to disconnect.");
      } else {
        context.warning("App is now available from Sandstorm server. Ctrl+C to disconnect.");
      }

      bindFuse(eventPort, fuseFd, kj::mv(rootNode), options)
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
        auto sourceMap = packageDef.getSourceMap();
        for (auto& line: splitLines(readAll(fileList))) {
          auto mapping = mapFile(sourceDir, sourceMap, line);
          if (mapping.sourcePaths.size() == 0 && mapping.virtualChildren.size() == 0 &&
              line != "sandstorm-manifest" &&
              line != "sandstorm-http-bridge" &&
              line != "sandstorm-http-bridge-config" &&
              line != "proc/cpuinfo") {
            context.warning(kj::str("No file found to satisfy requirement: ", line,
                                    ", removing from sandstorm-files.list"));
          } else {
            usedFiles.insert(kj::mv(line));
          }
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
            "Your program used the following files. (If you would specify `fileList` in\n"
            "the package definition, I could write the list there.)\n\n");
        auto msg = kj::str(
            kj::StringTree(KJ_MAP(file, usedFiles) { return kj::strTree(file); }, "\n"), "\n");
        kj::FdOutputStream(STDOUT_FILENO).write(msg.begin(), msg.size());
      }
    }

    return true;
  }

  static kj::Promise<void> pipeToStdout(kj::UnixEventPort::FdObserver& observer, int fd) {
    // Asynchronously read all data from fd and write it to STDOUT.
    // TODO(cleanup): Use KJ I/O facilities. Requires making it possible to construct
    //   kj::LowLevelAsyncIoProvider directly from UnixEventPort.

    for (;;) {
      ssize_t n;
      char buffer[1024];
      KJ_NONBLOCKING_SYSCALL(n = read(fd, buffer, sizeof(buffer)));

      if (n < 0) {
        // Got EAGAIN.
        return observer.whenBecomesReadable().then([&observer, fd]() {
          return pipeToStdout(observer, fd);
        });
      } else if (n == 0) {
        return kj::READY_NOW;
      }

      kj::FdOutputStream(STDOUT_FILENO).write(buffer, n);
    }
  }

  // =====================================================================================
  // "publish" command

  kj::Maybe<appindex::SubmissionState> publishState = appindex::SubmissionState::PUBLISH;
  // By default `spk publish` publishes the package.

  // https://alpha-api.sandstorm.io/#Rs-0TT13YrNSbv7Fiz5K9bBkLaJn3E5TB0PU1GSn1HE
  kj::String appIndexEndpoint = kj::heapString("https://alpha-api.sandstorm.io");
  kj::String appIndexToken = kj::heapString("Rs-0TT13YrNSbv7Fiz5K9bBkLaJn3E5TB0PU1GSn1HE");

  kj::MainFunc getPublishMain() {
    return addCommonOptions(OptionSet::KEYS_READONLY,
        kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Publish an SPK to the Sandstorm app index, or check the status of a "
            "previous submission.")
        .addOption({'s', "status"}, [this]() {publishState = nullptr; return true;},
            "Just check the review status of a previously-submitted SPK.")
        .addOption({'e', "embargo"},
            [this]() {publishState = appindex::SubmissionState::REVIEW; return true;},
            "Embargoes the package, preventing it from being published publicly. However, "
            "it will still be actively reviewed. You may run the command again later without "
            "this flag to mark the app for publishing. This allows you to submit an app for "
            "review in advance of a launch date but still control the exact time of launch.")
        .addOption({'r', "remove"},
            [this]() {publishState = appindex::SubmissionState::IGNORE; return true;},
            "Removes a package listing. If the package was published, it is un-published. If the "
            "package was still pending review, the review is canceled.")
        .addOptionWithArg({"webkey"}, KJ_BIND_METHOD(*this, setPublishWebkey), "<webkey>",
            "Submit to the index at the given webkey. If not specified, the main Sandstorm "
            "app index is assumed.")
        .expectArg("<spkfile>", KJ_BIND_METHOD(*this, doPublish)))
        .build();
  }

  kj::MainBuilder::Validity setPublishWebkey(kj::StringPtr webkey) {
    auto parts = split(webkey, '#');
    if (parts.size() != 2) return "invalid webkey format";

    // Strip trailing slashes from host.
    while (parts[0].size() > 0 && parts[0][parts[0].size() - 1] == '/') {
      parts[0] = parts[0].slice(0, parts[0].size() - 1);
    }

    appIndexEndpoint = kj::str(parts[0]);
    appIndexToken = kj::str(parts[1]);

    if (!appIndexEndpoint.startsWith("http://") && !appIndexEndpoint.startsWith("https://")) {
      return "invalid webkey format";
    }

    return true;
  }

  kj::MainBuilder::Validity doPublish(kj::StringPtr spkfile) {
    if (appIndexEndpoint == nullptr) {
      context.exitError(
          "Hello! The publishing tool isn't quite ready yet, but if you have an app "
          "you'd like to publish please email kenton@sandstorm.io with a link to the spk!");
    }

    if (access(spkfile.cStr(), F_OK) < 0) {
      return "no such file";
    }

    capnp::MallocMessageBuilder scratch;
    auto arena = scratch.getOrphanage();

    auto infoOrphan = arena.newOrphan<spk::VerifiedInfo>();
    auto info = infoOrphan.get();
    auto spkfd = raiiOpen(spkfile, O_RDONLY);
    verifyImpl(spkfd, openTemporary("/tmp/spk-verify"), info,
        [&](kj::StringPtr problem) -> kj::String {
      validationError(spkfile, problem);
    });

    auto key = lookupKey(appIdString(info.getAppId()));

    capnp::MallocMessageBuilder requestMessage;
    auto request = requestMessage.getRoot<appindex::SubmissionRequest>();
    request.setPackageId(info.getPackageId());
    KJ_IF_MAYBE(s, publishState) {
      auto mutation = request.initSetState();
      mutation.setNewState(*s);
      mutation.setSequenceNumber(time(nullptr));
    } else {
      request.setCheckStatus();
    }
    auto webkey = kj::str(appIndexEndpoint, '#', appIndexToken);
    auto webkeyHash = request.initAppIndexWebkeyHash(16);
    crypto_generichash_blake2b(webkeyHash.begin(), webkeyHash.size(),
                               webkey.asBytes().begin(), webkey.size(), nullptr, 0);

    // TODO(cleanup): Need a kj::VectorOutputStream or something which can dynamically grow.
    byte buffer[1024];
    byte* messageEnd;
    {
      kj::ArrayOutputStream stream(buffer);
      capnp::writePackedMessage(stream, requestMessage);
      messageEnd = stream.getArray().end();
    }

    KJ_ASSERT(buffer + sizeof(buffer) - messageEnd >= crypto_sign_BYTES);
    crypto_sign_detached(messageEnd, nullptr, buffer, messageEnd - buffer,
                         key.getPrivateKey().begin());
    auto encodedRequest = kj::arrayPtr(buffer, messageEnd + crypto_sign_BYTES);

    for (;;) {
      {
        context.warning("talking to index server...");

        auto inPipe = Pipe::make();
        auto outPipe = Pipe::make();

        auto authHeader = kj::str("Authorization: Bearer ", appIndexToken);
        auto url = kj::str(appIndexEndpoint, "/status");
        Subprocess::Options curlOptions({
            "curl", "-sS", "-X", "POST", "--data-binary", "@-", "-H", authHeader, url});
        curlOptions.stdin = inPipe.readEnd;
        curlOptions.stdout = outPipe.writeEnd;
        Subprocess curl(kj::mv(curlOptions));
        inPipe.readEnd = nullptr;
        outPipe.writeEnd = nullptr;

        kj::FdOutputStream(inPipe.writeEnd.get())
            .write(encodedRequest.begin(), encodedRequest.size());
        inPipe.writeEnd = nullptr;
        auto data = readAllBytes(outPipe.readEnd);
        if (curl.waitForExit() != 0) {
          context.exitError("curl failed");
        }

        if (data.size() > 0 && data[0] == '\0') {
          // Binary!
          kj::ArrayInputStream dataStream(data.slice(1, data.size()));
          capnp::PackedMessageReader messageReader(dataStream);
          auto status = messageReader.getRoot<appindex::SubmissionStatus>();
          switch (status.which()) {
            case appindex::SubmissionStatus::PENDING:
              switch (status.getRequestState()) {
                case appindex::SubmissionState::IGNORE:
                  context.exitInfo(
                      "Your submission has been removed. It was never reviewed nor published.");
                case appindex::SubmissionState::REVIEW:
                  context.exitInfo(
                      "Your submission is being reviewed. Since you've asked that it be embargoed, "
                      "it won't be published when approved; you will need to run `spk publish` "
                      "again without -e.");
                case appindex::SubmissionState::PUBLISH:
                  context.exitInfo(
                      "Thanks for your submission! A human will look at your submission to make "
                      "sure that everything is in order before it goes live. If we spot any mistakes "
                      "we'll let you know, otherwise your app will go live as soon as it has been "
                      "checked. Either way, we'll send you an email at the contact address you "
                      "provided in the metadata. (If you'd like to prevent this submission "
                      "from going live immediately, run `spk publish` again with -e.)");
              }
              KJ_UNREACHABLE;

            case appindex::SubmissionStatus::NEEDS_UPDATE:
              switch (status.getRequestState()) {
                case appindex::SubmissionState::IGNORE:
                  context.exitInfo(kj::str(
                      "Your submission has been removed. For reference, before removal, a human "
                      "had checked your submission and found a problem. If you decide to submit "
                      "again, please correct this problem first: ", status.getNeedsUpdate()));
                case appindex::SubmissionState::REVIEW:
                case appindex::SubmissionState::PUBLISH:
                  context.exitInfo(kj::str(
                      "A human checked your submission and found a problem. Please correct the "
                      "following problem and submit again: ", status.getNeedsUpdate()));
              }
              KJ_UNREACHABLE;

            case appindex::SubmissionStatus::APPROVED:
              switch (status.getRequestState()) {
                case appindex::SubmissionState::IGNORE:
                  context.exitInfo(
                      "Your submission has been removed. It had already been reviewed and "
                      "approved, so if you change your mind you can publish it at any time "
                      "by running `spk publish` again without flags.");
                case appindex::SubmissionState::REVIEW:
                  context.exitInfo(
                      "Your submission is approved and can be published whenever you are ready. "
                      "Run `spk publish` again without flags to make your app live.");
                case appindex::SubmissionState::PUBLISH:
                  // TODO(soon): Add link? Only for default app market.
                  context.exitInfo(
                      "Your submission is approved and is currently live!");
              }
              KJ_UNREACHABLE;

            case appindex::SubmissionStatus::NOT_UPLOADED:
              // Need to upload first...
              if (publishState == nullptr) {
                context.exitInfo("This package has not been uploaded to the index.");
              }
              break;
          }
        } else {
          // Error message. :(
          kj::FdOutputStream(STDERR_FILENO).write(data.begin(), data.size());
          context.exitError("failed to connect to app index");
        }
      }

      {
        // If we get here, the server indicated that the app had not been uploaded.
        context.warning("uploading package to index...");

        KJ_SYSCALL(lseek(spkfd, 0, SEEK_SET));
        auto outPipe = Pipe::make();

        auto authHeader = kj::str("Authorization: Bearer ", appIndexToken);
        auto url = kj::str(appIndexEndpoint, "/upload");
        Subprocess::Options curlOptions({
            "curl", "-sS", "-X", "POST", "--data-binary", "@-", "-H", authHeader, url});
        curlOptions.stdin = spkfd;
        curlOptions.stdout = outPipe.writeEnd;
        Subprocess curl(kj::mv(curlOptions));
        outPipe.writeEnd = nullptr;

        auto response = readAll(outPipe.readEnd);
        if (curl.waitForExit() != 0) {
          context.exitError("curl failed");
        }
        if (response.size() > 0) {
          context.exitError(kj::str(
              "server returned error on upload: ", response));
        }
      }
    }
  }
};

kj::Own<AbstractMain> getSpkMain(kj::ProcessContext& context) {
  return kj::heap<SpkTool>(context);
}

kj::String unpackSpk(int spkfd, kj::StringPtr outdir, kj::StringPtr tmpdir) {
  return SpkTool::unpackImpl(spkfd, outdir, kj::str(tmpdir, "/spk-unpack-tmp"),
      [](kj::StringPtr problem) -> kj::String {
    KJ_FAIL_ASSERT("spk unpack failed", problem);
  });
}

void verifySpk(int spkfd, int tmpfile, spk::VerifiedInfo::Builder output) {
  SpkTool::verifyImpl(spkfd, tmpfile, output, [](kj::StringPtr problem) -> kj::String {
    KJ_FAIL_ASSERT("spk verification failed", problem);
  });
}

kj::Maybe<kj::String> checkPgpSignature(kj::StringPtr appIdString, spk::Metadata::Reader metadata,
                                        kj::Maybe<uid_t> sandboxUid) {
  auto author = metadata.getAuthor();

  if (author.hasPgpSignature()) {
    KJ_REQUIRE(metadata.hasPgpKeyring(), "package metadata contains PGP signature but no keyring");

    kj::Function<kj::String(kj::StringPtr problem)> error =
        [](kj::StringPtr problem) -> kj::String {
      KJ_FAIL_ASSERT("PGP signature verification problem", problem);
    };
    return SpkTool::checkPgpSignature(appIdString,
        author.getPgpSignature(), metadata.getPgpKeyring(), error, sandboxUid);
  } else {
    return nullptr;
  }
}

}  // namespace sandstorm
