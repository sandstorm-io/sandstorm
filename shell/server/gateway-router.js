// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
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

const GatewayRouter = Capnp.importSystem("sandstorm/backend.capnp").GatewayRouter;
import { inMeteor, waitPromise } from "/imports/server/async-helpers.js";

currentTlsKeysCallback = null;

class GatewayRouterImpl {
  openUiSession(sessionCookie, params) {
    return getWebSessionForSessionId(sessionCookie, params);
  }

  subscribeTlsKeys(callback) {
    currentTlsKeysCallback = callback;

    return new Promise((resolve, reject) => {
      inMeteor(() => {
        function setKeys(key, certChain) {
          callback.setKeys(key, certChain).catch(err => {
            if (err.kjType === "disconnected") {
              // Client will reconnect.
              observer.stop();
              if (currentTlsKeysCallback == callback) {
                currentTlsKeysCallback = null;
              }
            } else {
              console.error("registering new TLS keys failed", err);
            }
          });
        }

        const observer = globalDb.collections.settings.find({_id: "tlsKeys"})
            .observe({
          added(keys) {
            setKeys(keys.value.key, keys.value.certChain);
          },

          changed(keys) {
            setKeys(keys.value.key, keys.value.certChain);
          }
        });
      });
    });
  }
}

makeGatewayRouter = function () {
  return new Capnp.Capability(new GatewayRouterImpl, GatewayRouter);
}
