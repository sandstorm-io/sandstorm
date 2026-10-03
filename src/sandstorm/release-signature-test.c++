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

// Test-only RSA signing keys have no expiration. Keys and SHA-512 signatures were generated
// with GnuPG at the fixed timestamp 2020-01-01 so verification does not depend on the test date.
// Only public keys and signatures are retained; the private keys are discarded.
const char KEY_A_FINGERPRINT[] = "AD69F92B7329436FF4F36F8BBC4A7BB73F26E428";
const char KEY_B_FINGERPRINT[] = "AA022527C38341362A7E517F5572AD51D6C5734F";

const char DATA[] = "c2lnbmVkIHVwZGF0ZSBmaXh0dXJlCg==";
const char KEY_A[] =
    "mQENBF4L4QABCACQWSp338ZaN45sv4XNs+44hDeD6j0s5qqAw1n9qoHzZFDjH3Zey9kCvIpZy+LwTMua"
    "j/2fr7tqo912CjO/8tSjMZfx33BiQG3mW+GqTOm1Wqau7dUCMiRX7tGGjlT4exmF+yMF2kgl5/5GipXN"
    "+83SF9DbXzh1sJiRn50GwBEBxW8szogW0ZUjGff1zWNyOw7YEm8iGPvnDXN47LjuxZEBpsvsbmpqY7Ey"
    "a93KixRdlcfz+RFzjIFw1Ee3hEovRlQmr1rxNRwwtqiOGhO4xByvgYX9DzQzkV9XBY2FNA/0i/y+lfxn"
    "OH3s9wHS6Afx0BdT2Brri1+DgHz+SSpvITXTABEBAAG0G1NhbmRzdG9ybSB1cGRhdGUgdGVzdCBrZXkg"
    "QYkBTgQTAQoAOBYhBK1p+StzKUNv9PNvi7xKe7c/JuQoBQJeC+EAAhsDBQsJCAcCBhUKCQgLAgQWAgMB"
    "Ah4BAheAAAoJELxKe7c/JuQofH4IAIUsdPnM39WH7UdYwZoBURED9uxg+lYBg/fAbtsSamgJUAL62hq1"
    "HwJ+eBECe27Z7a6MvKNLEFmEPiX+3BCnWS9FGmMy4bs0sykm1RcfmWZVUnzWTfUlTYCBEjQZpkLUZQiM"
    "w/smgFeJNL1i3mT5MKNyk8PUCAeh1D1ut7SYEbOIOaZgFAJh5VJz0TCUxFxvcqavuGyAlxfO1nkyewDH"
    "BFdxCqe+D76k1LYwAqRiL4VA5hmp1SR/sWsLaN5VB/F0WUtfVxtjHNTyDHvgVJgFfu1q4w8vFEKdzi8h"
    "m+5+4/hjScwjEHy0KUT7pzQpF8x4X9kg7EuKO8Rv66JVBmu/mzs=";
const char KEY_B[] =
    "mQENBF4L4QABCADKGlhmQVfYLXi7asRQViemOsmv6mN2Z5BJVcbGi0hqweD7g2xQz8OAxJiKPnimtQNN"
    "Pyfes1e9xcDvtMihNcg6ebWRLAEnL+5SVRzySCSREJVStTXH0g/z7ieVT9/62tyRwU8mU15+Ggvd/WpV"
    "gzwpVOhOt0L4fT7DmuXsgy+93F0pMvzqnGRGN6gSXhpCFt+x7JPbrIUvTjQ4OJV70LQfdqrPSiaqdDuG"
    "p+YsKKWPtog97EmeSI+k34O9mIoMbObjTA2vm4+tnZrs7CqTCYLuyLddifv/1qJc66dqJ3KDKxeX7fKo"
    "6aTyUX00JoVVRERaHrK72evzMrsaayaeZVEZABEBAAG0G1NhbmRzdG9ybSB1cGRhdGUgdGVzdCBrZXkg"
    "QokBTgQTAQoAOBYhBKoCJSfDg0E2Kn5Rf1VyrVHWxXNPBQJeC+EAAhsDBQsJCAcCBhUKCQgLAgQWAgMB"
    "Ah4BAheAAAoJEFVyrVHWxXNPzxMIAJ5nL7F+BBm7QeLdmt+5gElRIYOTz3+/26a5fEqmfefWIQN1XO+L"
    "89+ARGn3Xwqtb47nCQFN615l+TUrthOgt0WU77hs8V4C/Dvl8TlqQXzcoE7gH9cyGFXPJb8+dzo793dp"
    "jrLKwqCvzFdNxqK2gNwnNKUBnrl2Cw3IM80HA7IArYTa88RatEG6ANxfRrYtMQHkjXwBPoiv3r2ZChhg"
    "gq2jwkYC+1/pfQ5YvIPeYdwwuB3tUZ9Xjek1ApDmca9AO76zFP1KKVIcvaFr/mQyxeW6ZYpVGczfqetx"
    "/fp4SNSzxQ9RW5atvGxNSLwXr1reC2K9nOfa1AZnG1hL0lZQcWY=";
const char SIGNATURE_A[] =
    "iQEzBAABCgAdFiEErWn5K3MpQ2/082+LvEp7tz8m5CgFAl4L4QAACgkQvEp7tz8m5Ch9UQf+OfG5k6UD"
    "33bn+E3G1oi8X6xJY47pdt0VrvSwqsgqJ+AxY1Wz5p1/21lk2YaBiZO7WCTOL19VyTdlPEX1nwHadNvR"
    "8zPGy+ft/cgi6PyG2gRu0bVi/sAxIeJddNlt6zGNkxtRb/a7G3QM9mrdPy4KrcFJIANqBQXg6N6F0P72"
    "am13I4nX79n77RGfYztPv61f8WL9XDx5PJBI8ZKK0iUrlRGAVKeK+VAPohcsq9YgwFkJ1Vr94n75Mmui"
    "zSApEDwOSkEZt6f8IyyerSpNlm0O7doUPJbB38REXSvP8N+iYR4T+5imAPq9u7jcmHk9hS7KV0z2/zw/"
    "K7qqD4eZ9G6Rpg==";
const char SIGNATURE_B[] =
    "iQEzBAABCgAdFiEEqgIlJ8ODQTYqflF/VXKtUdbFc08FAl4L4QAACgkQVXKtUdbFc0/L5Qf+IWMNhtDM"
    "2nZPcjUoFHgzy/vUFH7Vfo00n+C0knL1JSCuUZDpGxgER6eUSy26Gif1we6RLyQysA46VcMrcsVUjgFp"
    "1qzg1Dc6mJyv83rE+AbMQ1dz1Sg7u7kmT6W618bk/pbYDOmdIlyOcCXttqA9v5RxWSMpMPHhrxAHSwbp"
    "4JpYUAfj43dN/cE7pTQodsMB8BkJE84xbxC+edT5Yan7pDQnVd3/XdZ8nt2GP0WFoYU/CiEeTyY2IX7I"
    "rouyib/BEpedFRVYD5Ju+KbN/eMC6H96BHA7L6hE/U3WJckLr8IeDdqkv+v5tPY9jyCFdX0j9BUJdJqP"
    "Y2zh86GGx67ONQ==";

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
