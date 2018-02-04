// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2018 Sandstorm Development Group, Inc. and contributors
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

#pragma once

#include "util.h"
#include <kj/compat/tls.h>

namespace sandstorm {

kj::Promise<void> proxySmtp(
    kj::TlsContext& tls, kj::Own<kj::AsyncIoStream> client, kj::NetworkAddress& server);

}  // namespace sandstorm
