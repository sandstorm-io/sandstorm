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

import { inMeteor, waitPromise } from "/imports/server/async-helpers";
import { createAcmeAccount, renewCertificateNow } from "/imports/server/acme";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";

import Capnp from "/imports/server/capnp";
const ShellCli = Capnp.importSystem("sandstorm/backend.capnp").ShellCli;

class ShellCliImpl {
  createAcmeAccount(directory, email, agreeToTerms) {
    return inMeteor(() => {
      createAcmeAccount(directory, email, agreeToTerms);
    });
  }

  setAcmeChallenge(module, options) {
    return inMeteor(() => {
      options = SandstormDb.escapeMongoObject(JSON.parse(options));
      globalDb.collections.settings.upsert({_id: "acmeChallenge"},
          {$set: { value: { module, options } }});
    });
  }

  renewCertificateNow() {
    return inMeteor(() => {
      renewCertificateNow();
    });
  }
}

export function makeShellCli() {
  return new Capnp.Capability(new ShellCliImpl, ShellCli);
}
