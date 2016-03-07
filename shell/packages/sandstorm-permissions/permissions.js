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
const Url = Npm.require("url");

SandstormPermissions = {};

class PermissionSet {
  // A wrapper around an array of booleans.

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
    let result = new PermissionSet([]);

    if (!roleAssignment || "none" in roleAssignment) {
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
      const roleDef = viewInfo.roles[roleAssignment.roleId];
      if (roleDef) {
        result = new PermissionSet(roleDef.permissions);
      }
    }

    if (roleAssignment) {
      result.add(new PermissionSet(roleAssignment.addPermissionSet));
      result.remove(new PermissionSet(roleAssignment.removePermissionSet));
    }

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

class Clause {
  // A conjunction of permissions for identities on grains.

  constructor() {
    this.identityPermissions = {};
    // Two-level map. Maps a pair of a grain ID and an identity ID to a PermissionSet.
  }

  hash() {
    // It is often useful to form sets of clauses. This method returns a hash that is suitable to
    // be used as a key for such a set.
    //
    // TODO(perf): Investigate other approaches. We do not need this hash to be cryptographically
    //   secure; we just need it to avoid accidental collisions. Maybe we should instead represent
    //   sets of clauses as ordered maps, or maybe as proper hash maps with bucketing?
    const hasher = Crypto.createHash("sha256");
    Object.keys(this.identityPermissions).sort().forEach((grainId) => {
      hasher.update(grainId + "{");
      Object.keys(this.identityPermissions[grainId]).sort().forEach((identityId) => {
        hasher.update(identityId + "(");
        const permissionArray = this.identityPermissions[grainId][identityId].array;
        for (let i = 0; i < permissionArray.length; ++i) {
          if (permissionArray[i]) {
            hasher.update("" + i + ",");
          }
        }

        hasher.update(")");
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
    // Updates this clause to include the permissions required by `membraneRequirements`.

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
    check(other, Clause);

    for (let grainId in other.identityPermissions) {
      for (let identityId in other.identityPermissions[grainId]) {
        let otherPermissions = other.identityPermissions[grainId][identityId];
        this._ensureEntryExists(grainId, identityId);
        this.identityPermissions[grainId][identityId].add(otherPermissions);
      }
    }
  }
}

class MembranedPermissionSet {
  // A PermissionSet that is contingent upon some membrane requirements. The membrane reuirements
  // are repesented as a Clause.

  constructor(permissions, membrane) {
    check(permissions, PermissionSet);
    check(membrane, Clause);
    this.permissions = permissions;
    this.membrane = membrane;
    this.tokensUsed = {}; // Token IDs for the tokens that these permissions depend upon.
  }

  static fromToken(token, viewInfo) {
    // A token is an edge in the sharing graph, propagating some permissions P from vertex A
    // to vertex B, perhaps conditioned on some membrane requirements M. This function constructs
    // a MembranedPermissionSet from a token, taking into account the permissions P and the
    // membrane requirements M. The result does not carry any information about the vertices
    // A and B, even though the input `token` may contain information about them, for example
    // in the `parentToken` field.

    const permissions = PermissionSet.fromRoleAssignment(token.roleAssignment, viewInfo);
    const result = new MembranedPermissionSet(permissions, new Clause());
    result.membrane.addMembraneRequirements(token.requirements);
    result.tokensUsed[token._id] = true;
    return result;
  }

  clone() {
    // Returns a deep copy of `this`.
    const result = new MembranedPermissionSet(new PermissionSet(), new Clause());
    result.permissions.add(this.permissions);
    result.membrane.conjoin(this.membrane);
    result.tokensUsed = _.clone(this.tokensUsed);
    return result;
  }

  sequence(other) {
    // Updates this MembranedPermissionSet to apply `other` in sequence.
    check(other, MembranedPermissionSet);
    this.permissions.intersect(other.permissions);
    this.membrane.conjoin(other.membrane);
    for (const tokenId in other.tokensUsed) {
      this.tokensUsed[tokenId] = true;
    }
  }
}

class Context {
  // Cached database state for use during permissions computations.

  constructor() {
    this.grains = {};            // Map from grain ID to entry in Grains table.
    this.userIdentityIds = {};   // Map from user ID to list of identity IDs.
    this.tokensById = {};
    this.tokensByRecipient = {};
  }

  addToken(token) {
    this.tokensById[token._id] = token;
    if (token.owner && token.owner.user) {
      if (!this.tokensByRecipient[token.owner.user.identityId]) {
        this.tokensByRecipient[token.owner.user.identityId] = [];
      }

      this.tokensByRecipient[token.owner.user.identityId].push(token);
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

function backpropagateVertex(context, vertex, permissionSet, viewInfo) {
  // Computes the flow of the permissions in `permissionSet` from the grain owner to `vertex`.
  // Returns a map whose values are MembranedPermissionSets and whose keys are the Clause.hash()
  // of the corresponding membrane.
  check(context, Context);
  check(vertex, vertexPattern);
  check(permissionSet, PermissionSet);

  const grainId = vertex.token ? vertex.token.grainId : vertex.grain._id;
  const grain = context.grains[grainId];
  const ownerIdentityIds = context.userIdentityIds[grain.userId];

  // A vertex ID is of the form "i:<identityId>",  "t:<tokenId>", or "o:Owner".
  const destinationId = vertex.token ? ("t:" + vertex.token._id) : ("i:" + vertex.grain.identityId);
  const destinationPermissions = {};
  {
    const clause = new Clause();
    destinationPermissions[clause.hash()] = new MembranedPermissionSet(permissionSet, clause);
  }

  const permissionsMap = {};
  // Map<vertexId, Map<membraneHash, MembranedPermissionSet>>.
  // Map from vertex ID to permissions that we've already shown flow from that vertex to our
  // destination vertex.

  const vertexStack = []; // Vertex IDs that we need to explore.

  permissionsMap[destinationId] = destinationPermissions;
  vertexStack.push(destinationId);

  while (vertexStack.length > 0) {
    const vertexId = vertexStack.pop();
    let incomingEdges = [];

    function tokenToEdge(token) {
      return {
        sharerId: token.parentToken ? "t:" + token.parentToken : "i:" + token.identityId,
        membranedPermissions: MembranedPermissionSet.fromToken(token, viewInfo),
      };
    }

    if (vertexId.slice(0, 2) === "o:") {
      // Owner. We don't need to do anything.
      incomingEdges = [];
    } else if (vertexId.slice(0, 2) === "t:") {
      const token = context.tokensById[vertexId.slice(2)];
      if (token) {
        incomingEdges = [tokenToEdge(token)];
      }
    } else if (vertexId.slice(0, 2) === "i:") {
      if (ownerIdentityIds.indexOf(vertexId.slice(2)) >= 0) {
        const p = new MembranedPermissionSet(PermissionSet.fromRoleAssignment({ allAccess: null },
                                                                              viewInfo),
                                             new Clause());
        incomingEdges = [{ sharerId: "o:Owner", membranedPermissions: p }];
      } else if (!grain.private) { // legacy public grain
        const p = new MembranedPermissionSet(PermissionSet.fromRoleAssignment({ none: null },
                                                                              viewInfo),
                                             new Clause());
        incomingEdges = [{ sharerId: "o:Owner", membranedPermissions: p }];
      } else {
        incomingEdges = (context.tokensByRecipient[vertexId.slice(2)] || []).map(tokenToEdge);
      }
    } else {
      throw new Meteor.Error(500, "Unrecognized vertex ID: " + vertexId);
    }

    incomingEdges.forEach((edge) => {
      const sharerId = edge.sharerId;
      let needToPush = false;
      // For each MembranedPermissionSet in permissionsMap[vertexId],
      // apply edge.membranedPermissions in sequence.
      const sequenced = {};
      for (const clauseHash in permissionsMap[vertexId]) {
        const newPermissions = edge.membranedPermissions.clone();
        newPermissions.sequence(permissionsMap[vertexId][clauseHash]);
        const newHash = newPermissions.membrane.hash();
        if (sequenced[newHash]) {
          sequenced[newHash].permissions.add(newPermissions.permissions);
          for (tokenId in newPermissions.tokensUsed) {
            sequenced[newHash].tokensUsed[tokenId] = true;
          }
        } else {
          sequenced[newHash] = newPermissions;
        }
      };

      // Optimization: we don't care about permissions that we've already proven the opener has.
      if (permissionsMap["o:Owner"]) {
        for (const hashedClause in permissionsMap["o:Owner"]) {
          const membranedPermissionSet = permissionsMap["o:Owner"][hashedClause];
          if (hashedClause in sequenced) {
            const smps = sequenced[hashedClause];
            smps.permissions.remove(membranedPermissionSet.permissions);
            if (smps.permissions.array.length == 0) {
              delete sequenced[hashedClause];
            }
          }
        }
      }

      if (!permissionsMap[sharerId]) {
        permissionsMap[sharerId] = sequenced;
        needToPush = true;
      } else {
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
      }

      if (needToPush) {
        vertexStack.push(sharerId);
      }
    });
  }

  return permissionsMap["o:Owner"] || {};
}

function normalize(membranedPermissionSetMap, desiredPermissions) {
  // `membranedPermissionSetMap` represents the permissions flowing from a grain owner to a vertex,
  // exactly in the format of the output of `backpropagateVertex()`.
  //
  // `desiredPermissions` is the set of permissions that we are currently interested in.
  //
  // Returns a set of clauses in a minimal disjunctive normal form, representing the possible
  // ways that the desired permissions could be achieved. The result is a map from hashed clause
  // to objects of the form { clause: Clause, tokensUsed: [String] }.

  const result = {};

  function fullCover(chosen) {
    if (Object.keys(chosen).length == 0) return false;

    const accum = new PermissionSet([]);
    for (const hashedClause in chosen) {
      accum.add(membranedPermissionSetMap[hashedClause].permissions);
    }

    return desiredPermissions.isSubsetOf(accum);
  }

  const chooseAll = {};
  for (const hashedClause in membranedPermissionSetMap) {
    const pclause = membranedPermissionSetMap[hashedClause];
    chooseAll[hashedClause] = { clause: pclause.membrane, tokensUsed: pclause.tokensUsed };
  }

  if (!fullCover(chooseAll)) {
    return {};
  }

  const stack = [chooseAll];
  // Array of Map<hashedClause, { clause: Clause, tokensUsed: [String] }>.

  while (stack.length > 0) {
    const chosen = stack.pop();
    let minimal = true;
    for (const removedHashedClause in chosen) {
      const newChosen = {};
      for (const hashedClause in chosen) {
        if (hashedClause !== removedHashedClause) {
          newChosen[hashedClause] = chosen[hashedClause];
        }
      }

      if (fullCover(newChosen)) {
        minimal = false;
        // TODO(perf): keep track of values we've already explored.
        stack.push(newChosen);
      }
    }

    if (minimal) {
      const resultClause = new Clause();
      const tokensUsed = {};
      for (const hashedClause in chosen) {
        resultClause.conjoin(chosen[hashedClause].clause);
        for (const tokenId in chosen[hashedClause].tokensUsed) {
          tokensUsed[tokenId] = true;
        }
      }

      result[resultClause.hash()] = { clause: resultClause, tokensUsed: tokensUsed };
    }
  }

  return result;
}

function proveClauses(db, context, goalClauses) {
  // `goalClauses` is of the form of a result of `normalize()`, that is:
  // `Map<ClauseId, {clause: Clause, tokensUsed: [tokenId]}>`.
  //
  // This function attempts to determine whether at least one of the input clauses holds.
  // If a proof is found, returns `{yes: {tokensUsed: [tokenId]}}`.
  // otherwise, returns {no: {}}
  //
  // The `db` parameter is optional. If it is present, the database will be queried as needed.
  // If left out, the computation will proceed with only the tokens already present in `context`.

  const clauses = {};
  const clauseStack = []; // clause IDs

  for (const hashedClause in goalClauses) {
    const goalClause = goalClauses[hashedClause];
    const tokensUsed = goalClause.tokensUsed;
    if (goalClause.clause.isEmpty()) {
      // We have an empty goal. Trivially true.
      return { yes: { tokensUsed: tokensUsed } };
    }

    clauses[hashedClause] = { clause: goalClause.clause, tokensUsed: tokensUsed };
    clauseStack.push(hashedClause);
  }

  const grainsFullyQueried = {};

  while (clauseStack.length > 0) {
    const hashedClause = clauseStack.pop();
    const clause = new Clause();
    clause.conjoin(clauses[hashedClause].clause);
    const tokensUsed = clauses[hashedClause].tokensUsed;
    const goal = clause.popFirstGoal();
    const grainId = goal.vertex.grain._id;

    if (db && !(grainId in grainsFullyQueried)) {
      context.addGrain(db, grainId);
    }

    grainsFullyQueried[grainId] = true;

    const viewInfo = context.grains[grainId].cachedViewInfo || {};
    const result = backpropagateVertex(context, goal.vertex, goal.permissions, viewInfo);
    const newGoals = normalize(result, goal.permissions);

    // For each new clause, conjoin it with the remaining goals in `clause`.
    // If we end up with something empty, then we're done! Otherwise, check whether
    // we already have this clause. If not, add it to `clauses` and push its ID onto clauseStack.

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

      const newHash = newClause.hash();
      if (!(newHash in clauses)) {
        clauses[newHash] = { clause: newClause, tokensUsed: newGoal.tokensUsed };
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
  const result = backpropagateVertex(context, vertex, emptyPermissions, {});
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
    const result = backpropagateVertex(context, vertex,
                                       PermissionSet.fromRoleAssignment({ allAccess:null },
                                                                        viewInfo),
                                       viewInfo);

    resultPermissions = null;
    const resultTokensUsed = {};

    // We don't yet know which permissions we'll be able to prove, so calling `normalize()` does
    // not make sense. Instead, we attempt to prove each of the clauses in `result` and then
    // union together the resulting permissions.
    for (const hashedClause in result) {
      const membranedPermissionSet = result[hashedClause];

      // first: see whether we should even bother
      let shouldBother = false;
      if (!resultPermissions) {
        shouldBother = true;
      } else {
        const tmp = new PermissionSet([]);
        tmp.add(resultPermissions);
        if (tmp.add(membranedPermissionSet.permissions)) {
          shouldBother = true;
        }
      }

      if (shouldBother) {
        const goalClauses = {};
        goalClauses[hashedClause] = {
          clause: membranedPermissionSet.membrane,
          tokensUsed: membranedPermissionSet.tokensUsed,
        };
        const proofResult = proveClauses(db, context, goalClauses);
        if (proofResult.yes) {
          for (tokenId in proofResult.yes.tokensUsed) {
            resultTokensUsed[tokenId] = true;
          }

          if (!resultPermissions) {
            resultPermissions = new PermissionSet([]);
          }

          resultPermissions.add(membranedPermissionSet.permissions);
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

    const newResult = backpropagateVertex(newContext, vertex,
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
