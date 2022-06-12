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

import { checkRequirements } from "./persistent";

class FrontendRefRegistry {
  constructor() {
    this._frontendRefHandlers = {};
    this._typeIdHandlers = {};
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
    const handler = this._frontendRefHandlers[key];
    if (!handler) {
      throw new Error("invalid frontendRef: " + JSON.stringify(frontendRef));
    }

    return handler.restore(db, saveTemplate, frontendRef[key]);
  }

  query(db, userAccountId, tag) {
    // Performs a powerbox query using the appropriate registered handler.

    const handler = this._typeIdHandlers[tag.id];
    if (handler) {
      return handler.query(db, userAccountId, tag.value);
    } else {
      return [];  // no matches
    }
  }

  validate(db, session, frontendRefRequest) {
    // Validates a powerbox request on the given `session` (a record from the Sessions table)
    // requesting the creation of the given frontendRef type. `frontendRefRequest` is expected to
    // come directly from the client; calling validate() verifies that it is well-formed and
    // carries out any type-specific server-side work needed to construct the desired frontendRef.
    // `validate()` also returns an array of MembraneRequirements that shall apply to the
    // capability. These requirements will not yet have been checked, so the caller should check
    // them before proceeding.

    const keys = Object.keys(frontendRefRequest);
    if (keys.length != 1) {
      throw new Error("invalid frontendRefRequest: " + JSON.stringify(frontendRefRequest));
    }

    const key = keys[0];
    const handler = this._frontendRefHandlers[key];
    if (!handler) {
      throw new Error("invalid frontendRefRequest: " + JSON.stringify(frontendRefRequest));
    }

    if (!handler.validate) {
      throw new Error("frontendRef type cannot be created via powerbox: " +
                      JSON.stringify(frontendRefRequest));
    }

    const { descriptor, requirements, frontendRef } =
          handler.validate(db, session, frontendRefRequest[key]);

    const result = { descriptor, requirements, frontendRef: {}, };
    result.frontendRef[key] = frontendRef;
    return result;
  }

  register(object) {
    // Register callbacks related to a particular frontendRef type. The object has the fields:
    //   `frontendRefField`: Name of the field of `ApiTokens.frontendRef` that is filled in for
    //       this type. Only needed if `create` and/or `validate` handlers are defined.
    //   `typeId`: Type ID of powerbox tags handled by the `query` callback. Stringified decimal
    //       64-bit integer. Only needed if `query` is defined.
    //   `restore`: Callback to construct a capability of this type when restoring a saved
    //       capability. Has signature `(db, saveTemplate, value) -> capability`, where:
    //     `value`: The value of the single field of `ApiTokens.frontendRef` for this capability.
    //     `saveTemplate`: The token template to pass to the PersistentImpl constructor.
    //     `capability` (returned): A Cap'n Proto capability implementing SystemPersistent along
    //         with whatever other interfaces are appropriate for the ref type.
    //   `validate`: Callback to validate a powerbox request for a new capability of this type.
    //       Has signature `(db, session, request) -> {descriptor, requirements, frontendRef}`,
    //       where:
    //     `request` is type-specific information describing the requested capability. The
    //         callback *must* type-check this value, and should throw an exception if it is
    //         not valid.
    //     `session` is the record from the Sessions table of the UI session where the powerbox
    //         request occurred.
    //     `descriptor` (returned) is the JSON-encoded PowerboxDescriptor for the capability. Note
    //         that if the descriptor contains any `tag.value`s, they of course need to be
    //         presented as capnp-encoded Buffers.
    //     `requirements` (returned) is an array of MembraneRequirements which should apply to the
    //         new capability. Note that these requirements will be checked immediately and the
    //         powerbox request will fail if they aren't met.
    //     `frontendRef` (returned) is the value that will be written for the key specified
    //         by `frontendRefField` in the single-key object `ApiTokens.frontendRef`.
    //    `query`: Callback to populate options for a powerbox request for this type ID. Has
    //        signature `(db, userAccountId, tagValue) -> options`, where:
    //      `tagValue`: A Buffer of the Cap'n-Proto-encoded `PowerboxDescriptor.Tag.value`.
    //      `options` (returned): An array of objects representing the options that should be
    //          offered to the user for this query. See the `powerboxOptions` Meteor publish in
    //          powerbox-server.js for a full description of the fields of each option.

    if (object.frontendRefField) {
      if (object.frontendRefField in this._frontendRefHandlers) {
        throw new Error("frontendRef handler already registered: " + object.frontendRefField);
      }

      this._frontendRefHandlers[object.frontendRefField] = object;
    }

    if (object.typeId) {
      if (object.typeId in this._typeIdHandlers) {
        throw new Error("typeId handler already registered: " + object.typeId);
      }

      this._typeIdHandlers[object.typeId] = object;
    }
  }
}

export { FrontendRefRegistry };
