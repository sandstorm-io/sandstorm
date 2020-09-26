// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2020 Sandstorm Development Group, Inc. and contributors
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

#ifndef SANDSTORM_APPINDEX_KEYBASE_H_
#define SANDSTORM_APPINDEX_KEYBASE_H_

#include <kj/string.h>
#include <capnp/serialize.h>
#include <sandstorm/api-session.capnp.h>
#include <sandstorm/app-index/keybase-api.capnp.h>
#include <sandstorm/app-index/app-index.capnp.h>

namespace sandstorm::appindex::keybase {

kj::String getPowerboxDescriptor();
// Return a base64-encoded, packed PowerboxDescriptor for the keybase API, for
// use by the client in making a powerbox request.

class Endpoint {
public:
  Endpoint(ApiSession::Client&& session);

  kj::Promise<kj::Maybe<kj::Own<capnp::MallocMessageBuilder>>> getFingerPrintIdentity(kj::StringPtr fingerprint);
  // Query the keybase API for the identity corresponding to the given pgp fingerprint.
  // Returns a message with a KeybaseIdentity as its root. If the keybase API returns
  // no results, this returns nullptr.
private:
  kj::Promise<kj::Own<LookupResults::Reader>> lookupFingerPrint(kj::StringPtr fingerprint);
  // Helper for getFingerPrintIdentity; returns the raw results from the keybase API.

  ApiSession::Client apiSession;
};

};

#endif
