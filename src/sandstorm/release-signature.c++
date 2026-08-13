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

#include <cerrno>
#include <cstdlib>
#include <sys/stat.h>
#include <sys/wait.h>

namespace sandstorm {

bool hasValidReleaseSignature(
    kj::ArrayPtr<const char> gpgStatus, kj::StringPtr expectedPrimaryFingerprint) {
  constexpr size_t HASH_ALGORITHM_WORD = 9;
  constexpr size_t SIGNATURE_CLASS_WORD = 10;
  constexpr size_t PRIMARY_FINGERPRINT_WORD = 11;

  bool currentSignatureIsGood = false;

  for (auto statusLine: split(gpgStatus, '\n')) {
    auto words = splitSpace(statusLine);
    if (words.size() < 2 || words[0] != kj::StringPtr("[GNUPG:]")) continue;

    if (words[1] == kj::StringPtr("NEWSIG")) {
      currentSignatureIsGood = false;
    } else if (words[1] == kj::StringPtr("GOODSIG")) {
      currentSignatureIsGood = true;
    } else if (words[1] == kj::StringPtr("EXPSIG") ||
               words[1] == kj::StringPtr("EXPKEYSIG") ||
               words[1] == kj::StringPtr("REVKEYSIG") ||
               words[1] == kj::StringPtr("BADSIG") ||
               words[1] == kj::StringPtr("ERRSIG")) {
      currentSignatureIsGood = false;
    } else if (currentSignatureIsGood && words.size() > PRIMARY_FINGERPRINT_WORD &&
               words[1] == kj::StringPtr("VALIDSIG") &&
               words[HASH_ALGORITHM_WORD] == kj::StringPtr("10") &&
               words[SIGNATURE_CLASS_WORD] == kj::StringPtr("00")) {
      // For OpenPGP signatures, VALIDSIG's last field is the primary-key fingerprint (or repeats
      // the signing fingerprint when the primary key signed directly). Hash algorithm 10 is
      // SHA-512, as required by release.sh, and signature class 00 is a detached binary document.
      if (words[PRIMARY_FINGERPRINT_WORD] == expectedPrimaryFingerprint) return true;
    }
  }

  return false;
}

void verifyReleaseSignature(
    int signatureFd, int bundleFd, kj::StringPtr gpgPath, kj::StringPtr keyringPath,
    kj::StringPtr expectedPrimaryFingerprint, kj::StringPtr libraryPath) {
  struct stat signatureStats;
  KJ_SYSCALL(fstat(signatureFd, &signatureStats));
  KJ_REQUIRE(S_ISREG(signatureStats.st_mode), "release signature is not a regular file");
  KJ_REQUIRE(signatureStats.st_size <= MAX_RELEASE_SIGNATURE_SIZE,
      "release signature is unreasonably large", signatureStats.st_size);

  KJ_SYSCALL(lseek(signatureFd, 0, SEEK_SET));
  KJ_SYSCALL(lseek(bundleFd, 0, SEEK_SET));

  char homeTemplate[] = "/tmp/sandstorm-update-gpg.XXXXXX";
  KJ_REQUIRE(mkdtemp(homeTemplate) != nullptr, "could not create temporary GnuPG home", errno);
  KJ_DEFER(recursivelyDelete(homeTemplate));

  auto nullFd = raiiOpen("/dev/null", O_RDONLY | O_CLOEXEC);
  auto statusPipe = Pipe::make();
  int moreFds[] = {statusPipe.writeEnd.get(), signatureFd, bundleFd};

  kj::String homedirArg = kj::str("--homedir=", homeTemplate);
  kj::String keyringArg = kj::str("--keyring=", keyringPath);
  kj::StringPtr argv[] = {
    gpgPath,
    "--no-options",
    "--no-tty",
    homedirArg,
    "--no-default-keyring",
    keyringArg,
    "--no-auto-key-retrieve",
    "--status-fd=3",
    "--verify",
    "/proc/self/fd/4",
    "/proc/self/fd/5",
  };

  kj::Vector<kj::String> ownedEnvironment;
  ownedEnvironment.add(kj::str("LANG=C"));
  ownedEnvironment.add(kj::str("PATH=/usr/bin:/bin"));
  if (libraryPath != nullptr) {
    ownedEnvironment.add(kj::str("LD_LIBRARY_PATH=", libraryPath));
  }

  kj::Vector<kj::StringPtr> environment;
  for (auto& value: ownedEnvironment) environment.add(value);

  Subprocess::Options options(argv);
  options.searchPath = false;
  // Omitting --batch makes GnuPG versions before 2.4.6 process every signature. Keep the command
  // non-interactive by disabling the TTY and connecting stdin to /dev/null.
  options.stdin = nullFd;
  options.moreFds = moreFds;
  options.environment = environment.asPtr();
  Subprocess gpg(kj::mv(options));

  statusPipe.writeEnd = nullptr;
  auto status = readAll(statusPipe.readEnd);
  int waitStatus = gpg.waitForExitOrSignal();

  KJ_REQUIRE(WIFEXITED(waitStatus), "GnuPG was terminated while checking the release signature");

  // A dual-signed file normally makes GnuPG return non-zero when this client's keyring does not
  // contain the other signer's key. The dedicated status channel is authoritative: a GOODSIG plus
  // VALIDSIG for our pinned fingerprint proves that the exact bundle bytes were signed by the
  // expected, non-expired, non-revoked key.
  KJ_REQUIRE(hasValidReleaseSignature(status.asArray(), expectedPrimaryFingerprint),
      "release does not contain a valid signature from the expected key",
      expectedPrimaryFingerprint, WEXITSTATUS(waitStatus));
}

}  // namespace sandstorm
