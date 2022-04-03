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
#include <sandstorm/update-tool.capnp.h>
#include "version.h"
#include <capnp/serialize.h>
#include "util.h"
#include <sodium/crypto_sign_ed25519.h>
#include <sodium/randombytes.h>
#include <capnp/pretty-print.h>

namespace sandstorm {

class UpdateToolMain {
  // Main class for a program used to sign updates.

public:
  UpdateToolMain(kj::ProcessContext& context): context(context) {}

  kj::MainFunc getMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Tool used to sign Sandstorm updates.")
        .addSubCommand("sign", KJ_BIND_METHOD(*this, getSignMain), "sign an update")
        .addSubCommand("verify", KJ_BIND_METHOD(*this, getVerifyMain), "verify an update")
        .addSubCommand("add", KJ_BIND_METHOD(*this, getAddMain), "create a new key")
        .addSubCommand("list", KJ_BIND_METHOD(*this, getListMain), "list public keys")
        .build();
  }

  kj::MainFunc getSignMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Sign a file with each key in the keyring and output the signature "
                           "list to stdout.")
        .expectArg("<keyring>", KJ_BIND_METHOD(*this, loadKeyring))
        .expectArg("<file>", KJ_BIND_METHOD(*this, doSign))
        .build();
  }

  kj::MainBuilder::Validity loadKeyring(kj::StringPtr arg) {
    // The keyring file is actually 100% random. Every 32 bytes is a seed used to generate a
    // keypair.

    auto bytes = readAllBytes(raiiOpen(arg, O_RDONLY));
    if (bytes == nullptr) return "file is empty";

    size_t count = bytes.size() / crypto_sign_ed25519_SEEDBYTES;
    if (bytes.size() % crypto_sign_ed25519_SEEDBYTES != 0) return "invalid keyring";

    auto publicKeys = *UPDATE_PUBLIC_KEYS;

    auto builder = kj::heapArrayBuilder<PrivateKey>(count);
    for (size_t i = 0; i < count; i++) {
      byte publicKey[crypto_sign_ed25519_PUBLICKEYBYTES];
      KJ_ASSERT(crypto_sign_ed25519_seed_keypair(publicKey, builder.add().key,
          bytes.begin() + i * crypto_sign_ed25519_SEEDBYTES) == 0);

      if (i < publicKeys.size()) {
        if (memcmp(publicKey, getUnderlyingBytes(publicKeys[i], crypto_sign_ed25519_PUBLICKEYBYTES),
                   crypto_sign_ed25519_PUBLICKEYBYTES) != 0) {
          return kj::str("keyring does not match public key #", i);
        }
      }
    }

    if (count < publicKeys.size()) {
      return kj::str("keyring is missing keys starting at #", count);
    }

    if (count > publicKeys.size()) {
      context.warning(kj::str(
          "WARNING: keyring contains keys than are not yet listed in updatePublicKeys"));
    }

    keyring = builder.finish();

    return true;
  }

  kj::MainBuilder::Validity doSign(kj::StringPtr arg) {
    auto bundle = raiiOpen(arg, O_RDONLY);
    MemoryMapping mapping(bundle, arg);
    capnp::Data::Reader data = mapping;

    capnp::MallocMessageBuilder output;
    auto signatures = output.getRoot<UpdateSignature>().initSignatures(keyring.size());

    for (auto i: kj::indices(keyring)) {
      KJ_ASSERT(crypto_sign_ed25519_detached(
          getUnderlyingBytes(signatures[i], crypto_sign_ed25519_BYTES),
          nullptr, data.begin(), data.size(), keyring[i].key) == 0);
    }

    capnp::writeMessageToFd(STDOUT_FILENO, output);

    context.exit();
  }

  kj::MainFunc getVerifyMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Verify <file> against the signature read from standard input.")
        .expectArg("<file>", KJ_BIND_METHOD(*this, doVerify))
        .build();
  }

  kj::MainBuilder::Validity doVerify(kj::StringPtr arg) {
    auto bundle = raiiOpen(arg, O_RDONLY);
    MemoryMapping mapping(bundle, arg);
    capnp::Data::Reader data = mapping;

    capnp::StreamFdMessageReader signatureMessage(STDIN_FILENO);
    auto signatures = signatureMessage.getRoot<UpdateSignature>().getSignatures();
    auto keys = *UPDATE_PUBLIC_KEYS;

    for (auto i: kj::indices(keys)) {
      if (i >= signatures.size()) {
        context.error(kj::str("key ", i, ": NO SIGNATURE"));
        continue;
      } else if (crypto_sign_ed25519_verify_detached(
          getUnderlyingBytes(signatures[i], crypto_sign_ed25519_BYTES),
          data.begin(), data.size(),
          getUnderlyingBytes(keys[i], crypto_sign_ed25519_PUBLICKEYBYTES)) == 0) {
        context.warning(kj::str("key ", i, ": PASS"));
      } else {
        context.error(kj::str("key ", i, ": FAIL"));
      }
    }

    if (keys.size() < signatures.size()) {
      context.warning(kj::str(
          "signature has ", signatures.size() - keys.size(), " additional keys."));
    }

    context.exit();
  }

  kj::MainFunc getAddMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "Add a new key to <keyring>.")
        .expectArg("<keyring>", KJ_BIND_METHOD(*this, doAdd))
        .build();
  }

  kj::MainBuilder::Validity doAdd(kj::StringPtr arg) {
    if (access(arg.cStr(), F_OK) == 0) {
      // Verify that this keyring looks right.
      auto loadResult = loadKeyring(arg);
      if (loadResult.getError() != nullptr) return loadResult;
    }

    // Add a new key seed.
    byte random[crypto_sign_ed25519_SEEDBYTES];
    randombytes(random, sizeof(random));
    kj::FdOutputStream(raiiOpen(arg, O_WRONLY | O_APPEND | O_CREAT, 0600))
        .write(random, sizeof(random));

    // Generate the key
    byte publicKey[crypto_sign_ed25519_PUBLICKEYBYTES];
    byte secretKey[crypto_sign_ed25519_SECRETKEYBYTES];
    KJ_ASSERT(crypto_sign_ed25519_seed_keypair(publicKey, secretKey, random) == 0);

    // Write key.
    capnp::MallocMessageBuilder message;
    auto key = message.getRoot<PublicSigningKey>();
    memcpy(getUnderlyingBytes(kj::cp(key), sizeof(publicKey)), publicKey, sizeof(publicKey));
    printKey(key);
    context.exitInfo("*** Don't forget to back up the keyring! ***");
  }

  kj::MainFunc getListMain() {
    return kj::MainBuilder(context, "Sandstorm version " SANDSTORM_VERSION,
                           "List public keys for keys in <keyring>, or compiled keys if "
                           "<keyring> is not provided.")
        .expectOptionalArg("<keyring>", KJ_BIND_METHOD(*this, loadKeyring))
        .callAfterParsing(KJ_BIND_METHOD(*this, doList))
        .build();
  }

  kj::MainBuilder::Validity doList() {
    if (keyring == nullptr) {
      for (auto key: *UPDATE_PUBLIC_KEYS) printKey(key);
    } else {
      capnp::MallocMessageBuilder message;
      auto keys = message.getRoot<capnp::AnyPointer>()
          .initAs<capnp::List<PublicSigningKey>>(keyring.size());
      for (auto i: kj::indices(keyring)) {
        KJ_ASSERT(crypto_sign_ed25519_sk_to_pk(
            getUnderlyingBytes(keys[i], crypto_sign_ed25519_PUBLICKEYBYTES), keyring[i].key) == 0);
      }
      for (auto key: keys) printKey(key);
    }
    context.exit();
  }

private:
  kj::ProcessContext& context;

  struct PrivateKey {
    byte key[crypto_sign_ed25519_SECRETKEYBYTES];
  };
  kj::Array<PrivateKey> keyring;

  const byte* getUnderlyingBytes(capnp::AnyStruct::Reader reader, size_t size) {
    auto data = reader.getDataSection();
    KJ_REQUIRE(data.size() == size);
    return data.begin();
  }

  byte* getUnderlyingBytes(capnp::AnyStruct::Builder builder, size_t size) {
    auto data = builder.getDataSection();
    KJ_REQUIRE(data.size() == size);
    return data.begin();
  }

  void printKey(PublicSigningKey::Reader key) {
    auto str = kj::str("(key0 = 0x", kj::hex(key.getKey0()), ", "
                        "key1 = 0x", kj::hex(key.getKey1()), ", "
                        "key2 = 0x", kj::hex(key.getKey2()), ", "
                        "key3 = 0x", kj::hex(key.getKey3()), "),\n");
    kj::FdOutputStream(STDOUT_FILENO).write(str.begin(), str.size());
  }
};

}  // namespace sandstorm

KJ_MAIN(sandstorm::UpdateToolMain)
