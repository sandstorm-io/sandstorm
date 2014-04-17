// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

// This is a tool for manipulating Sandstorm .spk files.

#include <kj/main.h>
#include <kj/debug.h>
#include <kj/io.h>
#include <capnp/serialize.h>
#include <capnp/schema.h>
#include <capnp/pretty-print.h>
#include <sodium.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/mman.h>
#include <errno.h>
#include <sandstorm/package.capnp.h>
#include <sandstorm/bundle.capnp.h>

#include "version.h"

namespace sandstorm {

typedef kj::byte byte;

kj::AutoCloseFd raiiOpen(kj::StringPtr name, int flags, mode_t mode = 0666) {
  int fd;
  KJ_SYSCALL(fd = open(name.cStr(), flags, mode));
  return kj::AutoCloseFd(fd);
}

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

private:
  kj::ArrayPtr<byte> content;
};

kj::Maybe<uint> parseUInt(kj::StringPtr s, int base) {
  char* end;
  uint result = strtoul(s.cStr(), &end, base);
  if (s.size() == 0 || *end != '\0') {
    return nullptr;
  }
  return result;
}

class SignBundle {
  // Main class for the Sandstorm spk tool.

public:
  SignBundle(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
          "Tool for generating bundle signatures used by the update pipeline.")
        .addSubCommand("keygen", KJ_BIND_METHOD(*this, getKeygenMain),
                       "Generate a new keyfile.")
        .addSubCommand("sign", KJ_BIND_METHOD(*this, getSignMain),
                       "Sign a bundle.")
        .addSubCommand("print", KJ_BIND_METHOD(*this, getPrintMain),
                       "Prints the content of a signed UpdateInfo.")
        .build();
  }

private:
  kj::ProcessContext& context;

  // =====================================================================================

  kj::MainFunc getKeygenMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Create a new key pair and store it in <output>.  It can then be used as input to "
            "the `sign` command.  Make sure to store the output in a safe place!")
        .expectOneOrMoreArgs("<output>", KJ_BIND_METHOD(*this, genKeyFile))
        .build();
  }

  kj::MainBuilder::Validity genKeyFile(kj::StringPtr arg) {
    capnp::MallocMessageBuilder message;
    spk::KeyFile::Builder builder = message.getRoot<spk::KeyFile>();

    int result = crypto_sign_keypair(
        builder.initPublicKey(crypto_sign_PUBLICKEYBYTES).begin(),
        builder.initPrivateKey(crypto_sign_SECRETKEYBYTES).begin());
    KJ_ASSERT(result == 0, "crypto_sign_keypair failed", result);

    int fd;
    KJ_SYSCALL(fd = open(arg.cStr(), O_WRONLY | O_CREAT | O_TRUNC, 0666));
    kj::AutoCloseFd closer(fd);
    capnp::writeMessageToFd(fd, message);

    // Print the public key bytes.
    auto msg = kj::str("publicKey = [", kj::strArray(builder.getPublicKey(), ", "), "]\n");
    kj::FdOutputStream out(STDOUT_FILENO);
    out.write(msg.begin(), msg.size());

    return true;
  }

  // =====================================================================================

  capnp::MallocMessageBuilder updateInfoMessage;
  bundle::UpdateInfo::Builder updateInfo = updateInfoMessage.getRoot<bundle::UpdateInfo>();
  kj::byte publicKey[crypto_sign_PUBLICKEYBYTES];
  kj::byte privateKey[crypto_sign_SECRETKEYBYTES];

  kj::MainFunc getSignMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Create an UpdateInfo for <bundle> (with parameters <channel>, <build>, and "
            "<from-min-build>), sign it with <keyfile>, and write the result to <output>.")
        .expectArg("<bundle>", KJ_BIND_METHOD(*this, hashBundle))
        .expectArg("<channel>", KJ_BIND_METHOD(*this, setChannel))
        .expectArg("<build>", KJ_BIND_METHOD(*this, setBuild))
        .expectArg("<from-min-build>", KJ_BIND_METHOD(*this, setFromMinBuild))
        .expectArg("<keyfile>", KJ_BIND_METHOD(*this, loadKeyfile))
        .expectArg("<output>", KJ_BIND_METHOD(*this, writeUpdateInfo))
        .build();
  }

  kj::MainBuilder::Validity hashBundle(kj::StringPtr arg) {
    if (access(arg.cStr(), F_OK) != 0) {
      return "No such file.";
    }

    MemoryMapping bundleFile(raiiOpen(arg, O_RDONLY), arg);
    kj::ArrayPtr<const byte> bytes = bundleFile;
    updateInfo.setSize(bytes.size());
    crypto_hash_sha256(updateInfo.initHash(crypto_hash_sha256_BYTES).begin(),
                       bytes.begin(), bytes.size());
    return true;
  }

  kj::MainBuilder::Validity setChannel(kj::StringPtr arg) {
    KJ_IF_MAYBE(e, capnp::Schema::from<bundle::Channel>().findEnumerantByName(arg)) {
      updateInfo.setChannel(static_cast<bundle::Channel>(e->getIndex()));
      return true;
    } else {
      return "No such channel.";
    }
  }

  kj::MainBuilder::Validity setBuild(kj::StringPtr arg) {
    KJ_IF_MAYBE(b, parseUInt(arg, 10)) {
      updateInfo.setBuild(*b);
      return true;
    } else {
      return "Invalid build number.";
    }
  }

  kj::MainBuilder::Validity setFromMinBuild(kj::StringPtr arg) {
    KJ_IF_MAYBE(b, parseUInt(arg, 10)) {
      updateInfo.setFromMinBuild(*b);
      return true;
    } else {
      return "Invalid build number.";
    }
  }

  kj::MainBuilder::Validity loadKeyfile(kj::StringPtr arg) {
    if (access(arg.cStr(), F_OK) != 0) {
      return "No such file.";
    }

    // Read the keyfile.
    MemoryMapping keyfile(raiiOpen(arg, O_RDONLY), arg);
    capnp::FlatArrayMessageReader keyMessage(keyfile);
    spk::KeyFile::Reader keyReader = keyMessage.getRoot<spk::KeyFile>();
    KJ_REQUIRE(keyReader.getPublicKey().size() == crypto_sign_PUBLICKEYBYTES &&
               keyReader.getPrivateKey().size() == crypto_sign_SECRETKEYBYTES,
               "Invalid key file.");

    memcpy(publicKey, keyReader.getPublicKey().begin(), crypto_sign_PUBLICKEYBYTES);
    memcpy(privateKey, keyReader.getPrivateKey().begin(), crypto_sign_SECRETKEYBYTES);
    return true;
  }

  kj::MainBuilder::Validity writeUpdateInfo(kj::StringPtr arg) {
    auto words = capnp::messageToFlatArray(updateInfoMessage);
    auto bytes = kj::arrayPtr(reinterpret_cast<const byte*>(words.begin()),
                              words.size() * sizeof(words[0]));
    auto output = kj::heapArray<byte>(bytes.size() + crypto_sign_BYTES);
    unsigned long long outputLength = 0;

    KJ_ASSERT(crypto_sign(output.begin(), &outputLength,
                          bytes.begin(), bytes.size(), privateKey) == 0);

    kj::FdOutputStream(raiiOpen(arg, O_WRONLY | O_CREAT | O_TRUNC))
        .write(output.begin(), outputLength);
    return true;
  }

  // =====================================================================================

  kj::MainFunc getPrintMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
            "Prints the content of <update-info>, verifying it against <keyfile>.")
        .expectArg("<keyfile>", KJ_BIND_METHOD(*this, loadKeyfile))
        .expectOneOrMoreArgs("<update-info>", KJ_BIND_METHOD(*this, printUpdateInfo))
        .build();
  }

  kj::MainBuilder::Validity printUpdateInfo(kj::StringPtr arg) {
    if (access(arg.cStr(), F_OK) != 0) {
      return "No such file.";
    }

    MemoryMapping updateInfoFile(raiiOpen(arg, O_RDONLY), arg);
    kj::ArrayPtr<const byte> bytes = updateInfoFile;

    // Check signature.
    auto buffer = kj::heapArray<capnp::word>(bytes.size() / sizeof(capnp::word) + 1);
    unsigned long long length;
    int verifyResult = crypto_sign_open(
        reinterpret_cast<kj::byte*>(buffer.begin()), &length,
        bytes.begin(), bytes.size(), publicKey);
    if (verifyResult != 0) {
      return "Signature check failed.";
    }
    auto verified = buffer.slice(0, length / sizeof(capnp::word));

    // Decode.
    capnp::FlatArrayMessageReader message(verified);
    auto updateInfo = message.getRoot<bundle::UpdateInfo>();

    const char* hexdigit = "0123456789abcdef";
    auto hexbytes = KJ_MAP(b, updateInfo.getHash()) {
      return kj::str(hexdigit[b / 16], hexdigit[b % 16]);
    };

    auto msg = kj::str(capnp::prettyPrint(updateInfo), '\n',
                       "hex hash: ", kj::strArray(hexbytes, ""), '\n');
    kj::FdOutputStream out(STDOUT_FILENO);
    out.write(msg.begin(), msg.size());

    return true;
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::SignBundle)
