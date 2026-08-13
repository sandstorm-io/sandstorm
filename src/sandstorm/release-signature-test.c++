// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm Contributors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

#include "release-signature.h"
#include "util.h"

#include <cstdlib>
#include <kj/encoding.h>
#include <kj/test.h>

namespace sandstorm {
namespace {

const char KEY_A_FINGERPRINT[] = "0C7ABBD86D03E47FCA986BFD409CBAA847617B62";
const char KEY_B_FINGERPRINT[] = "9DDBF2A14EA98D3B47C29A4596AFFBD130FEC761";

const char DATA[] = "c2lnbmVkIHVwZGF0ZSBmaXh0dXJlCg==";
const char KEY_A[] =
    "mQENBGp9NpUBCADD6RkGI664oIggSkxtgQTCHIcdkOr3lITThK2nMQ8A02+uiHW+R72/g6edIghfa/vS"
    "sEuZoWYrMknHoNZJlegW7QlwBOGPIYhBBXindDxYUvh0rP4+El27WJUWd/izEV6w8jg+388luGnpzTg"
    "b2jP0pmjNMy1cjLtQCtlzvoMW+rqFZMDNQvR9s1u4VuN0bpzx6vdE74FnmlpYxPuWq2/536uuMbdta"
    "YxutOHl27ZYTvOk/3C6sOsnAGO38YIngSoMfDK/M6FwMKYQqQvgLAl0/QpJmJ4slppyOdqxc5/t3SEz"
    "H8nZhNngNm4A4Ld0kqBOnn3wv+nwSnXWjr2auRulABEBAAG0G1NhbmRzdG9ybSB1cGRhdGUgdGVzdCBr"
    "ZXkgQYkBVAQTAQoAPhYhBAx6u9htA+R/yphr/UCcuqhHYXtiBQJqfTaVAhsDBQkAAVGABQsJCAcCBhUK"
    "CQgLAgQWAgMBAh4BAheAAAoJEECcuqhHYXtiQA8IAJ2rMCP9ysJ5vZQo73yU2fNkcof8q6UBEr3PM54H"
    "fbDw6Rhbk1gutfXEk2uXsiF8AzzXBP7Bo69nAthxvCh9QXrnmYcEXmnnegK8AzHs8VsoeD3KrT/LNDxT"
    "jeb35B/Hfk68+TqhSgpJylFruPxn1Y/DMCY4DAJHMAJt4tstGDBmX2dwESPB/pz4iQRDp/X/vCTLCTxW"
    "cEk/LaQOoq262aabfguwtuibaRBnzNFugg+W5mcAM0qEBGfTTzUnAfpPTSiMX3QqJeue7h34PNz5tk8Q"
    "Tlf1HaxRXEX4LXJvSJLzErmm0SHEUVTdlqESKlQZWwHNfL4UXtGt9zsMFDtz0rQ=";
const char KEY_B[] =
    "mQENBGp9NpUBCADpFN7AHer/VsD0nyd6ZPhS8vxBjOHQbF7LXSbrX7w+hY6/SHyOZIQxMkxxuqxY4wK"
    "X7Oy5UU8SBtaigbAjVPj5YQMsTG/3ubeOkwS3731mApFY0GvPZk9m+oerqOHwbbvQQKsofwBbNC3P5x5"
    "uD2r/JhFod/QqRBlGEfpVUrIKBITgXj3XEVCQdDKhoezlnGD7Ym2ZPljmhz4cNZEDR+xHwz6TfmprS/+"
    "Q/6g3SLxE4zHSpRKuNMd2cpM8rjv9hIXAugiXNIoZA+XmNoZTVtr6inhc/6hqkfhO0SEeAgYZIVkaAMq"
    "sLRi+IE3KzFxoOcrCbJIXzfdPMJMpiWou9dI3ABEBAAG0G1NhbmRzdG9ybSB1cGRhdGUgdGVzdCBrZXkg"
    "QokBVAQTAQoAPhYhBJ3b8qFOqY07R8KaRZav+9Ew/sdhBQJqfTaVAhsDBQkAAVGABQsJCAcCBhUKCQgL"
    "AgQWAgMBAh4BAheAAAoJEJav+9Ew/sdh280H/jcLWMoIi8ZaTheLZYnOwqf8pmcHxZTkXmJ1ZIbIMuEx/"
    "OXrA3A0t1+ZiCLB9g8MIeSXVIde717E7aox9kb6UwLwq7ZknwgoJU6RCPXdeMx7hAFLBe5/bNDO9QDI4"
    "NPCSKjd5Uc742vVtOsHxob2J3Fid2frayshvVZhjdKbaDALvG+3nrZtjoejdY0KNsO2AEuuI0aJA95Kow"
    "m8QjX3yQjy5u9CMKAuDxeGP7rBPnmMIBW4OC4yw0BXnYaIMHfZ6FzbJadGcaa0+aZwQEVOqg+pRH4COk"
    "0uQRDPGbmG5hKF5DTMZVUmJgpXtLwYs3YBfQPGH/SFCxFQkk/CM72rGNU=";
const char SIGNATURE_A[] =
    "iQEzBAABCgAdFiEEDHq72G0D5H/KmGv9QJy6qEdhe2IFAmp9NpYACgkQQJy6qEdhe2ICVQgAt2OZDMo8"
    "eYGENGYVpKL/UqIFP4cOavqVfbNbsjxLxIjWf5TX/fPQBcTLfSql5tAOJWrvebTTIUEAZO9sMiHfz7bEw"
    "sjR7CMSfHp24/zWppoOVzxMZCpUPaNkwaNhRjlA9VPqT4nUPqqJIrYSMMiAJy4rTm7ti+peZPKFD9UlCL"
    "DvKY+MoJhVeGLne+L359imNNPn6npX6kG4Ck+SkfkuYbiXz20aIH2TZoNhRv+Zg0tYBiIBHZTVnRGZ8Lm"
    "usw+W9J/an05piXWGegYNypak8xLeW5aV3Mkkpwn+oBZV/xl/nKJKLPTVzl8gU+zshZC/qMjycG9bZje"
    "qmZrheFEH8g==";
const char SIGNATURE_B[] =
    "iQEzBAABCgAdFiEEndvyoU6pjTtHwppFlq/70TD+x2EFAmp9NpYACgkQlq/70TD+x2GI+gf+JJ1i9LcJ"
    "WJQ1hdc04EvJ7XW/3QTMycLZav+0b4NAHBfrUEnAGX1Jrl33y/hFjueRN1HLqgwqJRCm3uxRveGDXNsd"
    "KWLzmqFmlpcqZ10o8LgapGuBGCebkRUVhchzY2dTZ8b8YKs/NcYWIy8M+tw2spQrLbSiHPWMDUWui9+c"
    "AmqdQBKGV/vuBysAdz+BG6PdMNTsC0F+dAmZUyT1UBUXuY8AGgDGk+0SbRH6B9sBcUbcz7+KAQbef8vX"
    "99AbTIg7BJlM1bnNYnN6kaUNX+Og90wS/kGeVDjS2XK4QBqIlbgX+gizOk3KdRwXIzovs+y0Olgnm6gw"
    "TnWRrL4LZgOJPQ==";

void writeBase64(kj::StringPtr path, kj::StringPtr encoded) {
  auto decoded = kj::decodeBase64(encoded.asArray());
  KJ_REQUIRE(!decoded.hadErrors);
  kj::FdOutputStream(raiiOpen(path, O_WRONLY | O_CREAT | O_TRUNC, 0600))
      .write(decoded.begin(), decoded.size());
}

void appendBase64(kj::StringPtr path, kj::StringPtr encoded) {
  auto decoded = kj::decodeBase64(encoded.asArray());
  KJ_REQUIRE(!decoded.hadErrors);
  kj::FdOutputStream(raiiOpen(path, O_WRONLY | O_APPEND))
      .write(decoded.begin(), decoded.size());
}

struct Fixture {
  Fixture() {
    char pathTemplate[] = "/tmp/sandstorm-release-signature-test.XXXXXX";
    KJ_REQUIRE(mkdtemp(pathTemplate) != nullptr);
    path = kj::str(pathTemplate);

    writeBase64(kj::str(path, "/data"), DATA);
    writeBase64(kj::str(path, "/key-a.gpg"), KEY_A);
    writeBase64(kj::str(path, "/key-b.gpg"), KEY_B);
    writeBase64(kj::str(path, "/a.sig"), SIGNATURE_A);
    writeBase64(kj::str(path, "/b.sig"), SIGNATURE_B);
    writeBase64(kj::str(path, "/dual-ab.sig"), SIGNATURE_A);
    appendBase64(kj::str(path, "/dual-ab.sig"), SIGNATURE_B);
    writeBase64(kj::str(path, "/dual-ba.sig"), SIGNATURE_B);
    appendBase64(kj::str(path, "/dual-ba.sig"), SIGNATURE_A);
  }

  ~Fixture() noexcept(false) {
    recursivelyDelete(path);
  }

  void verify(kj::StringPtr signature, kj::StringPtr keyring, kj::StringPtr fingerprint) {
    auto signatureFd = raiiOpen(kj::str(path, "/", signature), O_RDONLY);
    auto dataFd = raiiOpen(kj::str(path, "/data"), O_RDONLY);
    verifyReleaseSignature(signatureFd, dataFd, "/usr/bin/gpg",
        kj::str(path, "/", keyring), fingerprint);
  }

  kj::String path;
};

KJ_TEST("parse release-signature status by primary fingerprint") {
  auto status = kj::str(
      "[GNUPG:] NEWSIG\n"
      "[GNUPG:] GOODSIG SIGNINGSUBKEY Sandstorm release key\n"
      "[GNUPG:] VALIDSIG SIGNINGSUBKEY 2026-08-12 0 0 4 0 1 10 00 ",
      KEY_A_FINGERPRINT, "\n");
  KJ_EXPECT(hasValidReleaseSignature(status.asArray(), KEY_A_FINGERPRINT));
  KJ_EXPECT(!hasValidReleaseSignature(status.asArray(), KEY_B_FINGERPRINT));

  auto missingPrimaryFingerprint = kj::str(
      "[GNUPG:] NEWSIG\n"
      "[GNUPG:] GOODSIG SIGNINGSUBKEY Sandstorm release key\n"
      "[GNUPG:] VALIDSIG SIGNINGSUBKEY 2026-08-12 0 0 4 0 1 10 00\n");
  KJ_EXPECT(!hasValidReleaseSignature(
      missingPrimaryFingerprint.asArray(), KEY_A_FINGERPRINT));
}

KJ_TEST("reject expired and revoked release-signature status") {
  for (auto failure: {kj::StringPtr("EXPKEYSIG"), kj::StringPtr("REVKEYSIG")}) {
    auto status = kj::str(
        "[GNUPG:] NEWSIG\n"
        "[GNUPG:] ", failure, " SIGNINGSUBKEY Sandstorm release key\n"
        "[GNUPG:] VALIDSIG SIGNINGSUBKEY 2026-08-12 0 0 4 0 1 10 00 ",
        KEY_A_FINGERPRINT, "\n");
    KJ_EXPECT(!hasValidReleaseSignature(status.asArray(), KEY_A_FINGERPRINT), failure);
  }
}

KJ_TEST("reject a release signature using the wrong hash or signature class") {
  for (auto algorithms: {
      kj::StringPtr("1 8 00"),   // SHA-256 rather than the release process's SHA-512.
      kj::StringPtr("1 10 01")  // Text rather than a binary-document signature.
  }) {
    auto status = kj::str(
        "[GNUPG:] NEWSIG\n"
        "[GNUPG:] GOODSIG SIGNINGSUBKEY Sandstorm release key\n"
        "[GNUPG:] VALIDSIG SIGNINGSUBKEY 2026-08-12 0 0 4 0 ", algorithms, " ",
        KEY_A_FINGERPRINT, "\n");
    KJ_EXPECT(!hasValidReleaseSignature(status.asArray(), KEY_A_FINGERPRINT), algorithms);
  }
}

KJ_TEST("verify a release signature with packaged GnuPG semantics") {
  Fixture fixture;

  fixture.verify("a.sig", "key-a.gpg", KEY_A_FINGERPRINT);
  KJ_EXPECT_THROW_MESSAGE("expected key",
      fixture.verify("b.sig", "key-a.gpg", KEY_A_FINGERPRINT));
}

KJ_TEST("verify either known signer in a dual-signed release") {
  Fixture fixture;

  fixture.verify("dual-ab.sig", "key-a.gpg", KEY_A_FINGERPRINT);
  fixture.verify("dual-ab.sig", "key-b.gpg", KEY_B_FINGERPRINT);
  fixture.verify("dual-ba.sig", "key-a.gpg", KEY_A_FINGERPRINT);
  fixture.verify("dual-ba.sig", "key-b.gpg", KEY_B_FINGERPRINT);
}

KJ_TEST("reject a release signature over different bytes") {
  Fixture fixture;
  kj::FdOutputStream(raiiOpen(kj::str(fixture.path, "/data"), O_WRONLY | O_TRUNC))
      .write("modified\n", 9);

  KJ_EXPECT_THROW_MESSAGE("expected key",
      fixture.verify("a.sig", "key-a.gpg", KEY_A_FINGERPRINT));
}

}  // namespace
}  // namespace sandstorm
