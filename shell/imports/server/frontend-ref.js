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

import { checkRequirements } from "./persistent.js";

class FrontendRefRegistry {
  constructor() {
    this._restoreHandlers = {};
    this._queryHandlers = {};
    this._validateHandlers = {};
  }

  create(db, frontendRef, requirements) {
    // Construct a fresh capability based on a `frontendRef` value.

    checkRequirements(requirements);

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

  validate(db, session, mutableFrontendRef) {
    // Validates a powerbox request on the given `session` (a record from the Sessions table)
    // requesting the creation of the given frontendRef type. `mutableFrontendRef` is expected to
    // come directly from the client; calling validate() verifies that it has a valid type, and
    // may modify the value to add bits that need to be generated server-side. `validate()` also
    // returns an array of MembraneRequirements that shall apply to the capability. These
    // requirements will not yet have been checked, so the caller should check them before
    // proceeding.

    const keys = Object.keys(mutableFrontendRef);
    if (keys.length != 1) {
      throw new Error("invalid frontendRef: " + JSON.stringify(mutableFrontendRef));
    }

    const key = keys[0];
    const handler = this._validateHandlers[key];
    if (!handler) {
      throw new Error("invalid frontendRef: " + JSON.stringify(mutableFrontendRef));
    }

    return handler(db, session, mutableFrontendRef[key]);
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
    // * The returned `options` is an array of objects representing the options that should be
    //   offered to the user for this query. See the `powerboxOptions` Meteor publish in
    //   powerbox-server.js for a full description of the fields of each option.

    if (typeId in this._queryHandlers) {
      throw new Error("query handler already registered: " + typeId);
    }

    this._queryHandlers[typeId] = callback;
  }

  addValidateHandler(fieldName, callback) {
    // Registers a callback to validate creation of a new frontendRef of this type from a powerbox
    // request. The callback does not actually construct the capability, validates the frontendRef
    // (passed from the untrusted client), possibly modifying it, and also produces a list of
    // MembraneRequirements that should apply to the new capability.
    //
    // `fieldName` is the name of the field of `ApiTokens.frontendRef` which is filled in for this
    // ref type.
    //
    // `callback` is of type `(db, session, mutableValue) -> {descriptor, requirements}`, where:
    //     `mutableValue` is the value of the single field of `frontendRef` for this capability.
    //         If this is an object value, the callback may optionally modify it, e.g. adding
    //         additional fields that need to be generated server-side. The callback *must*, at
    //         the very least, type-check this value. It should throw an exception if the vaule is
    //         not valid.
    //     `session` is the record from the Sessions table of the UI session where the powerbox
    //         request occurred.
    //     `descriptor` (returned) is the JSON-encoded PowerboxDescriptor for the capability. Note
    //         that if the descriptor contains any `tag.value`s, they of course need to be
    //         presented as capnp-encoded Buffers.
    //     `requirements` (returned) is an array of MembraneRequirements which should apply to the
    //         new capability. Note that these requirements will be checked immediately and the
    //         powerbox request will fail if they aren't met.

    if (fieldName in this._validateHandlers) {
      throw new Error("restore handler already registered: " + fieldName);
    }

    this._validateHandlers[fieldName] = callback;
  }
}

export { FrontendRefRegistry };
