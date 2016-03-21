// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

SandstormPermissions = {};

class PermissionSet {
  // A wrapper around an array of booleans representing a set of permissions like "read" or
  // "write". This might represent the permissions held by some user on some grain, or it might
  // represent the permissions that one user has chosen to share with another user.
  //
  // In our model, permissions are independent. You can have "read" without "write" and you can
  // have "write" without "read". Many apps don't actually allow arbitrary permutations, and
  // instead define "roles" like "editor" or "viewer", where "editor" implies both read and write
  // permission while "viewer" implies only read. Roles, however, are just aliases for sets of
  // permissions; all actual computation is done on permissions.

  constructor(array) {
    if (!array) {
      this.array = [];
    } else if (array instanceof Array) {
      this.array = array.slice(0);
    } else {
      throw new Error("don't know how to interpret as PermissionSet: " + array);
    }
  }

  static fromRoleAssignment(roleAssignment, viewInfo) {
    // Create a PermissionSet based on a ViewSharingLink.RoleAssignment and a UiView.ViewInfo (as
    // defined in grain.capnp). ViewInfo defines a mapping from roles to permission sets for a
    // particular grain type. RoleAssignment represents the permissions passed from one user to
    // another -- usually it specifies a single role, but sometimes also specifies permissions to
    // add or remove as well.
    //
    // A falsy value for `roleAssignment` is considered equivalent to a "none" value, which means
    // that no role was explicitly chosen, so the default role should be assigned.

    let result = new PermissionSet([]);

    if (!roleAssignment || "none" in roleAssignment) {
      // No role explicitly chosen, e.g. because the app did not define any roles at the time
      // the sharing took place. Assign the default role, if there is one.

      if (viewInfo.roles) {
        for (let ii = 0; ii < viewInfo.roles.length; ++ii) {
          const roleDef = viewInfo.roles[ii];
          if (roleDef.default) {
            result = new PermissionSet(roleDef.permissions);
            break;
          }
        }
      }
    } else if ("allAccess" in roleAssignment) {
      // All permissions are shared, even if there is no explicitly-defined role for this.

      let length = 0;
      if (viewInfo.permissions) {
        length = viewInfo.permissions.length;
      }

      const array = new Array(length);
      for (let ii = 0; ii < array.length; ++ii) {
        array[ii] = true;
      }

      result = new PermissionSet(array);
    } else if ("roleId" in roleAssignment && viewInfo.roles && viewInfo.roles.length > 0) {
      // A specific role was chosen.

      const roleDef = viewInfo.roles[roleAssignment.roleId];
      if (roleDef) {
        result = new PermissionSet(roleDef.permissions);
      }
    }

    if (roleAssignment) {
      // Add or remove specific permissions. This is uncommon.
      result.add(new PermissionSet(roleAssignment.addPermissionSet));
      result.remove(new PermissionSet(roleAssignment.removePermissionSet));
    }

    return result;
  }

  hash() {
    // See the comment for RequirementSet.hash().

    const hasher = Crypto.createHash("sha256");
    this.updateHasher(hasher);
    return hasher.digest("hex");
  }

  updateHasher(hasher) {
    hasher.update("(");
    for (let i = 0; i < this.array.length; ++i) {
      if (this.array[i]) {
        hasher.update("" + i + ",");
      }
    }

    hasher.update(")");
  }

  isEmpty() {
    let result = true;
    this.array.forEach((p) => {
      if (p) {
        result = false;
      }
    });

    return result;
  }

  isSubsetOf(other) {
    check(other, PermissionSet);
    for (let ii = 0; ii < this.array.length; ++ii) {
      const mine = this.array[ii];
      const yours = other.array[ii] || false;
      if (mine && !yours) {
        return false;
      }
    }

    return true;
  }

  // Methods for mutating a PermissionSet by combining it with another PermissionSet.
  // These return a boolean indicating whether the operation had any effect.

  add(other) {
    check(other, PermissionSet);
    let changed = false;
    for (let ii = 0; ii < other.array.length; ++ii) {
      const old = !!this.array[ii];
      this.array[ii] = !!this.array[ii] || other.array[ii];
      if (old !== this.array[ii]) {
        changed = true;
      }
    }

    return changed;
  }

  remove(other) {
    check(other, PermissionSet);
    let changed = false;
    for (let ii = 0; ii < other.array.length && ii < this.array.length; ++ii) {
      const old = !!this.array[ii];
      this.array[ii] = !!this.array[ii] && !other.array[ii];
      if (old !== this.array[ii]) {
        changed = true;
      }
    }

    return changed;
  }

  intersect(other) {
    check(other, PermissionSet);
    let changed = false;
    for (let ii = 0; ii < this.array.length; ++ii) {
      const old = !!this.array[ii];
      this.array[ii] = !!this.array[ii] && other.array[ii];
      if (old !== this.array[ii]) {
        changed = true;
      }
    }

    return changed;
  }
}

class RequirementSet {
  // A conjunction of permissions for identities on grains.
  //
  // This typcially represents a list of `MembraneRequirement`s, as defined in `supervisor.capnp`.
  // These represent conditions under which some connection formed between grains remains valid.
  // When a capability travels from grain to grain, it passes across these connections -- if any
  // of the connections becomes invalid (is revoked), then the capability must be revoked as well.
  // The word "membrane" comes from the concept of revokable membranes; the capability is passing
  // across such membranes as it travels.
  //
  // For example, a clause might represent the statement "Alice has read access to Foo, Bob has
  // write access to Foo, and Bob has read access to Bar". Specifically, this example situation
  // would come about if:
  // - Bob used his read access to Bar to extract a capability from it.
  // - Bob embedded that capability into Foo, using his write access.
  // - Alice extracted the capability from Foo, using her read access.
  // If any of these permissions are revoked, then the capability needs to be revoked as well.

  constructor() {
    this.identityPermissions = {};
    // Two-level map. Maps a pair of a grain ID and an identity ID to a PermissionSet.
  }

  hash() {
    // It is often useful to form sets of clauses. This method returns a hash that is suitable to
    // be used as a key for such a set.
    //
    // TODO(perf): Investigate other approaches. We do not need this hash to be cryptographically
    //   opaque, but we do need it to avoid collisions. Maybe we should instead represent
    //   sets of clauses as ordered maps, or maybe as proper hash maps with bucketing?
    //   Note that a representation that allows for efficient matching by subset or superset would
    //   be useful for some computations marked with TODO(perf) later in this file, but I'm not
    //   sure what such a representation would look like.
    const hasher = Crypto.createHash("sha256");
    Object.keys(this.identityPermissions).sort().forEach((grainId) => {
      hasher.update(grainId + "{");
      Object.keys(this.identityPermissions[grainId]).sort().forEach((identityId) => {
        hasher.update(identityId);
        this.identityPermissions[grainId][identityId].updateHasher(hasher);
      });

      hasher.update("}");
    });

    return hasher.digest("hex");
  }

  isEmpty() {
    for (const grainId in this.identityPermissions) {
      if (Object.keys(this.identityPermissions[grainId]).length > 0) {
        return false;
      }
    }

    return true;
  }

  addMembraneRequirements(membraneRequirements) {
    // Updates this clause to include the permissions required by `membraneRequirements`, which
    // is a decoded Cap'n Proto List(MembraneRequirement).

    if (!membraneRequirements) return;
    membraneRequirements.forEach((requirement) => {
      if (requirement.permissionsHeld) {
        const grainId = requirement.permissionsHeld.grainId;
        const identityId = requirement.permissionsHeld.identityId;
        const permissions = new PermissionSet(requirement.permissionsHeld.permissions);
        this._ensureEntryExists(grainId, identityId);
        this.identityPermissions[grainId][identityId].add(permissions);
      } else {
        throw new Error("unsupported membrane requirement: " + JSON.toString(requirement));
      }
    });
  }

  _ensureEntryExists(grainId, identityId) {
    check(grainId, String);
    check(identityId, String);

    if (!this.identityPermissions[grainId]) {
      this.identityPermissions[grainId] = {};
    }

    if (!this.identityPermissions[grainId][identityId]) {
      this.identityPermissions[grainId][identityId] = new PermissionSet([]);
    }
  }

  popFirstGoal() {
    // Returns the first (grain, identity) -> PermissionSet obligation that we need to prove
    // in order to prove that this clause holds, and drops that obligation from this clause.

    if (this.isEmpty()) {
      throw new Error("popFirstGoal() called on empty clause");
    }

    const grainId = Object.keys(this.identityPermissions).sort()[0];
    const identityId = Object.keys(this.identityPermissions[grainId]).sort()[0];

    const permissions = this.identityPermissions[grainId][identityId];

    delete this.identityPermissions[grainId][identityId];
    if (Object.keys(this.identityPermissions[grainId]).length == 0) {
      delete this.identityPermissions[grainId];
    }

    return { vertex: { grain: { _id: grainId, identityId: identityId } },
             permissions: permissions, };
  }

  conjoin(other) {
    // Updates this clause to include the permissions contained in `other`.
    check(other, RequirementSet);

    for (let grainId in other.identityPermissions) {
      for (let identityId in other.identityPermissions[grainId]) {
        let otherPermissions = other.identityPermissions[grainId][identityId];
        this._ensureEntryExists(grainId, identityId);
        this.identityPermissions[grainId][identityId].add(otherPermissions);
      }
    }
  }
}

class ConditionalPermissionSet {
  // A PermissionSet that is contingent upon some requirements.

  constructor(permissions, requirements) {
    check(permissions, PermissionSet);
    check(requirements, RequirementSet);
    this.permissions = permissions;
    this.requirements = requirements;
    this.tokensUsed = {}; // Token IDs for the tokens that these permissions depend upon.
  }

  static fromToken(token, viewInfo) {
    // A token is an edge in the sharing graph, propagating some permissions P from vertex A
    // to vertex B, perhaps conditioned on some membrane requirements M. This function constructs
    // a ConditionalPermissionSet from a token, taking into account the permissions P and the
    // membrane requirements M. The result does not carry any information about the vertices
    // A and B, even though the input `token` may contain information about them, for example
    // in the `parentToken` field.

    const permissions = PermissionSet.fromRoleAssignment(token.roleAssignment, viewInfo);
    const result = new ConditionalPermissionSet(permissions, new RequirementSet());
    result.requirements.addMembraneRequirements(token.requirements);
    result.tokensUsed[token._id] = true;
    return result;
  }

  clone() {
    // Returns a deep copy of `this`.
    const result = new ConditionalPermissionSet(new PermissionSet(), new RequirementSet());
    result.permissions.add(this.permissions);
    result.requirements.conjoin(this.requirements);
    result.tokensUsed = _.clone(this.tokensUsed);
    return result;
  }

  sequence(other) {
    // Updates this ConditionalPermissionSet to apply `other` in sequence.
    //
    // That is, given two edges in the sharing graph, each represented by a ConditionalPermissionSet,
    // we are unifying them into a single edge, by intersecting both the requirements and the
    // permissions granted.
    //
    // TODO(cleanup): Consider renaming to `join()`?

    check(other, ConditionalPermissionSet);
    this.permissions.intersect(other.permissions);
    this.requirements.conjoin(other.requirements);
    for (const tokenId in other.tokensUsed) {
      this.tokensUsed[tokenId] = true;
    }
  }
}

// pseudo-class PermissionFlow
//
// A PermissionFlow is an object whose keys are RequirementSet.hash()es and whose values are
// ConditionalPermissionSets.
//
// A PermissionFlow represents the permissions flowing from one vertex in the sharing graph to
// another (e.g. between one user and another), possibly across multiple edges (in series and/or
// parallel). This is not simply a PermissionSet because some permissions may be conditional.
// Instead, PermissionFlow is a set of ConditionalPermissionSets; that is, a set of pairs of
// PermissionSets and requirements for said permissions to be granted.

class Context {
  // Cached database state for use during permissions computations.

  constructor() {
    this.grains = {};            // Map from grain ID to entry in Grains table.
    this.userIdentityIds = {};   // Map from user ID to list of identity IDs.
    this.tokensById = {};        // Map from token ID to token.
    this.tokensByRecipient = {}; // Map from grain ID and identity ID to token array.
  }

  addToken(token) {
    check(token, Match.ObjectIncluding({ grainId: String }));
    this.tokensById[token._id] = token;
    if (token.owner && token.owner.user) {
      if (!this.tokensByRecipient[token.grainId]) {
        this.tokensByRecipient[token.grainId] = {};
      }

      if (!this.tokensByRecipient[token.grainId][token.owner.user.identityId]) {
        this.tokensByRecipient[token.grainId][token.owner.user.identityId] = [];
      }

      this.tokensByRecipient[token.grainId][token.owner.user.identityId].push(token);
    }
  }

  addGrain(db, grainId) {
    check(db, SandstormDb);
    check(grainId, String);
    const grain = db.getGrain(grainId);
    this.grains[grainId] = grain;

    this.userIdentityIds[grain.userId] = SandstormDb.getUserIdentityIds(
      Meteor.users.findOne({ _id: grain.userId }));

    const query = { grainId: grainId, revoked: { $ne: true }, objectId: { $exists: false } };
    db.collections.apiTokens.find(query).forEach((token) => this.addToken(token));
  }

  addTokensFromCursor(cursor) {
    cursor.forEach((token) => this.addToken(token));
  }
}

const vertexPattern = Match.OneOf({ token: Match.ObjectIncluding({ _id: String, grainId: String }) },
                                  { grain: Match.ObjectIncluding(
                                    { _id: String,
                                     identityId: Match.OneOf(String, null, undefined), }), });
// A vertex in the sharing graph is a principal, e.g. a user (identity) or a token. Complicating
// matters, we may have to traverse sharing graphs for multiple grains in the same computation. A
// token is specific to one grain, but a user of course can have access to multiple grains, so in
// the case of a user we represent the vertex as a (user, grain) pair.
//
// TODO(cleanup): Perhaps `grain` should be renamed to `user` or `identity`? In the common case
//   where only a single grain's shares need to be considered, it feels weird to think of the
//   grain ID as being the primary distinguishing feature of the vertex.

function computePermissionFlowToVertex(context, vertex, permissionSet, viewInfo) {
  // Computes the flow of the permissions in `permissionSet` from the grain owner to `vertex`.
  // Returns a PermissionFlow representing all permissions flowing into the vertex.
  //
  // That is to say, this computes the permissions held by a particular user or token (`vertex`)
  // by traversing the sharing graph. The results may be conditional -- we compute permissions
  // held under varying sets of conditions, and return a map of condition -> permissions. The
  // caller may need to check if the conditions hold in order to compute the final permissions.
  //
  // For the purpose of the call, we only consider permissions in `permissionSet`; we won't bother
  // following edges that aren't relevant to this set.
  //
  // `viewInfo` is the grain's `UiView.ViewInfo`, which maps roles to permissions.
  //
  // `context` contains all the information from the database which is available for now. This call
  // will not make any new database lookups; edges not listed in `context` will not be considered
  // (as if they'd been revoked).
  //
  // Note that we perform the graph traversal "backwards": We start from the destination vertex
  // and search towards the grain owner. The reason we do this is because with typical sharing
  // graphs, this allows us to avoid considering much of the graph. Sharing graphs typically
  // involve lots of "fan out", so if we searched down from the owner we would end up touching
  // many irrelevant leaf nodes, whereas searching up from the destination avoids this.

  check(context, Context);
  check(vertex, vertexPattern);
  check(permissionSet, PermissionSet);

  const grainId = vertex.token ? vertex.token.grainId : vertex.grain._id;
  const grain = context.grains[grainId];
  const ownerIdentityIds = context.userIdentityIds[grain.userId];

  // A vertex ID is a string encoding of a vertex. It is of the form "i:<identityId>",
  // "t:<tokenId>", or "o:Owner".
  const destinationId = vertex.token ? ("t:" + vertex.token._id) : ("i:" + vertex.grain.identityId);
  const destinationPermissions = {};
  {
    // Initialize the destination in permissionsMap (see below) to indicate that all permissions
    // flow from it to the destination (i.e. to itself) unconditionally. We need this to start
    // our search.
    const clause = new RequirementSet();
    destinationPermissions[clause.hash()] = new ConditionalPermissionSet(permissionSet, clause);
  }

  const permissionsMap = {};
  // Map<vertexId, PermissionFlow>.
  // Map from vertex ID to permissions that we've already shown flow from that vertex to our
  // destination vertex.
  //
  // Careful, this is a bit brain-bending. The map tells us which permissions the given vertex
  // *intends* to share to the destination, but this does not mean that the source vertex actually
  // has those permissions to share! E.g. Alice may share read-write access to Bob, Bob might
  // reshare that access to Carol, and then Alice might retroactively reduce Bob's access to
  // read-only. The flow from Bob to Carol is still read-write, but the flow from Alice to Carol
  // (through Bob) is read-only, because no write permission ever flows to Bob.

  const vertexStack = []; // Vertex IDs that we need to explore.

  permissionsMap[destinationId] = destinationPermissions;
  vertexStack.push(destinationId);

  // Repeatedly pop a vertex from the stack, find all its incoming edges (i.e. all other vertexes
  // that share permissions to this vertex), determine what permissions might flow from those
  // to the destination, and push those vertexes onto the stack.
  while (vertexStack.length > 0) {
    const vertexId = vertexStack.pop();

    let incomingEdges = [];
    // List of edges in the sharing graph ending at this vertex. Each edge is an object of two
    // fields:
    // sharerId: The vertex ID of the edge's source.
    // conditionalPermissions: ConditionalPermissionSet representing the permissions flowing over this
    //     edge and the conditions restricting that permission flow.

    function tokenToEdge(token) {
      // Convert an ApiToken into an edge.
      return {
        sharerId: token.parentToken ? "t:" + token.parentToken : "i:" + token.identityId,
        conditionalPermissions: ConditionalPermissionSet.fromToken(token, viewInfo),
      };
    }

    if (vertexId.slice(0, 2) === "o:") {
      // Owner. We don't need to do anything.
      incomingEdges = [];
    } else if (vertexId.slice(0, 2) === "t:") {
      // A token. Extract it from the context (or ignore if it isn't present).
      const token = context.tokensById[vertexId.slice(2)];
      if (token) {
        incomingEdges = [tokenToEdge(token)];
      }
    } else if (vertexId.slice(0, 2) === "i:") {
      // An identity.
      if (ownerIdentityIds.indexOf(vertexId.slice(2)) >= 0) {
        // This is one of the owner's identities.
        const p = new ConditionalPermissionSet(PermissionSet.fromRoleAssignment({ allAccess: null },
                                                                              viewInfo),
                                             new RequirementSet());
        incomingEdges = [{ sharerId: "o:Owner", conditionalPermissions: p }];
      } else if (!grain.private) {
        // This is a legacy "public" grain, meaning that any user who knows the grain ID receives
        // the grain's default role. If the user doesn't know the grain ID then they are unable
        // to express a request to open the grain in the first place and we'll never get to the
        // point of this permissions computation, so for this purpose we can assume all users
        // have the default role. (Similarly, a user who doesn't know the grain ID couldn't
        // possibly be the subject of any MembraneRequirements against the grain because they
        // have never interacted with the grain and so couldn't have caused such
        // MembraneRequiments to come about. Note that this is kind of shaky non-local reasoning,
        // but literally no such legacy grain has been created since early 2015 and none will ever
        // be created again, so it's not a huge deal.)
        const p = new ConditionalPermissionSet(PermissionSet.fromRoleAssignment({ none: null },
                                                                              viewInfo),
                                             new RequirementSet());
        incomingEdges = [{ sharerId: "o:Owner", conditionalPermissions: p }];
      } else {
        // Not a special case. Gather all tokens where this user is the recipient.
        incomingEdges = ((context.tokensByRecipient[grainId] || {})[vertexId.slice(2)] || [])
          .map(tokenToEdge);
      }
    } else {
      throw new Meteor.Error(500, "Unrecognized vertex ID: " + vertexId);
    }

    // For each edge incoming to this vertex, bacgkpropagate this vertex's PermissionFlow to the
    // source vertex, joining it with the edge's constraints.
    incomingEdges.forEach((edge) => {
      const sharerId = edge.sharerId;
      let needToPush = false;
      // For each ConditionalPermissionSet in permissionsMap[vertexId],
      // apply edge.conditionalPermissions in sequence, in order to create a PermissionFlow
      // representing the flow through this edge to the final destination.
      const sequenced = {};  // A PermissionFlow.
      for (const clauseHash in permissionsMap[vertexId]) {
        const newPermissions = edge.conditionalPermissions.clone();
        newPermissions.sequence(permissionsMap[vertexId][clauseHash]);
        const newHash = newPermissions.requirements.hash();
        if (sequenced[newHash]) {
          // Adding the new requirements of this edge to the variour requirements of vertexId's
          // PermissionFlow caused two of the components to collide. For example, maybe vertexId's
          // PermissionFlow had "read unconditionally" and "write if Alice has write on Foo", while
          // the new edge we're adding itself has the requirement "Alice has write on Foo",
          // therefore now both the read and write parts have this requirement, so we union them
          // into one PermissionSet.
          //
          // TODO(perf): An exact match between clauses is really only one case where items in a
          //   PermissionFlow might interact. If one clause is a superset of another then the
          //   superset clause is strictly only true when the subset clause is also true; in this
          //   case we ought to remove the subset's permissions from the superset's PermissionSet
          //   because it would be redundant to search for the same permission under both sets of
          //   requirements. The most important case of this is the empty clause: if a permission
          //   flows unconditionally, then we shouldn't bother finding out if it also flows
          //   conditionally. Detecting and removing these redundancies could reduce the size of
          //   the PermissionFlow, which would both speed up backpropagation and help us avoid
          //   doing unnecessary requirements checks later.
          sequenced[newHash].permissions.add(newPermissions.permissions);
          for (tokenId in newPermissions.tokensUsed) {
            // We merge the "tokens used" sets. Technically this isn't quite right, because this
            // means we're saying the tokens from both paths were used, but in fact in may be the
            // case that only the tokens from one path or the other are ultimately needed. Tracking
            // this distinction probably requires too much bookkeeping to be worthwhile.
            // TODO(perf): Could be worth studying further if we find that we're grossly
            //   overestimating the set of tokens needed to prove a permission.
            sequenced[newHash].tokensUsed[tokenId] = true;
          }
        } else {
          sequenced[newHash] = newPermissions;
        }
      };

      // Optimization: we don't care about permissions that we've already proven the opener has
      // (with the same conditions). So, remove those from the flow.
      //
      // TODO(perf): Similar to above, we could detect subset clauses here. If we already know that
      //   a permission flows from the owner under requirement X, then we also know that in flows
      //   under requirement "X and Y". Most importantly, if a permission flows from the owner
      //   unconditionally, then there's no reason to check if it also flows conditionally.
      if (permissionsMap["o:Owner"]) {
        for (const hashedClause in permissionsMap["o:Owner"]) {
          const conditionalPermissionSet = permissionsMap["o:Owner"][hashedClause];
          if (hashedClause in sequenced) {
            const smps = sequenced[hashedClause];
            smps.permissions.remove(conditionalPermissionSet.permissions);
            if (smps.permissions.isEmpty()) {
              delete sequenced[hashedClause];
            }
          }
        }
      }

      if (!permissionsMap[sharerId]) {
        // Never saw this vertex before.
        permissionsMap[sharerId] = sequenced;
        needToPush = true;
      } else {
        // Vertex has been seen previously. Merge new PermissionFlow into it. If there are any
        // changes, then we'll need to visit the vertex again.
        for (const clauseHash in sequenced) {
          const mp = permissionsMap[sharerId][clauseHash];
          if (mp && mp.permissions.add(sequenced[clauseHash].permissions)) {
            for (tokenId in sequenced[clauseHash].tokensUsed) {
              mp.tokensUsed[tokenId] = true;
            }

            needToPush = true;
          } else if (!mp) {
            permissionsMap[sharerId][clauseHash] = sequenced[clauseHash];
            needToPush = true;
          }
        }

        // TODO(perf): We may have set needToPush true when `sharerId` is already on `vertexStack`.
        //   This means we'll redundantly double-visit it. That's not terrible but we could
        //   probably avoid it easily?
      }

      if (needToPush) {
        vertexStack.push(sharerId);
      }
    });
  }

  return permissionsMap["o:Owner"] || {};
}

function findAllMinimalCovers(permissionSets, desiredPermissions) {
  // `permissionSets` is a map containing PermissionSets, keyed by their PermissionSet.hash().
  //
  // This function computes every minimal way to union together elements of `permissionSets` such
  // that the resulting PermissionSet covers `desiredPermissions`.
  //
  // Each minimal cover is returned as an array of PermissionSet hashes. The result of this function
  // is an array of such arrays.

  check(desiredPermissions, PermissionSet);

  function fullCover(chosen) {
    // `chosen` is an array of PermissionSet hashes. Returns true if this array is nonempty and
    // if unioning together its PermissionSets results in a PermissionSet that is a superset of
    // `desiredPermissions`.

    if (chosen.length == 0) return false; // Lacks the implicit "can access at all" permission.

    const accum = new PermissionSet([]);
    chosen.forEach((hashedPermissionSet) => {
      accum.add(permissionSets[hashedPermissionSet]);
    });

    return desiredPermissions.isSubsetOf(accum);
  }

  // Construct a proposal containing all the PermissionSets we know about.
  const chooseAll = [];
  for (const hashedPermissionSet in permissionSets) {
    chooseAll.push(hashedPermissionSet);
  }

  if (!fullCover(chooseAll)) {
    // The permissions aren't satisfied even if all known requirements are met.
    return [];
  }

  const stack = [chooseAll]; // Array of arrays of hashed permission sets.

  const result = [];

  let iter = 0;
  while (stack.length > 0) {
    const chosen = stack.pop();
    let minimal = true;
    chosen.forEach((removedHashedPermissionSet) => {
      const newChosen = [];
      chosen.forEach((hashedPermissionSet) => {
        if (hashedPermissionSet !== removedHashedPermissionSet) {
          newChosen.push(hashedPermissionSet);
        }
      });

      if (fullCover(newChosen)) {
        minimal = false;
        // TODO(perf): keep track of values we've already explored.
        stack.push(newChosen);
      }
    });

    if (minimal) {
      result.push(chosen);
    }

    iter += 1;
    if (iter > 1000) {
      throw new Meteor.Error(500, "Permissions computation exceeded maximum iteration count.");
    }
  }

  return result;
}

function normalize(permissionFlow, desiredPermissions) {
  // `permissionFlow` is a PermissionFlow representing the permissions flowing from a
  // grain owner to a vertex (e.g. as returned by `computePermissionFlowToVertex()`).
  //
  // `desiredPermissions` is the set of permissions that we are currently interested in.
  //
  // Returns a set of clauses in a minimal disjunctive normal form, representing the possible
  // ways that the desired permissions could be achieved. The result is a map from hashed clause
  // to objects of the form { clause: RequirementSet, tokensUsed: [String] }.

  check(desiredPermissions, PermissionSet);

  const flowByPermissionSet = {};
  const permissionSets = {};
  for (const hashedClause in permissionFlow) {
    const pclause = permissionFlow[hashedClause];
    const hashedPermissionSet = pclause.permissions.hash();
    if (!flowByPermissionSet[hashedPermissionSet]) {
      flowByPermissionSet[hashedPermissionSet] = [];
      permissionSets[hashedPermissionSet] = pclause.permissions;
    }

    flowByPermissionSet[hashedPermissionSet].push(pclause);
  }

  const covers = findAllMinimalCovers(permissionSets, desiredPermissions);
  const result = {};

  covers.forEach((cover) => {
    // For each PermissionSet in the cover, we need to choose a ConditionalPermissionSet
    // from `permissionFlow` that provides those permissions.

    const choices = [];
    let numNewResults = 1;
    cover.forEach((hashedPermissionSet) => {
      const conditionalPermissionSets = flowByPermissionSet[hashedPermissionSet];
      numNewResults *= conditionalPermissionSets.length;
      choices.push(conditionalPermissionSets);
    });

    for (let ii = 0; ii < numNewResults; ++ii) {
      const resultClause = new RequirementSet();
      const tokensUsed = {};
      let quotient = ii;
      choices.forEach((choice) => {
        const conditionalPermissionSet = choice[quotient % choice.length];
        resultClause.conjoin(conditionalPermissionSet.requirements);
        for (const tokenId in conditionalPermissionSet.tokensUsed) {
          tokensUsed[tokenId] = true;
        }

        quotient = Math.floor(quotient / choice.length);
      });
      result[resultClause.hash()] = { clause: resultClause, tokensUsed: tokensUsed };
    }
  });

  return result;
}

function proveClauses(db, context, goalClauses) {
  // `goalClauses` is of the form of a result of `normalize()`, that is:
  // `Map<ClauseId, {clause: RequirementSet, tokensUsed: [tokenId]}>`.
  //
  // This function attempts to determine whether at least one of the input clauses holds.
  // If a proof is found, returns `{yes: {tokensUsed: [tokenId]}}`. Otherwise, returns `{no: {}}`.
  //
  // The `db` parameter is optional. If it is present, the database will be queried as needed.
  // If left out, the computation will proceed with only the tokens already present in `context`.

  const clausesAlreadySeen = {};
  // Set of clauses we've already seen, keyed by clause hash, initialized to be equal to
  // `goalClauses`. Proving any one of these clauses is sufficient to prove our end goal. The basic
  // idea of our algorithm is to expand `clausesAlreadySeen` until either it contains an empty
  // clause (i.e. "true") or it can fruitfully be expanded no more. If it contains an empty
  // clause, then we've successfully found a proof. If it maxes out without an empty clause,
  // then there is no proof.
  //
  // For example, if we want to prove A, and if our sharing graphs has the facts
  //
  //     A <= B or C   (1)
  //     B <= A        (2)
  //     C <= true     (3)
  //
  // then the evolution of `clausesAlreadySeen` through our computation would proceed like this:
  //
  //     {A}              (start)
  //     {A, B, C}        (apply (1))
  //     {A, B, C, true}  (apply (3))
  //
  // and the proof is successful. Notice that applying (2) would not have an effect, because A
  // is already in `clausesAlreadySeen`.

  const clauseStack = [];
  // Array of clause IDs, referring to elements of `clausesAlreadySeen` that we still need to
  // explore.

  for (const hashedClause in goalClauses) {
    const goalClause = goalClauses[hashedClause];
    const tokensUsed = goalClause.tokensUsed;
    if (goalClause.clause.isEmpty()) {
      // We have an empty goal. Trivially true.
      return { yes: { tokensUsed: tokensUsed } };
    }

    clausesAlreadySeen[hashedClause] = goalClause;
    clauseStack.push(hashedClause);
  }

  const grainsFullyQueried = {};

  while (clauseStack.length > 0) {
    const hashedClause = clauseStack.pop();
    const clause = new RequirementSet();
    clause.conjoin(clausesAlreadySeen[hashedClause].clause);
    const tokensUsed = clausesAlreadySeen[hashedClause].tokensUsed;
    const goal = clause.popFirstGoal();
    const grainId = goal.vertex.grain._id;

    if (db && !(grainId in grainsFullyQueried)) {
      context.addGrain(db, grainId);
    }

    grainsFullyQueried[grainId] = true;

    const viewInfo = context.grains[grainId].cachedViewInfo || {};
    const result = computePermissionFlowToVertex(context, goal.vertex, goal.permissions, viewInfo);
    const newGoals = normalize(result, goal.permissions);

    // TODO(perf): We might end up trying to prove the same `goal` many times, so it probably makes
    //   sense to memoize the above computation of `newGoals`.

    // Now, for each new clause, conjoin it with the remaining goals in `clause`.
    // If we end up with something empty, then we're done! Otherwise, check whether
    // we already have this clause. If not, add it to `clausesAlreadySeen` and push its ID onto
    // `clauseStack`.

    for (const newClauseHash in newGoals) {
      const newGoal = newGoals[newClauseHash];
      const newClause = newGoal.clause;
      newClause.conjoin(clause);
      for (tokenId in tokensUsed) {
        newGoal.tokensUsed[tokenId] = true;
      }

      if (newClause.isEmpty()) {
        return { yes: { tokensUsed: newGoal.tokensUsed } };
      }

      // TODO(perf): This checks whether `newClause` is equal to any clause `clausesAlreadySeen`,
      //  but it would be better if we could somehow check whether `newClause` is a superset of any
      //  clause in `clausesAlreadySeen`.
      const newHash = newClause.hash();
      if (!(newHash in clausesAlreadySeen)) {
        clausesAlreadySeen[newHash] = { clause: newClause, tokensUsed: newGoal.tokensUsed };
        clauseStack.push(newHash);
      }
    }
  }

  return { no: {} };
}

SandstormPermissions.mayOpenGrain = function (db, vertex) {
  // Determines whether the vertex is allowed to open the grain. May make multiple database
  // queries.

  check(vertex, vertexPattern);
  const grainId = vertex.token ? vertex.token.grainId : vertex.grain._id;
  const context = new Context();
  const emptyPermissions = new PermissionSet([]);
  context.addGrain(db, grainId);
  const result = computePermissionFlowToVertex(context, vertex, emptyPermissions, {});
  const normalizedResult = normalize(result, emptyPermissions);
  const proven = proveClauses(db, context, normalizedResult);
  return "yes" in proven;
};

SandstormPermissions.grainPermissions = function (db, vertex, viewInfo, onInvalidated) {
  // Computes the set of permissions received by `vertex`. Returns an object with a
  // `permissions` field containing the computed permissions. If the field is null then
  // the `vertex` does not even have the base "allowed to access at all" permission.
  //
  // `onInvalidated` is an optional callback. If provided, it will be called when the result
  // has been invalidated. If `onValidated` is provided, the result of `grainPermissions` will
  // have a `observeHandle` field, containing an object with a `stop()` method that must be
  // called once the computation becomes so longer relevant.

  check(db, SandstormDb);
  check(vertex, vertexPattern);
  const grainId = vertex.token ? vertex.token.grainId : vertex.grain._id;

  let resultPermissions;
  let observeHandle;
  let onInvalidatedActive = false;

  const startTime = new Date();
  function measureElapsedTime(result) {
    const elapsedMilliseconds = (new Date()) - startTime;
    if (elapsedMilliseconds > 200) {
      console.log("Warning: SandstormPermissions.grainPermissions() took " + elapsedMilliseconds +
                  " milliseconds to complete for the vertex " + JSON.stringify(vertex));
    }
  }

  // Our computation proceeds in two phases. In the first, we determine which permissions the vertex
  // appears to have and we compute set of tokens which appears to be sufficent to prove those
  // permissions. However, concurrent database modifications may render the computation invalid, so
  // in the second phases we verify that our proof is still valid and arrange for onInvalidated
  // to be called when necessary. This is an optimisistic approach to concurrency. If the
  // verification phase fails, we try again before giving up entirely.
  for (let attemptCount = 0; attemptCount < 3; ++attemptCount) {
    const context = new Context();
    context.addGrain(db, grainId);
    const result = computePermissionFlowToVertex(context, vertex,
                                       PermissionSet.fromRoleAssignment({ allAccess:null },
                                                                        viewInfo),
                                       viewInfo);

    resultPermissions = null;
    const resultTokensUsed = {};

    // We don't yet know which permissions we'll be able to prove, so calling `normalize()` does
    // not make sense. Instead, we attempt to prove each of the clauses in `result` and then
    // union together the resulting permissions.
    for (const hashedClause in result) {
      const conditionalPermissionSet = result[hashedClause];

      // First: see whether we should even bother. If we've already proved all the permissions
      // that this clause would get us, don't bother.
      let shouldBother = false;
      if (!resultPermissions) {
        shouldBother = true;
      } else {
        const tmp = new PermissionSet([]);
        tmp.add(resultPermissions);
        if (tmp.add(conditionalPermissionSet.permissions)) {
          shouldBother = true;
        }
      }

      if (shouldBother) {
        const goalClauses = {};
        goalClauses[hashedClause] = {
          clause: conditionalPermissionSet.requirements,
          tokensUsed: conditionalPermissionSet.tokensUsed,
        };
        const proofResult = proveClauses(db, context, goalClauses);
        if (proofResult.yes) {
          for (tokenId in proofResult.yes.tokensUsed) {
            resultTokensUsed[tokenId] = true;
          }

          if (!resultPermissions) {
            resultPermissions = new PermissionSet([]);
          }

          resultPermissions.add(conditionalPermissionSet.permissions);
        }
      }
    }

    if (!resultPermissions) {
      // deny access
      measureElapsedTime();
      return {};
    }

    let invalidated = false;
    function guardedOnInvalidated() {
      invalidated = true;
      if (onInvalidatedActive) {
        onInvalidated();
      }
    }

    const tokenIds = Object.keys(resultTokensUsed);
    const cursor = db.collections.apiTokens.find({
      _id: { $in: tokenIds },
      revoked: { $ne: true },
      objectId: { $exists: false },
    });

    if (onInvalidated) {
      observeHandle = cursor.observe({
        changed(newApiToken, oldApiToken) {
          if (!_.isEqual(newApiToken.roleAssignment, oldApiToken.roleAssignment) ||
              !_.isEqual(newApiToken.revoked, oldApiToken.revoked)) {
            observeHandle.stop();
            guardedOnInvalidated();
          }
        },

        removed(oldApiToken) {
          observeHandle.stop();
          guardedOnInvalidated();
        },
      });
    }

    // Phase 2: Now let's verify those permissions.
    const newContext = new Context();
    newContext.addTokensFromCursor(cursor);
    newContext.grains = context.grains;
    newContext.userIdentityIds = context.userIdentityIds;

    // TODO(someday): Also account for possible concurrent linking/unlinking of identities,
    //   and grains going from (legacy) public to private.

    const newResult = computePermissionFlowToVertex(newContext, vertex,
                                                    resultPermissions,
                                                    viewInfo);

    const normalizedNewResult = normalize(newResult, resultPermissions);
    const proofResult = proveClauses(null, newContext, normalizedNewResult);
    if (proofResult.yes && !invalidated) {
      break;
    } else {
      if (observeHandle) {
        observeHandle.stop();
        observeHandle = null;
      }

      resultPermissions = null;
    }

  } // for (let attemptCount ...) {

  onInvalidatedActive = true;
  const result = {};
  if (resultPermissions) result.permissions = resultPermissions.array;
  if (observeHandle) result.observeHandle = observeHandle;
  measureElapsedTime();
  return result;
};

SandstormPermissions.downstreamTokens = function (db, root) {
  // Computes a list of the UiView tokens that are downstream in the sharing graph from a given
  // source. The source, `root`, can either be a token or a (grain, user) pair. The exact format
  // of `root` is specified in the `check()` invocation below.
  //
  // TODO(someday): Account for membrane requirements in this computation.

  check(root, Match.OneOf({ token: Match.ObjectIncluding({ _id: String, grainId: String }) },
                          { grain: Match.ObjectIncluding({ _id: String, identityId: String }) }));

  const result = [];
  const tokenStack = [];
  const stackedTokens = {};
  const tokensBySharer = {};
  const tokensByParent = {};
  const tokensById = {};

  function addChildren(tokenId) {
    const children = tokensByParent[tokenId];
    if (children) {
      children.forEach(function (child) {
        if (!stackedTokens[child._id]) {
          tokenStack.push(child);
          stackedTokens[child._id] = true;
        }
      });
    }
  }

  function addSharedTokens(sharer) {
    const sharedTokens = tokensBySharer[sharer];
    if (sharedTokens) {
      sharedTokens.forEach(function (sharedToken) {
        if (!stackedTokens[sharedToken._id]) {
          tokenStack.push(sharedToken);
          stackedTokens[sharedToken._id] = true;
        }
      });
    }
  }

  const grainId = root.token ? root.token.grainId : root.grain._id;
  const grain = db.getGrain(grainId);
  if (!grain || !grain.private) { return result; }

  db.collections.apiTokens.find({ grainId: grainId,
                                 revoked: { $ne: true }, }).forEach(function (token) {
    tokensById[token._id] = token;
    if (token.parentToken) {
      if (!tokensByParent[token.parentToken]) {
        tokensByParent[token.parentToken] = [];
      }

      tokensByParent[token.parentToken].push(token);
    } else if (token.identityId) {
      if (!tokensBySharer[token.identityId]) {
        tokensBySharer[token.identityId] = [];
      }

      tokensBySharer[token.identityId].push(token);
    }
  });

  if (root.token) {
    addChildren(root.token._id);
  } else if (root.grain) {
    addSharedTokens(root.grain.identityId);
  }

  while (tokenStack.length > 0) {
    const token = tokenStack.pop();
    result.push(token);
    addChildren(token._id);
    if (token.owner && token.owner.user) {
      addSharedTokens(token.owner.user.identityId);
    }
  }

  return result;
};

const HeaderSafeString = Match.Where(function (str) {
  check(str, String);
  return str.match(/^[\x20-\x7E]*$/);
});

const DavClass = Match.Where(function (str) {
  check(str, String);
  return str.match(/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/) ||
         str.match(/^<[\x21-\x7E]*>$/);  // supposed to be a URL
});

const ResourceMap = Match.Where(function (map) {
  for (path in map) {
    if (!path.match(/^\/[\x21-\x7E]*$/)) {
      return false;
    }

    check(map[path], {
      type: HeaderSafeString,
      language: Match.Optional(HeaderSafeString),
      encoding: Match.Optional(HeaderSafeString),
      body: String,
    });
  }

  return true;
});

var LocalizedString = {
  defaultText: String,
  localizations: Match.Optional([
     { locale: String, text: String }
  ]),
};

SandstormPermissions.createNewApiToken = function (db, provider, grainId, petname,
                                                   roleAssignment, owner, unauthenticated) {
  // Creates a new UiView API token. If `rawParentToken` is set, creates a child token.
  check(grainId, String);
  check(petname, String);
  check(roleAssignment, db.roleAssignmentPattern);
  // Meteor bug #3877: we get null here instead of undefined when we
  // explicitly pass in undefined.
  check(provider, Match.OneOf({ identityId: String, accountId: String },
                              { rawParentToken: String }));
  check(owner, Match.OneOf({ webkey: { forSharing: Boolean,
                                     expiresIfUnusedDuration: Match.Optional(Number), }, },
                           { user: { identityId: String,
                                   title: String, }, },
                           { grain: { grainId: String,
                                    saveLabel: Match.ObjectIncluding({ defaultText: String }),
                                      introducerIdentity: String, }, },
                           { frontend: null }));
  check(unauthenticated, Match.OneOf(undefined, null, {
    options: Match.Optional({ dav: [Match.Optional(DavClass)] }),
    resources: Match.Optional(ResourceMap),
  }));

  if (unauthenticated && JSON.stringify(unauthenticated).length > 4096) {
    throw new Meteor.Error(400, "Unauthenticated params too large; limit 4kb.");
  }

  const grain = db.getGrain(grainId);
  if (!grain) {
    throw new Meteor.Error(403, "Unauthorized", "No grain found.");
  }

  const token = Random.secret();
  const apiToken = {
    _id: Crypto.createHash("sha256").update(token).digest("base64"),
    grainId: grainId,
    roleAssignment: roleAssignment,
    petname: petname,
    created: new Date(),
    expires: null,
  };

  const result = {};
  let parentForSharing = false;
  if (provider.rawParentToken) {
    const parentToken = Crypto.createHash("sha256").update(provider.rawParentToken).digest("base64");
    const parentApiToken = db.collections.apiTokens.findOne(
      { _id: parentToken, grainId: grainId, objectId: { $exists: false } });
    if (!parentApiToken) {
      throw new Meteor.Error(403, "No such parent token found.");
    }

    if (parentApiToken.forSharing) {
      parentForSharing = true;
    }

    apiToken.identityId = parentApiToken.identityId;
    apiToken.accountId = parentApiToken.accountId;

    apiToken.parentToken = parentToken;
    result.parentApiToken = parentApiToken;
  } else if (provider.identityId) {
    apiToken.identityId = provider.identityId;
    apiToken.accountId = provider.accountId;
  }

  if (owner.webkey) {
    // Non-null webkey is a special case not covered in ApiTokenOwner.
    // TODO(cleanup): Maybe ApiTokenOwner.webkey should be extended with these fields?
    apiToken.owner = { webkey: null };
    apiToken.forSharing = parentForSharing || owner.webkey.forSharing;
    if (owner.webkey.expiresIfUnusedDuration) {
      apiToken.expiresIfUnused = new Date(Date.now() + owner.webkey.expiresIfUnusedDuration);
    }
  } else if (owner.user) {
    const grainInfo = db.getDenormalizedGrainInfo(grainId);
    apiToken.owner = {
      user: {
        identityId: owner.user.identityId,
        title: owner.user.title,
        // lastUsed: ??
        denormalizedGrainMetadata: grainInfo,
      },
    };
  } else {
    // Note: Also covers the case of `webkey: null`.
    apiToken.owner = owner;
  }

  if (unauthenticated) {
    const apiHost = {
      _id: db.apiHostIdHashForToken(token),
      hash2: Crypto.createHash("sha256").update(apiToken._id).digest("base64"),
    };
    if (unauthenticated.options) {
      apiHost.options = unauthenticated.options;
    }

    if (unauthenticated.resources) {
      // Mongo requires keys in objects to be escaped. Ugh.
      apiHost.resources = {};
      for (const key in unauthenticated.resources) {
        apiHost.resources[SandstormDb.escapeMongoKey(key)] = unauthenticated.resources[key];
      }
    }

    db.collections.apiHosts.insert(apiHost);
    apiToken.hasApiHost = true;
  }

  db.collections.apiTokens.insert(apiToken);

  result.id = apiToken._id;
  result.token = token;
  return result;
};

// Make self-destructing tokens actually self-destruct, so they don't
// clutter the token list view.
SandstormPermissions.cleanupSelfDestructing = function (db) {
  return function () {
    const now = new Date();
    db.removeApiTokens({ expiresIfUnused: { $lt: now } });
  };
};

Meteor.methods({
  transitiveShares: function (identityId, grainId) {
    check(identityId, String);
    check(grainId, String);
    if (this.userId) {
      const db = this.connection.sandstormDb;
      return SandstormPermissions.downstreamTokens(db,
          { grain: { _id: grainId, identityId: identityId } });
    }
  },

  newApiToken: function (provider, grainId, petname, roleAssignment, owner, unauthenticated) {
    check(provider, Match.OneOf({ identityId: String }, { rawParentToken: String }));
    // other check()s happen in SandstormPermissions.createNewApiToken().
    const db = this.connection.sandstormDb;
    if (provider.identityId) {
      if (!this.userId || !db.userHasIdentity(this.userId, provider.identityId)) {
        throw new Meteor.Error(403, "Not an identity of the current user: " + provider.identityId);
      }
    }

    if (provider.identityId) {
      provider.accountId = this.userId;
    }

    return SandstormPermissions.createNewApiToken(
      this.connection.sandstormDb, provider, grainId, petname, roleAssignment, owner,
      unauthenticated);
  },

  updateApiToken: function (token, newFields) {
    const db = this.connection.sandstormDb;

    check(token, String);
    check(newFields, { petname: Match.Optional(String),
                      roleAssignment: Match.Optional(db.roleAssignmentPattern),
                      revoked: Match.Optional(Boolean), });

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to modify a token");
    }

    const apiToken = db.collections.apiTokens.findOne(token);
    if (!apiToken) {
      throw new Meteor.Error(404, "No such token found.");
    }

    if (db.userHasIdentity(this.userId, apiToken.identityId)) {
      const modifier = { $set: newFields };
      db.collections.apiTokens.update(token, modifier);
    } else {
      throw new Meteor.Error(403, "User not authorized to modify this token.");
    }
  },
});
