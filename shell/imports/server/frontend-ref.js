// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

class FrontendRefRegistry {
  constructor() {
    this._restoreHandlers = {};
    this._queryHandlers = {};
  }

  create(db, frontendRef, requirements) {
    // Construct a fresh capability based on a `frontendRef` value.

    const saveTemplate = { frontendRef };
    if (requirements) {
      saveTemplate.requirements = requirements;
    }

    return this.restore(db, saveTemplate, frontendRef);
  }

  restore(db, saveTemplate, frontendRef) {
    // Restores a frontendRef capability using the appropriate registered handler.

    const keys = Object.keys(frontendRef);
    if (keys.length != 1) {
      throw new Error("invalid frontendRef: " + JSON.stringify(frontendRef));
    }

    const key = keys[0];
    const handler = this._restoreHandlers[key];
    if (!handler) {
      throw new Error("invalid frontendRef: " + JSON.stringify(frontendRef));
    }

    return handler(db, saveTemplate, frontendRef[key]);
  }

  query(db, userAccountId, tag) {
    // Performs a powerbox query using the appropriate registered handler.

    const handler = this._queryHandlers[tag.id];
    if (handler) {
      return handler(db, userAccountId, tag.value);
    } else {
      return [];  // no matches
    }
  }

  addRestoreHandler(fieldName, callback) {
    // Registers a callback to use to restore frontendRef capabilities of this type.
    //
    // `fieldName` is the name of the field of `ApiTokens.frontendRef` which is filled in for this
    // ref type.
    //
    // `callback` is of type `(db, saveTemplate, value) -> capability`, where
    // `value` is the value of the single field of `ApiTokens.frontendRef` for this capability, and
    // `saveTemplate` is the token template to pass to the PersistentImpl constructor. The returned
    // object is a Cap'n Proto capability implementing SystemPersistent along with whatever other
    // interfaces are appropriate for the ref type.

    if (fieldName in this._restoreHandlers) {
      throw new Error("restore handler already registered: " + fieldName);
    }

    this._restoreHandlers[fieldName] = callback;
  }

  addQueryHandler(typeId, callback) {
    // Registers a callback to use to interpret a powerbox query for the given type ID.
    //
    // `typeId` is a stringified decimal 64-bit integer. (Stringification is needed as Javascript
    // numbers cannot represent 64-bit integers precisely.)
    //
    // `callback` is of type `(db, userAccountId, tagValue) -> options`.
    // * `tagValue` is a Buffer of the Cap'n-Proto-encoded `PowerboxDescriptor.Tag.value`.
    // * The returned `options` is an array of `PowerboxOption` objects representing the options
    //   that should be offered to the user for this query.

    if (typeId in this._queryHandlers) {
      throw new Error("query handler already registered: " + typeId);
    }

    this._queryHandlers[typeId] = callback;
  }
}

export { FrontendRefRegistry };
