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

#ifndef SANDSTORM_SPK_H_
#define SANDSTORM_SPK_H_

#include "abstract-main.h"
#include <fcntl.h>
#include <sys/types.h>
#include <sandstorm/package.capnp.h>

namespace sandstorm {

kj::Own<AbstractMain> getSpkMain(kj::ProcessContext& context);

kj::String unpackSpk(int spkfd, kj::StringPtr outdir, kj::StringPtr tmpdir);
// Read an SPK from `spkfd` placing all of the files in `outdir`. A (large) temporary file
// will be written (and then deleted) in the directory `tmpdir`. The procedure returns the verified
// app ID, or throws an exception before writing any output if the signature was not valid.

void verifySpk(int spkfd, int tmpfile, spk::VerifiedInfo::Builder output);
// Temporarily uncompress the spk, check its signature, and fill in `output` with relevant info.

kj::Maybe<kj::String> checkPgpSignature(kj::StringPtr appIdString, spk::Metadata::Reader metadata,
                                        kj::Maybe<uid_t> sandboxUid = nullptr);
// Checks that the PGP signature embedded in the given package metadata matches the given app ID,
// and returns the PGP key fingerprint. Returns null if there is no signature. Throws if there is
// an invalid signature.

}  // namespace sandstorm

#endif  // SANDSTORM_SPK_H_
