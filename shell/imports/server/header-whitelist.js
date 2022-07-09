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

import Capnp from "/imports/server/capnp";
const WebSession = Capnp.importSystem("sandstorm/web-session.capnp").WebSession;

class HeaderWhitelist {
  constructor(list) {
    this._headers = {};
    this._prefixes = [];

    list.forEach(pattern => {
      if (pattern.endsWith("*")) {
        this._prefixes.push(pattern.slice(0, -1));
      } else {
        this._headers[pattern] = true;
      }
    });
  }

  matches(header) {
    header = header.toLowerCase();
    if (this._headers[header]) return true;

    for (const i in this._prefixes) {
      if (header.startsWith(this._prefixes[i])) {
        return true;
      }
    }

    return false;
  }
}

const REQUEST_HEADER_WHITELIST = new HeaderWhitelist(WebSession.Context.headerWhitelist);
const RESPONSE_HEADER_WHITELIST = new HeaderWhitelist(WebSession.Response.headerWhitelist);

export { HeaderWhitelist, REQUEST_HEADER_WHITELIST, RESPONSE_HEADER_WHITELIST };
