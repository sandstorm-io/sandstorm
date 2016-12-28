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

const Crypto = Npm.require("crypto");
const Capnp = Npm.require("capnp");
const Powerbox = Capnp.importSystem("sandstorm/powerbox.capnp");
const Grain = Capnp.importSystem("sandstorm/grain.capnp");

// TODO(cleanup): lift this out of a package so it can share with async-helpers.js
const Future = Npm.require("fibers/future");
const promiseToFuture = (promise) => {
  const result = new Future();
  promise.then(result.return.bind(result), result.throw.bind(result));
  return result;
};

const waitPromise = (promise) => {
  return promiseToFuture(promise).wait();
};

function encodePowerboxDescriptor(desc) {
  return Capnp.serializePacked(Powerbox.PowerboxDescriptor, desc)
              .toString("base64")
              .replace(/\+/g, "-")
              .replace(/\//g, "_");
}

Meteor.methods({
  newFrontendRef(sessionId, frontendRefRequest) {
    // Completes a powerbox request for a frontendRef capability.
    check(sessionId, String);
    // frontendRefRequest is type-checked by frontendRefRegistry.validate(), below.

    const db = this.connection.sandstormDb;
    const frontendRefRegistry = this.connection.frontendRefRegistry;

    const session = db.collections.sessions.findOne(
        { _id: sessionId, userId: this.userId || { $exists: false } });
    if (!session) {
      throw new Meteor.Error(403, "Invalid session ID");
    }

    let { descriptor, requirements, frontendRef } =
        frontendRefRegistry.validate(db, session, frontendRefRequest);
    descriptor = encodePowerboxDescriptor(descriptor);

    const grainId = session.grainId;
    const apiTokenOwner = {
      clientPowerboxRequest: {
        grainId: grainId,
        sessionId: session._id,
      },
    };

    const cap = frontendRefRegistry.create(db, frontendRef, requirements);
    const sturdyRef = waitPromise(cap.save(apiTokenOwner)).sturdyRef.toString();
    cap.close();
    return { sturdyRef, descriptor };
  },

  fulfillUiViewRequest(sessionId, identityId, grainId, petname, roleAssignment, ownerGrainId) {
    const db = this.connection.sandstormDb;
    check(sessionId, String);
    check(identityId, String);
    check(grainId, String);
    check(roleAssignment, db.roleAssignmentPattern);
    check(petname, String);
    check(ownerGrainId, String);

    if (!this.userId || !db.userHasIdentity(this.userId, identityId)) {
      throw new Meteor.Error(403, "Not an identity of the current user: " + identityId);
    }

    const provider = {
      identityId,
      accountId: this.userId,
    };

    const title = db.userGrainTitle(grainId, this.userId, identityId);

    const descriptor = encodePowerboxDescriptor({
      tags: [
        { id: Grain.UiView.typeId,
          value: Capnp.serialize(Grain.UiView.PowerboxTag, { title }),
        },
      ],
    });

    const owner = {
      clientPowerboxRequest: {
        grainId: ownerGrainId,
        sessionId: sessionId,
      },
    };

    const result = SandstormPermissions.createNewApiToken(
        db, provider, grainId, petname, roleAssignment, owner);

    return {
      sturdyRef: result.token,
      descriptor,
    };
  },
});

class PowerboxOption {
  constructor(fields) {
    _.extend(this, fields);
  }

  intersect(other) {
    // Intersect two options with the same ID. Used when combining matches from multiple tags
    // in the same descriptor. The tags are a conjunction.
    //
    // Returns true if there was any overlap, or false if there was no overlap and therefore the
    // option should be dropped.
    //
    // TODO(cleanup): How do we factor out the type-specific logic through FrontendRefRegistry?

    if (other._id != this._id) {
      throw new Error("can only merge options with the same ID");
    }

    if (other.grainId) {
      if (this.uiView && !other.uiView) delete this.uiView;
      if (this.hostedObject && !other.hostedObject) delete this.hostedObject;
      return !!(this.uiView || this.hostedObject);
    } else if ((this.frontendRef || {}).verifiedEmail) {
      // Try to hint which verifierId matched.
      if (this.frontendRef.verifiedEmail.verifierId) {
        if (other.frontendRef.verifiedEmail.verifierId) {
          // Can't match multiple verifiers at once.
          return false;
        }
      } else if (other.frontendRef.verifiedEmail.verifierId) {
        // One request did not specify any verifierId, the other did, and both matched, so use
        // the verifierId.
        this.frontendRef.verifiedEmail.verifierId = other.frontendRef.verifiedEmail.verifierId;
      }

      return true;
    } else {
      // No intersection logic needed for other types.
      return true;
    }
  }

  union(other) {
    // Union two options with the same ID. Used when combining matches from multiple descriptors.
    // The descriptors are a disjunction.
    //
    // TODO(cleanup): How do we factor out the type-specific logic through FrontendRefRegistry?

    if (other._id != this._id) {
      throw new Error("can only merge options with the same ID");
    }

    if (other.grainId) {
      if (!this.uiView && other.uiView) this.uiView = other.uiView;
      if (!this.hostedObject && other.hostedObject) this.hostedObject = other.hostedObject;
    } else if ((this.frontendRef || {}).verifiedEmail) {
      // If this doesn't have a verifierId but other does, copy it over.
      if (!this.frontendRef.verifiedEmail.verifierId &&
          other.frontendRef.verifiedEmail.verifierId) {
        this.frontendRef.verifiedEmail.verifierId = other.frontendRef.verifiedEmail.verifierId;
      }
    }
  }

  subtract(other) {
    // Remove `other` from this. Used when `other` is a match deemed unacceptable. Returns true
    // if there's anything left, false otherwise.

    if (other._id != this._id) {
      throw new Error("can only merge options with the same ID");
    }

    if (other.grainId) {
      if (this.uiView && other.uiView) delete this.uiView;
      if (this.hostedObject && other.hostedObject) delete this.hostedObject;
      return !!(this.uiView || this.hostedObject);
    } else {
      return false;
    }
  }
}

function registerUiViewQueryHandler(frontendRefRegistry) {
  // TODO(cleanup): Maybe this belongs in a different file? But where?

  frontendRefRegistry.register({
    typeId: Grain.UiView.typeId,

    query(db, userId, value) {
      if (!userId) return [];

      // TODO(someday): Allow `value` to specify app IDs to filter for.

      const sharedGrainIds = db.userApiTokens(userId).map(token => token.grainId);
      const ownedGrainIds = db.userGrains(userId).map(grain => grain._id);

      return _.uniq(sharedGrainIds.concat(ownedGrainIds)).map(grainId => {
        return new PowerboxOption({
          _id: "grain-" + grainId,
          grainId: grainId,
          uiView: {},
          cardTemplate: "grainPowerboxCard",
          configureTemplate: "uiViewPowerboxConfiguration",
        });
      });
    },
  });
}

Meteor.publish("powerboxOptions", function (requestId, descriptorList) {
  // Performs a powerbox query, returning options to present to the user in the powerbox.
  // `descriptorList` is an array of `PowerboxDescriptor`s, each individually serialized in
  // packed format and base64-encoded. The publish populates a pseudo-collection called
  // `powerboxOptions`. Each item has the following fields:
  //
  //   _id: Unique identifier string.
  //      TODO(soon): This ID string is often a human-readable name like "frontendref-ipinterface"
  //        and is only guaranteed to be unique because we currently don't allow a client to have
  //        multiple powerbox requests active at the same time. We should strengthen this uniqueness
  //        guarentee, possibly by incorporating `requestId`. Note, however, that Meteor requires `_id`
  //        to be either a string or an `ObjectID`.
  //   requestId: The value of `requestId` that was passed in when subscribing.
  //   matchQuality: "preferred" or "acceptable" ("unacceptable" options aren't returned).
  //   frontendRef: If present, selecting this option means creating a simple frontendRef. The
  //       field value should be passed back to the method `newFrontendRef` verbatim. The format
  //       of the field is the same as ApiTokens.frontendRef.
  //   grainId: If present, this option selects a grain to satisfy the request. One or both of
  //       `uiView` and `hostedObject` will be present. Mutually exclusive with `frontendRef`.
  //   uiView: If present, this option creates a UiView for a grain. The UI should allow the user
  //       to choose a role to grant. Only present when `grainId` is also present. `uiView` is an
  //       object with the fields:
  //     TODO(someday): Some sort of indication of what options the powerbox should give the user
  //         as far as which permissions to grant? Unclear if any app would ever want to specify
  //         permissions when requesting a plain UiView.
  //   hostedObject: If present, this grain advertises that it publishes capabilities that might
  //       match the query. If selected, a request session to the grain embedded should be shown
  //       embedded in the powerbox and the same request should be passed to it. Only present when
  //       `grainId` is also present. `hostedObject`, when present, is (for now) an empty object.
  //   cardTemplate: Names the client-side template to use to display this powerbox option. The
  //       template's data context will be a "card" object as returned by
  //       SandstormPowerboxRequest.filteredCardData(). Also, the template definition (in client
  //       code) may have a static method `powerboxIconSrc` which takes the card as a parameter
  //       and returns the URL of the icon to display next to the option.
  //   configureTemplate: If selecting this option should then show a further dialog, names the
  //       client-side template for that dialog.
  //   ...: Other fields may be added for consumption by the client-side template.

  check(requestId, String);
  check(descriptorList, [String]);

  const results = {};
  const db = this.connection.sandstormDb;
  const frontendRefRegistry = this.connection.frontendRefRegistry;

  if (descriptorList.length > 0) {
    const descriptorMatches = descriptorList.map(packedDescriptor => {
      // Decode the descriptor.
      // TODO(now): Also single-segment? Canonical?

      // Note: Node's base64 decoder also accepts URL-safe base64, so no need to translate.
      const queryDescriptor = Capnp.parse(
          Powerbox.PowerboxDescriptor,
          new Buffer(packedDescriptor, "base64"),
          { packed: true });

      if (!queryDescriptor.tags || queryDescriptor.tags.length === 0) return {};

      // Expand each tag into a match map.
      const tagMatches = queryDescriptor.tags.map(tag => {
        const result = {};

        frontendRefRegistry.query(db, this.userId, tag).forEach(option => {
          result[option._id] = new PowerboxOption(option);
        });

        return result;
      });

      // Intersect two tags' matches.
      const matches = tagMatches.reduce((a, b) => {
        for (const id in a) {
          if (id in b) {
            if (!a[id].intersect(b[id])) {
              // Empty intersection.
              delete a[id];
            }
          } else {
            // This match only exists in a, not b, so delete it.
            delete a[id];
          }
        }

        return a;
      });

      // Search among the user's grains for hosted objects that match.

      if (this.userId) {
        const user = Meteor.users.findOne(this.userId);

        // Find all grains shared to this user.
        const sharedGrainIds = db.userApiTokens(this.userId).map(token => token.grainId);

        // Among all grains owned by the user or shared with the user, search for grains having
        // any powerbox tag IDs matching the tag IDs in the query.
        db.collections.grains
            .find({
              $or: [{ userId: this.userId }, { _id: { $in: sharedGrainIds } }],
              "cachedViewInfo.matchRequests.tags.id":
                  { $in: queryDescriptor.tags.map(tag => tag.id) },
            }, { fields: { "cachedViewInfo.matchRequests": 1 } })
            .forEach(grain => {
          // Filter down to grains that actually have a matching descriptor.
          let alreadyMatched = false;
          grain.cachedViewInfo.matchRequests.forEach(grainDescriptor => {
            if (alreadyMatched) return;

            // Build map of descriptor tags by ID.
            const grainTagsById = {};
            grainDescriptor.tags.forEach(tag => {
              grainTagsById[tag.id] = tag.value;
            });

            let allMatched = true;
            queryDescriptor.tags.forEach(queryTag => {
              if (!allMatched) return;

              if (queryTag.id in grainTagsById) {
                const value = grainTagsById[queryTag.id];
                // Null values match everything, so only pay attention if non-null.
                if (value && queryTag.value) {
                  if (!Capnp.matchPowerboxQuery(queryTag.value, value)) {
                    allMatched = false;
                  }
                }
              } else {
                allMatched = false;
              }
            });

            if (allMatched) {
              alreadyMatched = true;
              const option = new PowerboxOption({
                _id: "grain-" + grain._id,
                grainId: grain._id,
                hostedObject: {},
                cardTemplate: "grainPowerboxCard",
                configureTemplate: "uiViewPowerboxConfiguration",  // TODO(cleanup): rename
              });
              if (option._id in matches) {
                matches[option._id].union(option);
              } else {
                matches[option._id] = option;
              }
            }
          });
        });
      }

      return { descriptor: queryDescriptor, matches };
    });

    // TODO(someday): The implementation of matchQuality here is not quite right. In theory, we're
    //   supposed to compare descriptors to determine which ones are more specific than which
    //   others, and prefer the most-specific match. For now, though, I've implemented a heuristic:
    //   consider each descriptor in order. If it is "unacceptable", have it cancel out any
    //   matches seen previously. Otherwise, take the maximum match quality. This will usually
    //   produce the same results as long as "unacceptable" descriptors are placed last in the
    //   list.

    const matches = descriptorMatches.reduce((finalMatches, clause) => {
      if (clause.matchQuality === "unacceptable") {
        // Remove b's matches from a.
        for (const id in clause.matches) {
          if (id in finalMatches) {
            if (!finalMatches[id].subtract(clause.matches[id])) {
              delete finalMatches[id];
            }
          }
        }

        return finalMatches;
      } else {
        for (const id in clause.matches) {
          if (id in finalMatches) {
            finalMatches[id].union(clause.matches[id]);
          } else {
            finalMatches[id] = clause.matches[id];
          }

          if (clause.matchQuality === "preferred") {
            finalMatches[id].matchQuality = "preferred";
          }
        }

        return finalMatches;
      }
    }, {});

    for (const id in matches) {
      if (!matches[id].matchQuality) {
        matches[id].matchQuality = "acceptable";
      }

      matches[id].requestId = requestId;
      this.added("powerboxOptions", id, matches[id]);
    }
  }

  // TODO(someday): Make reactive? Seems annoying.

  this.ready();
});

SandstormPowerbox = { registerUiViewQueryHandler };
