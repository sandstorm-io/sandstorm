// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014-2016 Sandstorm Development Group, Inc. and contributors
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

const Capnp = Npm.require("capnp");
const Url = Npm.require("url");
const StaticAsset = Capnp.importSystem("sandstorm/grain.capnp").StaticAsset;

const PROTOCOL = Url.parse(process.env.ROOT_URL).protocol;

class StaticAssetImpl {
  constructor(assetId) {
    check(assetId, String);
    this._protocol = PROTOCOL.slice(0, -1);
    this._hostPath = makeWildcardHost("static") + "/" + assetId;
  }

  getUrl() {
    return { protocol: this._protocol, hostPath: this._hostPath, };
  }
};

class IdenticonStaticAssetImpl {
  constructor(hash, size) {
    check(hash, String);
    check(size, Match.Integer);
    this._protocol = PROTOCOL.slice(0, -1);
    this._hostPath =  makeWildcardHost("static") + "/identicon/" + hash + "?s=" + size;
  }

  getUrl() {
    return { protocol: this._protocol, hostPath: this._hostPath, };
  }
};

export { StaticAssetImpl, IdenticonStaticAssetImpl };
