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
#include <sodium.h>
#include <unistd.h>
#include <fcntl.h>
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <errno.h>
#include <sandstorm/package.capnp.h>

namespace sandstorm {

typedef kj::byte byte;

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

class MmappedFile: public kj::ArrayPtr<const byte> {
public:
  MmappedFile(kj::StringPtr filename)
      : fd(raiiOpen(filename, O_RDONLY)) {
    size_t size = getFileSize(fd, filename);

    void* ptr = mmap(nullptr, size, PROT_READ, MAP_PRIVATE, fd, 0);
    if (ptr == MAP_FAILED) {
      KJ_FAIL_SYSCALL("mmap", errno, filename);
    }

    kj::implicitCast<kj::ArrayPtr<const byte>&>(*this) =
        kj::arrayPtr(reinterpret_cast<byte*>(ptr), size);
  }

  ~MmappedFile() {
    KJ_SYSCALL(munmap(const_cast<byte*>(begin()), size()));
  }

  inline kj::ArrayPtr<const capnp::word> asWords() const {
    return kj::arrayPtr(reinterpret_cast<const capnp::word*>(begin()),
                        size() / sizeof(capnp::word));
  }

private:
  kj::AutoCloseFd fd;
};

class SpkTool {
  // Main class for the Sandstorm spk tool.

public:
  SpkTool(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version 0.0",
          "Tool for building and checking Sandstorm package files.",
          "Sandstorm packages are mostly just zip files, but they must be cryptographically "
          "signed in order to prove that upgrades came from the same source.  This tool will help "
          "you generate keys and sign your packages.")
        .addSubCommand("keygen", KJ_BIND_METHOD(*this, getKeygenMain),
                       "Generate a new keyfile.")
        .addSubCommand("appid", KJ_BIND_METHOD(*this, getAppidMain),
                       "Get the app ID corresponding to an existing keyfile.")
        .addSubCommand("sign", KJ_BIND_METHOD(*this, getSignMain),
                       "Sign a zip file to create an spk package file.")
        .addSubCommand("verify", KJ_BIND_METHOD(*this, getVerifyMain),
                       "Verify the package's signature.")
        .build();
  }

private:
  kj::ProcessContext& context;
  bool onlyPrintId = false;

  bool setOnlyPrintId() { onlyPrintId = true; return true; }

  void printAppId(kj::ArrayPtr<const byte> publicKey, kj::StringPtr filename) {
    static_assert(crypto_sign_PUBLICKEYBYTES == 32, "Signing algorithm changed?");
    KJ_REQUIRE(publicKey.size() == crypto_sign_PUBLICKEYBYTES);

    auto appId = base32Encode(publicKey);
    kj::String msg = onlyPrintId ? kj::str(appId, "\n") : kj::str(appId, " ", filename, "\n");
    kj::FdOutputStream out(STDOUT_FILENO);
    out.write(msg.begin(), msg.size());
  }

  // =====================================================================================

  kj::MainFunc getKeygenMain() {
    return kj::MainBuilder(context, "Sandstorm version 0.0",
            "Create a new key pair and store it in <output>.  It can then be used as input to "
            "the `sign` command.  Make sure to store the output in a safe place!  If you lose it, "
            "you won't be able to update your app, and if someone else gets ahold of it, they'll "
            "be able to hijack your app.")
        .addOption({'o', "only-id"}, KJ_BIND_METHOD(*this, setOnlyPrintId),
            "Only print the app ID, not the file name.")
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

    // Notify the caller of the app ID.
    printAppId(builder.getPublicKey(), arg);

    return true;
  }

  // =====================================================================================

  kj::MainFunc getAppidMain() {
    return kj::MainBuilder(context, "Sandstorm version 0.0",
            "Read <keyfile> and extract the textual app ID, printing it to stdout.")
        .addOption({'o', "only-id"}, KJ_BIND_METHOD(*this, setOnlyPrintId),
            "Only print the app ID, not the file name.")
        .expectOneOrMoreArgs("<keyfile>", KJ_BIND_METHOD(*this, getAppIdFromKeyfile))
        .build();
  }

  kj::MainBuilder::Validity getAppIdFromKeyfile(kj::StringPtr arg) {
    if (access(arg.cStr(), F_OK) != 0) {
      return "No such file.";
    }

    // Read the keyfile.
    MmappedFile keyfile(arg);
    capnp::FlatArrayMessageReader keyMessage(keyfile.asWords());
    spk::KeyFile::Reader keyReader = keyMessage.getRoot<spk::KeyFile>();
    KJ_REQUIRE(keyReader.getPublicKey().size() == crypto_sign_PUBLICKEYBYTES &&
               keyReader.getPrivateKey().size() == crypto_sign_SECRETKEYBYTES,
               "Invalid key file.");

    printAppId(keyReader.getPublicKey(), arg);
    return true;
  }

  // =====================================================================================

  kj::String zipfile;
  kj::String keyfile;
  kj::String spkfile;

  kj::MainFunc getSignMain() {
    return kj::MainBuilder(context, "Sandstorm version 0.0",
            "Sign <zipfile> with <keyfile>, storing the result to <output>.  If <output> is not "
            "specified, the name will be chosen by replacing \".zip\" with \".spk\" in the input "
            "file name.")
        .expectArg("<zipfile>", KJ_BIND_METHOD(*this, setZipfile))
        .expectArg("<keyfile>", KJ_BIND_METHOD(*this, setKeyfile))
        .expectOptionalArg("<output>", KJ_BIND_METHOD(*this, setSpkfile))
        .callAfterParsing(KJ_BIND_METHOD(*this, doSign))
        .build();
  }

  kj::MainBuilder::Validity setZipfile(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) < 0) {
      return "No such file.";
    }

    zipfile = kj::heapString(name);

    if (name.endsWith(".zip")) {
      spkfile = kj::str(name.slice(0, name.size() - 4), ".spk");
    }

    return true;
  }

  kj::MainBuilder::Validity setKeyfile(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) < 0) {
      return "No such file.";
    }

    keyfile = kj::heapString(name);
    return true;
  }

  kj::MainBuilder::Validity setSpkfile(kj::StringPtr name) {
    spkfile = kj::heapString(name);
    return true;
  }

  kj::MainBuilder::Validity doSign() {
    if (spkfile == nullptr) {
      return "Must specify output name (because input file is not .zip).";
    }

    // Read the keyfile.
    MmappedFile keyfile(this->keyfile);
    capnp::FlatArrayMessageReader keyMessage(keyfile.asWords());
    spk::KeyFile::Reader keyReader = keyMessage.getRoot<spk::KeyFile>();
    KJ_REQUIRE(keyReader.getPublicKey().size() == crypto_sign_PUBLICKEYBYTES &&
               keyReader.getPrivateKey().size() == crypto_sign_SECRETKEYBYTES,
               "Invalid key file.");

    // Open and hash the zip.
    MmappedFile zipfile(this->zipfile);
    byte hash[crypto_hash_BYTES];
    crypto_hash(hash, zipfile.begin(), zipfile.size());

    // Generate the header.
    capnp::MallocMessageBuilder headerMessage;
    spk::Header::Builder header = headerMessage.getRoot<spk::Header>();
    header.setPublicKey(keyReader.getPublicKey());
    unsigned long long siglen = crypto_hash_BYTES + crypto_sign_BYTES;
    byte* signature = header.initSignature(siglen).begin();
    crypto_sign(signature, &siglen, hash, sizeof(hash), keyReader.getPrivateKey().begin());

    // Now write the whole thing out.
    kj::FdOutputStream out(raiiOpen(spkfile, O_WRONLY | O_CREAT | O_TRUNC));
    capnp::writeMessage(out, headerMessage);
    out.write(zipfile.begin(), zipfile.size());

    return true;
  }

  // =====================================================================================

  kj::MainFunc getVerifyMain() {
    return kj::MainBuilder(context, "Sandstorm version 0.0",
            "Check that <spkfile>'s signature is valid, and then print the app ID and "
            "file name.")
        .addOption({'o', "only-id"}, KJ_BIND_METHOD(*this, setOnlyPrintId),
            "Only print the app ID, not the file name.")
        .expectOneOrMoreArgs("<spkfile>", KJ_BIND_METHOD(*this, verifySpkfile))
        .build();
  }

  kj::MainBuilder::Validity validationError(kj::StringPtr filename, kj::StringPtr problem) {
    context.error(kj::str("*** ", filename, ": ", problem));
    return true;  // Keep processing remaining inputs.
  }

  kj::MainBuilder::Validity verifySpkfile(kj::StringPtr name) {
    if (access(name.cStr(), F_OK) < 0) {
      return "No such file.";
    }

    // Read the header.
    MmappedFile spkfile(name);
    capnp::FlatArrayMessageReader headerMessage(spkfile.asWords());
    spk::Header::Reader header = headerMessage.getRoot<spk::Header>();
    auto publicKey = header.getPublicKey();
    if (publicKey.size() != crypto_sign_PUBLICKEYBYTES) {
      return validationError(name, "Invalid public key.");
    }
    static const size_t SIGLEN = crypto_hash_BYTES + crypto_sign_BYTES;
    auto signature = header.getSignature();
    if (signature.size() != SIGLEN) {
      return validationError(name, "Invalid signature format.");
    }

    // Verify the signature.
    byte expectedHash[SIGLEN];
    unsigned long long hashLength = SIGLEN;
    int result = crypto_sign_open(
        expectedHash, &hashLength, signature.begin(), signature.size(), publicKey.begin());
    if (result != 0) {
      return validationError(name, "Invalid signature.");
    }
    if (hashLength != crypto_hash_BYTES) {
      return validationError(name, "Wrong signature size.");
    }

    // Hash the payload.
    auto zipfile = kj::arrayPtr(
        reinterpret_cast<const byte*>(headerMessage.getEnd()), spkfile.end());
    byte hash[crypto_hash_BYTES];
    crypto_hash(hash, zipfile.begin(), zipfile.size());

    // Check that hashes match.
    if (memcmp(expectedHash, hash, crypto_hash_BYTES) != 0) {
      return validationError(name, "Signature didn't match package contents.");
    }

    // Note the app id.
    printAppId(publicKey, name);

    return true;
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::SpkTool)
