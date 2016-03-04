// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

#include <kj/main.h>
#include <sandstorm/feature-key.capnp.h>
#include "version.h"
#include "util.h"
#include <capnp/serialize.h>
#include <capnp/serialize-packed.h>
#include <capnp/schema-parser.h>
#include <capnp/pretty-print.h>
#include <sodium/crypto_sign_ed25519.h>
#include <sodium/randombytes.h>

namespace sandstorm {

class FeatureKeyTool {
  // Main class for the feature key generation tool.

public:
  FeatureKeyTool(kj::ProcessContext& context): context(context) {
    schemaParser.loadCompiledTypeAndDependencies<FeatureKey>();
  }

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Tool used to create feature keys.")
        .addSubCommand("sign", KJ_BIND_METHOD(*this, getSignMain), "sign a feature key")
        .addSubCommand("verify", KJ_BIND_METHOD(*this, getVerifyMain), "verify a feature key")
        .addSubCommand("keygen", KJ_BIND_METHOD(*this, getKeygenMain), "create a new signing key")
        .addSubCommand("readkey", KJ_BIND_METHOD(*this, getReadkeyMain), "show public key")
        .build();
  }

  kj::MainFunc getSignMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Sign a feature key. <file> is a capnp file containing a constant "
                           "named <name> which is of type FeatureKey. The signed key is written "
                           "to stdout.")
        .addOptionWithArg({'I', "import-path"}, KJ_BIND_METHOD(*this, addImportPath),
                          "<dir>", "search for capnp imports in <dir>")
        .expectArg("<signing-key>", KJ_BIND_METHOD(*this, loadKey))
        .expectArg("<file>", KJ_BIND_METHOD(*this, parseSourceFile))
        .expectOneOrMoreArgs("<name>", KJ_BIND_METHOD(*this, doSign))
        .build();
  }

  kj::MainBuilder::Validity addImportPath(kj::StringPtr arg) {
    importPath.add(arg);
    return true;
  }

  kj::MainBuilder::Validity loadKey(kj::StringPtr arg) {
    auto seed = readAllBytes(raiiOpen(arg, O_RDONLY));
    if (seed.size() != crypto_sign_ed25519_SEEDBYTES) {
      return "invalid key file";
    }

    KJ_ASSERT(crypto_sign_ed25519_seed_keypair(publicKey, key, seed.begin()) == 0);
    return true;
  }

  kj::MainBuilder::Validity parseSourceFile(kj::StringPtr arg) {
    schema = schemaParser.parseDiskFile(arg, arg, importPath);
    return true;
  }

  kj::MainBuilder::Validity doSign(kj::StringPtr arg) {
    capnp::MallocMessageBuilder builder;
    builder.setRoot(schema.getNested(arg).asConst().as<FeatureKey>());

    kj::VectorOutputStream output;
    capnp::writePackedMessage(output, builder);

    auto unsign = output.getArray();
    auto sign = kj::heapArray<byte>(unsign.size() + crypto_sign_ed25519_BYTES);
    unsigned long long length;

    KJ_ASSERT(crypto_sign_ed25519(sign.begin(), &length, unsign.begin(), unsign.size(), key) == 0);

    auto msg = kj::str(
        "--------------------- BEGIN SANDSTORM FEATURE KEY ----------------------\n",
        base64Encode(sign.slice(0, length), true),
        "---------------------- END SANDSTORM FEATURE KEY -----------------------\n");
    kj::FdOutputStream(STDOUT_FILENO).write(msg.begin(), msg.size());
    return true;
  }

  kj::MainFunc getVerifyMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Read a feature key on standard input, verify the signature, and "
                           "print the details.")
        .callAfterParsing(KJ_BIND_METHOD(*this, doVerify))
        .build();
  }

  kj::MainBuilder::Validity doVerify() {
    kj::Vector<kj::String> text;
    for (auto& line: splitLines(readAll(STDIN_FILENO))) {
      auto trimmed = trim(line);
      if (trimmed.size() > 0 && trimmed[0] != '-') {
        text.add(kj::mv(trimmed));
      }
    }

    auto sign = base64Decode(kj::strArray(text, ""));
    auto unsign = kj::heapArray<byte>(sign.size());
    unsigned long long length;

    auto pk = structToBytes(*FeatureKey::SIGNING_KEY, crypto_sign_ed25519_PUBLICKEYBYTES);

    if (crypto_sign_ed25519_open(unsign.begin(), &length, sign.begin(), sign.size(), pk) != 0) {
      return "signature check failed";
    }

    kj::ArrayInputStream input(unsign.slice(0, length));
    capnp::PackedMessageReader reader(input);
    context.exitInfo(capnp::prettyPrint(reader.getRoot<FeatureKey>()).flatten());
  }

  kj::MainFunc getKeygenMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Generates a new key and writes it to stdout in binary.")
        .callAfterParsing(KJ_BIND_METHOD(*this, doKeygen))
        .build();
  }

  kj::MainBuilder::Validity doKeygen() {
    byte random[crypto_sign_ed25519_SEEDBYTES];
    randombytes(random, sizeof(random));
    kj::FdOutputStream(STDOUT_FILENO)
        .write(random, sizeof(random));
    context.exit();
  }

  kj::MainFunc getReadkeyMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Reads a key file and writes the public key as capnp text.")
        .expectArg("<keyfile>", KJ_BIND_METHOD(*this, loadKey))
        .callAfterParsing(KJ_BIND_METHOD(*this, doReadkey))
        .build();
  }

  kj::MainBuilder::Validity doReadkey() {
    capnp::MallocMessageBuilder builder;
    auto pk = builder.getRoot<PublicSigningKey>();

    memcpy(structToBytes(kj::cp(pk), crypto_sign_ed25519_PUBLICKEYBYTES), publicKey,
           crypto_sign_ed25519_PUBLICKEYBYTES);
    auto msg = kj::str(
        "(key0 = 0x", kj::hex(pk.getKey0()), ","
        " key1 = 0x", kj::hex(pk.getKey1()), ","
        " key2 = 0x", kj::hex(pk.getKey2()), ","
        " key3 = 0x", kj::hex(pk.getKey3()), ")\n");
    kj::FdOutputStream(STDOUT_FILENO).write(msg.begin(), msg.size());
    context.exit();
  }

private:
  kj::ProcessContext& context;
  kj::Vector<kj::StringPtr> importPath;
  capnp::SchemaParser schemaParser;
  capnp::ParsedSchema schema;

  byte key[crypto_sign_ed25519_SECRETKEYBYTES];
  byte publicKey[crypto_sign_ed25519_PUBLICKEYBYTES];

  const byte* structToBytes(capnp::AnyStruct::Reader reader, size_t size) {
    auto data = reader.getDataSection();
    KJ_REQUIRE(data.size() == size);
    return data.begin();
  }

  byte* structToBytes(capnp::AnyStruct::Builder builder, size_t size) {
    auto data = builder.getDataSection();
    KJ_REQUIRE(data.size() == size);
    return data.begin();
  }
};

} // namespace sandstorm

KJ_MAIN(sandstorm::FeatureKeyTool)
