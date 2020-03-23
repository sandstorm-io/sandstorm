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

import Crypto from 'crypto';

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
  // A conjunction of permissions for users on grains.
  //
  // This typically represents a set of `MembraneRequirement`s, as defined in `supervisor.capnp`.
  // These represent conditions under which some connection formed between grains remains valid.
  // When a capability travels from grain to grain, it passes across these connections -- if any
  // of the connections becomes invalid (is revoked), then the capability must be revoked as well.
  // The word "membrane" comes from the concept of revokable membranes; the capability is passing
  // across such membranes as it travels.
  //
  // For example, a RequirementSet might represent the statement "Alice has read access to Foo, Bob
  // has write access to Foo, and Bob has read access to Bar". Specifically, this example situation
  // would come about if:
  // - Bob used his read access to Bar to extract a capability from it.
  // - Bob embedded that capability into Foo, using his write access.
  // - Alice extracted the capability from Foo, using her read access.
  // If any of these permissions are revoked, then the capability needs to be revoked as well.

  constructor() {
    this.permissionsHeldRequirements = {};
    // Map from grain ID to objects of the form { users, tokens }, where `users` is a
    // map from account ID to PermissionSet and `tokens` is a map from token ID to PermissionSet.
    // Represents a set of `permissionsHeld` requirements.

    this.userIsAdminRequirements = {};
    // Map from account ID to boolean. Represents a set of `userIsAdmin` requirements.

    this.tokenValidRequirements = {};
    // Map from token ID to boolean. Represents a set of `tokenValid` requirements.
  }

  isEmpty() {
    for (const tokenId in this.tokenValidRequirements) {
      return false;
    }

    for (const grainId in this.permissionsHeldRequirements) {
      if (Object.keys(this.permissionsHeldRequirements[grainId]).length > 0) {
        return false;
      }
    }

    return true;
  }

  addRequirements(requirements) {
    // Updates this RequirementSet to include the permissions required by `requirements`, which
    // is a decoded Cap'n Proto List(MembraneRequirement).

    if (!requirements) return;
    requirements.forEach((requirement) => {
      if (requirement.permissionsHeld) {
        const grainId = requirement.permissionsHeld.grainId;
        const permissions = new PermissionSet(requirement.permissionsHeld.permissions);

        if (!this.permissionsHeldRequirements[grainId]) {
          this.permissionsHeldRequirements[grainId] = { users: {}, tokens: {}, };
        }

        const grainReqs = this.permissionsHeldRequirements[grainId];

        if (requirement.permissionsHeld.accountId) {
          const accountId = requirement.permissionsHeld.accountId;
          if (!grainReqs.users[accountId]) {
            grainReqs.users[accountId] = new PermissionSet([]);
          }

          grainReqs.users[accountId].add(permissions);
        } else if (requirement.permissionsHeld.tokenId) {
          const tokenId = requirement.permissionsHeld.tokenId;
          if (!grainReqs.tokens[tokenId]) {
            grainReqs.tokens[tokenId] = new PermissionSet([]);
          }

          grainReqs.tokens[tokenId].add(permissions);

        } else {
          throw new Error("unrecognized permissionsHeld requirement", JSON.stringify(requirement));
        }
      } else if (requirement.userIsAdmin) {
        this.userIsAdminRequirements[requirement.userIsAdmin] = true;
      } else if (requirement.tokenValid) {
        this.tokenValidRequirements[requirement.tokenValid] = true;
      } else {
        throw new Error("unsupported requirement: " + JSON.toString(requirement));
      }
    });
  }

  getGrainIds() {
    return Object.keys(this.permissionsHeldRequirements);
  }

  getTokenIds() {
    return Object.keys(this.tokenValidRequirements);
  }

  forEach(func) {
    for (const tokenId in this.tokenValidRequirements) {
      func({ tokenValid: tokenId });
    }

    for (const accountId in this.userIsAdminRequirements) {
      func({ userIsAdmin: accountId });
    }

    for (const grainId in this.permissionsHeldRequirements) {
      for (const accountId in this.permissionsHeldRequirements[grainId].users) {
        const permissionSet = this.permissionsHeldRequirements[grainId].users[accountId];
        func({ permissionsHeld: { grainId, accountId, permissionSet }, });
      }

      for (const tokenId in this.permissionsHeldRequirements[grainId].tokens) {
        const permissionSet = this.permissionsHeldRequirements[grainId].tokens[tokenId];
        func({ permissionsHeld: { grainId, tokenId, permissionSet }, });
      }
    }
  }
}

// A permission ID is either the string "canAccess", corresponding to the implicit "can access
// the grain at all" permission, or a non-negative integer, corresponding to a permission
// defined by the app in its manifest.
const PermissionId = Match.OneOf("canAccess", Match.Integer);

function forEachPermission(permissions, func) {
  // Calls `func` on "canAccess" and each permission ID that corresponds to a `true`
  // value in `permissions`.
  check(permissions, [Boolean]);
  func("canAccess");
  for (let ii = 0; ii < permissions.length; ++ii) {
    if (permissions[ii]) {
      func(ii);
    }
  }
}

// A vertex is a principal in the sharing graph. A "vertex ID" is either "i:" + an account ID,
// or "t:" + a token ID. In some limited contexts, "o:Owner" is also allowed, signifying the
// *account* of the grain owner, from which all permissions flow.

const vertexIdOfTokenOwner = function (token) {
  // Returns which vertex recieves permissions from this token.

  let result = "t:" + token._id;  // the bearer of the token
  if (token.owner && token.owner.user) {
    result = "i:" + token.owner.user.accountId;  // the user that owns the token
  }

  return result;
};

const vertexIdOfPermissionsHeld = function (held) {
  if (held.accountId) {
    return "i:" + held.accountId;
  } else if (held.tokenId) {
    return "t:" + held.tokenId;
  } else {
    throw new Error("Unrecognized permissionsHeld: " + JSON.stringify(held));
  }
};

class Variable {
  // Our permissions computation can be framed as a propositional HORNSAT problem; this `Variable`
  // class represents a variable in that sense. There is a variable for every (grain ID, vertex ID,
  // permission ID) triple. There is also a variable for every non-UiView ApiToken, to account for
  // `tokenValid` requirements. In any given computation, we only explicitly construct those
  // variables that we know might actually be relevant to the result.
  //
  // The value of a variable represents an answer to the question "does this vertex in the sharing
  // graph receive this permission at this grain?" We start out by setting all variables to `false`,
  // and we only set a variable to `true` when an edge in the sharing graph forces us to. If
  // this forward-chaining eventually forces us to set our end goal variables to `true`, then the
  // HORNSAT problem is unsatisfiable and we have proved what we wanted. Otherwise, the HORNSAT
  // problem is satisfiable, i.e. there is a consistent way to set values to variables in which
  // our goal nodes do *not* receive the permissions we wanted them to receive.

  constructor() {
    this.value = false;

    this.directDependents = [];
    // List of token IDs for outgoing edges that need to be looked at once this variable gets set
    // to `true`.

    this.requirementDependents = [];
    // List of token IDs for tokens that have requirements that get fulfilled once this variable
    // gets set to `true`.
  }
}

class ActiveToken {
  // An "active token" is one that we allow to propagate permissions because we've decided
  // that it might be relevant to our current computation. This class tracks which permissions
  // the token can carry, which of those permissions we've actually proved to arrive at the source
  // end of the token, and how many of the token's requirements are still unmet.

  constructor(tokenId, requirements, numUnmetRequirements, permissions, grainId, recipientId) {
    check(tokenId, String);
    check(numUnmetRequirements, Match.Integer);
    check(grainId, String);
    check(recipientId, String);

    check(permissions, [Boolean]);
    // The permissions that this token is capable of carrying, in addition to the implicit
    // "canAccess" permission.

    this.tokenId = tokenId;
    this.requirements = requirements;
    this.grainId = grainId;
    this.recipientId = recipientId;

    this.numUnmetRequirements = numUnmetRequirements;
    // How many of this token's requirements we have not yet proven to be met.

    this.receivedPermissions = new Array();
    // A map from permission ID to boolean. If a permission ID is present in this map,
    // then this token's roleAssignment includes that permission. If the corresponding
    // value is `true`, then we've proven that this token receives this permission and
    // therefore propagates it if the requirements are met.

    this.receivedPermissions.canAccess = false;
    for (let ii = 0; ii < permissions.length; ++ii) {
      if (permissions[ii]) {
        this.receivedPermissions[ii] = false;
      }
    }
  }

  requirementsAreMet() {
    // Have we yet proved that all of this token's requirements are met?
    return this.numUnmetRequirements == 0;
  }

  decrementRequirements(context) {
    // Decrements the number of unmet requirements of this token.
    check(context, Context);
    this.numUnmetRequirements -= 1;
    if (this.numUnmetRequirements < 0) {
      throw new Meteor.Error(500, "numUnmetRequirements is negative");
    }

    if (this.requirementsAreMet()) {
      // This was the last missing requirement for this token, therefore we've triggered the
      // outgoing edges from the token corresponding to each known incoming permission.
      this.forEachReceivedPermission((permissionId) => {
        // We've triggered a new edge! Push it onto the queue.
        context.setToTrueStack.push({ grainId: this.grainId,
                                      vertexId: this.recipientId,
                                      permissionId: permissionId,
                                      responsibleTokenId: this.tokenId, });
      });
    }
  }

  setReceivesPermission(permissionId, context) {
    // Records that this token receives a permission.
    check(permissionId, PermissionId);
    check(context, Context);
    if (permissionId in this.receivedPermissions) {
      this.receivedPermissions[permissionId] = true;
    }

    if (this.numUnmetRequirements == 0) {
      context.setToTrueStack.push({ grainId: this.grainId,
                                    vertexId: this.recipientId,
                                    permissionId: permissionId,
                                    responsibleTokenId: this.tokenId, });
    } else {
      // Since we know permissions flow to this token, and the token is active (meaning it
      // may be relevant to the overall computation), we now know that it's worth checking
      // the token's requirements. Add them to `unmetRequirements`. Note that these requirement
      // could actually be ones that we've checked already, but we'll figure that out once
      // processUnmetRequirements() runs and discovers it isn't activating any new tokens.
      //
      // TODO(perf): This is an overestimate. It might be worthwhile to keep track of which
      //   requirements are already met, so that we don't need to add them here.

      context.unmetRequirements.addRequirements(this.requirements);
    }
  }

  forEachReceivedPermission(func) {
    // Calls `func` on each permission ID that we've proven this token receives.

    if (this.receivedPermissions.canAccess) {
      func("canAccess");
    }

    // Note: Array.forEach() does hit the "canAccess" permission ID.
    this.receivedPermissions.forEach((received, permissionId) => {
      if (received) {
        func(permissionId);
      }
    });
  }
}

class Context {
  // An ongoing permissions computation, including cached database state.

  constructor() {
    this.grains = {};            // Map from grain ID to entry in Grains table.
    this.adminUsers = {};        // Set of account IDs for admins.
    this.tokensById = {};        // Map from token ID to token.
    this.tokensByRecipient = {}; // Map from grain ID and account ID to token array.

    this.variables = {};
    // GrainId -> VertexId -> PermissionId -> Variable
    //
    // We have a special fake grain ID "tokenValid", where we store the variables that track
    // `tokenValid` requirements. Only the "canAccess" permission makes sense for that fake grain.

    this.userIsAdminVariables = {};
    // Account ID -> Variable

    this.activeTokens = {};      // TokenId -> ActiveToken

    this.setToTrueStack = [];
    // Variables enqueued to be set to true.
    // Array of { grainId: String, vertexId: String, permissionId: PermissionId,
    //            responsibleTokenId: Optional(String) }

    this.unmetRequirements = new RequirementSet();
    // As we run our forward-chaining algorithm, when we encounter a token with unmet requirements
    // we add those requirements to this set. Then, if we find that our current knowledge base
    // is not large enough to prove our goal, we can expand our search by following these
    // requirements backwards and activating tokens that might help prove that they are met.
    // `unmetRequirements` is allowed to be an overestimate -- in fact, when adding requirements
    // to `unmetRequirements` we generally do not check if they had already been proven. The next
    // run of processUnmetRequirements(), however, will find that all of the tokens activated by
    // the requirements were already active.
  }

  reset() {
    // Resets all state except this.grains and this.adminUsers.
    this.tokensById = {};
    this.tokensByRecipient = {};
    this.unmetRequirements = new RequirementSet();
    this.setToTrueStack = [];
    this.variables = {};
    this.activeTokens = {};
  }

  addToken(token) {
    // Adds a token to `this.tokensById`. If the token is a UiView, also adds it to
    // `this.tokensByRecipient`. Does not activate the token.

    const isUiView = token.grainId && !token.objectId;

    if (this.tokensById[token._id]) return;

    this.tokensById[token._id] = token;
    if (isUiView && token.owner && token.owner.user) {
      if (!this.tokensByRecipient[token.grainId]) {
        this.tokensByRecipient[token.grainId] = {};
      }

      if (!this.tokensByRecipient[token.grainId][token.owner.user.accountId]) {
        this.tokensByRecipient[token.grainId][token.owner.user.accountId] = [];
      }

      this.tokensByRecipient[token.grainId][token.owner.user.accountId].push(token);
    }
  }

  addGrains(db, grainIds) {
    // Retrieves grains from the database.

    check(db, SandstormDb);
    check(grainIds, [String]);
    if (grainIds.length == 0) return; // Nothing to do.

    db.collections.grains.find({
      _id: { $in: grainIds },
      trashed: { $exists: false },
      suspended: { $ne: true },
    }).forEach((grain) => {
      this.grains[grain._id] = grain;
    });

    const query = { grainId: { $in: grainIds },
                    revoked: { $ne: true },
                    trashed: { $exists: false },
                    suspended: { $ne: true },
                    objectId: { $exists: false }, };
    db.collections.apiTokens.find(query).forEach((token) => this.addToken(token));
  }

  addTokensFromCursor(cursor) {
    cursor.forEach((token) => this.addToken(token));
  }

  activateOwnerEdges(grainId, edges) {
    check(edges, [{ accountId: String, role: SandstormDb.prototype.roleAssignmentPattern }]);

    edges.forEach((edge) => {
      const viewInfo = this.grains[grainId].cachedViewInfo || {};
      const permissions = PermissionSet.fromRoleAssignment(edge.role, viewInfo);
      const vertexId = "i:" + edge.accountId;
      forEachPermission(permissions.array, (permissionId) => {
        this.setToTrueStack.push({
          grainId: grainId,
          vertexId: vertexId,
          permissionId: permissionId,
        });
      });
    });

    return edges.length > 0;
  }

  registerInterestInRequirements(tokenId, requirements) {
    // Add all requirements.
    let numUnmetRequirements = 0;
    if (requirements) {
      requirements.forEach((requirement) => {
        if (requirement.permissionsHeld) {
          const reqGrainId = requirement.permissionsHeld.grainId;
          const reqVertexId = vertexIdOfPermissionsHeld(requirement.permissionsHeld);
          const reqPermissions = requirement.permissionsHeld.permissions || [];

          forEachPermission(reqPermissions, (permissionId) => {
            const variable = this.getVariable(reqGrainId, reqVertexId, permissionId);
            if (!variable.value) {
              // This requirement hasn't been proven yet. We add it to the variable's list of
              // dependents so that we get notified when that variable is proven, and we increment
              // numUnmetRequirements to indicate how many notifications we need to get before we
              // know all requirements are satisfied.
              numUnmetRequirements += 1;
              variable.requirementDependents.push(tokenId);
            }
          });
        } else if (requirement.userIsAdmin) {
          const accountId = requirement.userIsAdmin;
          const variable = this.getUserIsAdminVariable(accountId);
          if (!variable.value) {
            numUnmetRequirements += 1;
            variable.requirementDependents.push(tokenId);
          }
        } else if (requirement.tokenValid) {
          const reqTokenId = requirement.tokenValid;
          const variable = this.getVariable("tokenValid", "t:" + reqTokenId, "canAccess");
          if (!variable.value) {
            numUnmetRequirements += 1;
            variable.requirementDependents.push(tokenId);
          }
        } else {
          throw new Error("unknown kind of requirement: " + JSON.stringify(requirement));
        }
      });
    }

    return numUnmetRequirements;
  }

  activateToken(tokenId) {
    // Includes a new token (which must already be in `this.tokensById`) in our computation. The
    // tricky part here is dealing with our already-accumulated knowledge; we need to compute how
    // many of the token's requirements are currently unmet and whether we need to push anything new
    // onto `setToTrueStack`.

    check(tokenId, String);
    if (tokenId in this.activeTokens) {
      return false;
    }

    const token = this.tokensById[tokenId];
    const grainId = token.grainId;
    const viewInfo = this.grains[grainId].cachedViewInfo || {};
    const tokenPermissions = PermissionSet.fromRoleAssignment(token.roleAssignment, viewInfo);

    const sharerId = token.parentToken ? "t:" + token.parentToken : "i:" + token.accountId;
    const recipientId = vertexIdOfTokenOwner(token);

    const numUnmetRequirements = this.registerInterestInRequirements(tokenId, token.requirements);
    const activeToken = new ActiveToken(tokenId, token.requirements, numUnmetRequirements,
                                        tokenPermissions.array, grainId, recipientId);

    // Add all edges represented by this token (one for each permission).
    forEachPermission(tokenPermissions.array, (permissionId) => {
      const recipientVariable = this.getVariable(grainId, recipientId, permissionId);
      if (!recipientVariable.value) {
        const sharerVariable = this.getVariable(grainId, sharerId, permissionId);
        if (!sharerVariable.value) {
          // Not proven yet that the source has this permission, so add to its direct dependents so
          // that we get notified if that changes.
          sharerVariable.directDependents.push(tokenId);
        } else {
          // The source has already been proven.
          activeToken.setReceivesPermission(permissionId, this);
        }
      }
    });

    this.activeTokens[tokenId] = activeToken;

    return true;
  }

  activateTokenValidToken(tokenId) {
    // Like `activateToken()`, but for a token that appears in a `tokenValid` requirement.
    // Such tokens require some special handling to fit into our computation.

    check(tokenId, String);
    if (tokenId in this.activeTokens) {
      return false;
    }

    const token = this.tokensById[tokenId];
    if (!token) {
      return false;
    }

    const numUnmetRequirements = this.registerInterestInRequirements(tokenId, token.requirements);
    const activeToken = new ActiveToken(tokenId, token.requirements, numUnmetRequirements, [],
                                        "tokenValid", "t:" + tokenId);

    const recipientId = "t:" + tokenId;
    const sharerVariable = token.parentToken &&
          this.getVariable("tokenValid", "t:" + token.parentToken, "canAccess");

    const recipientVariable = this.getVariable("tokenValid", recipientId, "canAccess");
    if (!recipientVariable.value) {
      if (!token.parentToken || (sharerVariable && sharerVariable.value)) {
        // The source has already been proven.
        activeToken.setReceivesPermission("canAccess", this);
      } else {
        // Not proven yet that the source has this permission, so add to its direct dependents so
        // that we get notified if that changes.
        sharerVariable.directDependents.push(tokenId);
      }
    }

    this.activeTokens[tokenId] = activeToken;

    return true;
  }

  getVariable(grainId, vertexId, permissionId) {
    check(grainId, String);
    check(vertexId, String);
    check(permissionId, PermissionId);

    if (!this.variables[grainId]) {
      this.variables[grainId] = {};
    }

    if (!this.variables[grainId][vertexId]) {
      this.variables[grainId][vertexId] = new Array();
    }

    if (!this.variables[grainId][vertexId][permissionId]) {
      this.variables[grainId][vertexId][permissionId] = new Variable();
    }

    return this.variables[grainId][vertexId][permissionId];
  }

  getUserIsAdminVariable(accountId) {
    check(accountId, String);

    if (!this.userIsAdminVariables[accountId]) {
      this.userIsAdminVariables[accountId] = new Variable();
    }

    return this.userIsAdminVariables[accountId];
  }

  getPermissions(grainId, vertexId) {
    // Looks up the permissions that have already been proven for the `vertexId` on `grainId`.

    check(grainId, String);
    check(vertexId, String);

    if (!this.getVariable(grainId, vertexId, "canAccess").value) {
      return null;
    } else {
      let length = this.variables[grainId][vertexId].length;
      let permissions = new Array(length);
      for (let idx = 0; idx < length; ++idx) {
        if (this.variables[grainId][vertexId][idx]) {
          permissions[idx] = !!this.variables[grainId][vertexId][idx].value;
        } else {
          permissions[idx] = false;
        }
      }

      return new PermissionSet(permissions);
    }
  }

  runForwardChaining(grainId, vertexId, permissionSet) {
    // Runs forward-chaining, consuming elements from `this.setToTrueStack` and propagating
    // their permissions, until we've proven that `(grainId, vertexId)` has the permissions in
    // `permissionSet`, or until we've exhausted `this.setToTrueStack`.
    //
    // TODO(perf): Exit early if we've already proven that permissionSet is fulfilled.

    check(grainId, String);
    check(vertexId, String);
    check(permissionSet, PermissionSet);

    if (permissionSet.array.length > 0) {
      // Make sure that the result of this call, retrieved through `this.getPermissions()`,
      // will have a full array of permissions, even if they won't all be set to `true`.
      this.getVariable(grainId, vertexId, permissionSet.array.length - 1);
    }

    while (this.setToTrueStack.length > 0) {
      const current = this.setToTrueStack.pop();
      const variable = this.getVariable(current.grainId, current.vertexId, current.permissionId);
      if (variable.value) {
        continue;
      }

      // For the first time, this vertex is now known to be satisfied.
      variable.value = true;

      // For each edge (token) whose source is this vertex, mark that the input permission is
      // fulfilled.
      variable.responsibleTokenId = current.responsibleTokenId;
      variable.directDependents.forEach((tokenId) => {
        // We know this permission must be met now. We also know that the permission was not met
        // for this token previously becaues a token has exactly one source vertex for each
        // permission, and we're processing that vertex now.

        this.activeTokens[tokenId].setReceivesPermission(current.permissionId, this);
      });

      // For each token that has a requirement on this vertex, mark that one of its requirements
      // has ben fulfilled.
      variable.requirementDependents.forEach((tokenId) => {
        this.activeTokens[tokenId].decrementRequirements(this);
      });
    }

    return this.getPermissions(grainId, vertexId);
  }

  activateRelevantTokens(grainId, vertexId) {
    // Returns true if more computation might yield more progress.

    check(grainId, String);
    check(vertexId, String);

    let result = false;
    const relevant = computeRelevantTokens(this, grainId, vertexId);
    if (this.activateOwnerEdges(grainId, relevant.ownerEdges)) {
      result = true;
    }

    relevant.tokenIds.forEach((tokenId) => {
      if (this.activateToken(tokenId)) {
        result = true;
      }
    });

    return result;
  }

  processUnmetRequirements(db) {
    // Activate all tokens relevant to the requirements in `unmetRequirements`. May do a database
    // query to look up new tokens.
    //
    // Returns true if more computation might yield more progress, i.e., at least one token was
    // newly-activated.

    const grainIds = this.unmetRequirements.getGrainIds()
          .filter((grainId) => !(grainId in this.grains));

    if (db) {
      this.addGrains(db, grainIds);
    }

    let result = false;

    // As we process our requirements, we might find new unmet requirments.
    // We defer processing those until the next time around.
    const oldUnmetRequirements = this.unmetRequirements;
    this.unmetRequirements = new RequirementSet();

    oldUnmetRequirements.forEach((req) => {
      if (req.permissionsHeld) {
        let next = req.permissionsHeld;
        let nextVertexId = vertexIdOfPermissionsHeld(next);
        // Activate all tokens relevant to this requirement.
        // TODO(perf): We're actually overestimating, because we're activating tokens relevant to
        //   *all* permissions rather than just the permissions specified by the requirement. E.g.
        //   if the requirement is that Bob has write access, then tokens which only transmit read
        //   access are not relevant, but we'll end up activating them anyway.
        if (this.activateRelevantTokens(next.grainId, nextVertexId)) {
          result = true;
        }
      } else if (req.tokenValid) {
        // Active the token and all of its transitive parents.
        let currentTokenId = req.tokenValid;
        while (true) {
          let currentToken = this.tokensById[currentTokenId];
          if (!currentToken && db) {
            currentToken = db.collections.apiTokens.findOne({
              _id: currentTokenId,
              revoked: { $ne: true },
              suspended: { $ne: true },
            });
            this.tokensById[currentTokenId] = currentToken;
          }

          if (!currentToken) {
            break;
          }

          if (this.activateTokenValidToken(currentTokenId)) {
            result = true;
          }

          if (currentToken.parentToken) {
            currentTokenId = currentToken.parentToken;
          } else {
            break;
          }
        }
      } else if (req.userIsAdmin) {
        let accountId = req.userIsAdmin;
        if (!(accountId in this.adminUsers) && db) {
          Meteor.users.find({ isAdmin: true }).forEach((user) => {
            this.adminUsers[user._id] = true;
          });
        }

        if (this.adminUsers[accountId]) {
          const variable = this.getUserIsAdminVariable(accountId);
          variable.value = true;

          // Might have some requirement dependents. Cannot have any direct depependents.
          variable.requirementDependents.forEach((tokenId) => {
            result = true;
            this.activeTokens[tokenId].decrementRequirements(this);
          });
        }
      } else {
        throw new Error("unknown kind of requirement: " + JSON.stringify(req));
      }
    });

    return result;
  }

  tryToProve(grainId, vertexId, permissionSet, db) {
    // Tries to prove that `vertexId` has the given permissions on the given grain. Returns a
    // `PermissionSet` representing the permissions proven, or null if it has not been proved
    // yet that the vertex even has access to the grain.

    check(grainId, String);
    check(vertexId, String);
    check(permissionSet, PermissionSet);
    check(db, Match.OneOf(undefined, SandstormDb));
    // If `db` is not provided, then this function will make no database queries.

    if (db) {
      this.addGrains(db, [grainId]);
    }

    this.activateRelevantTokens(grainId, vertexId);
    while (true) {
      const result = this.runForwardChaining(grainId, vertexId, permissionSet);
      if (result && permissionSet.isSubsetOf(result)) {
        return result;
      }

      if (!this.processUnmetRequirements(db)) {
        return result;
      }
    }
  }

  getResponsibleTokens(grainId, vertexId) {
    // For the permissions that we've already proven must be held by `vertexId`, transitively finds
    // the tokens that we have used in that proof, including tokens responsible for fulfilling
    // membrane requirements.
    //
    // Whenever we prove a fact, we keep track of the immediately responsible token for that fact,
    // This function works by walking backwards in the sharing graph, following this trail of
    // "responsible tokens".
    //
    // Returns an object with two fields:
    //    tokenIds: list of IDs of the responsible tokens.
    //    grainIds: list of IDs of all relevant grains.

    check(grainId, String);
    check(vertexId, String);

    const stack = []; // [{ grainId: String, vertexId: String, permissionId: PermissionId }]
    const visited = new Array(); // grainId -> vertexId -> permissionId -> bool;

    function pushVertex(grainId, vertexId, permissionId) {
      if (!visited[grainId]) {
        visited[grainId] = {};
      }

      if (!visited[grainId][vertexId]) {
        visited[grainId][vertexId] = {};
      }

      const vertex = visited[grainId][vertexId];
      if (!vertex[permissionId]) {
        vertex[permissionId] = true;
        stack.push({ grainId: grainId, vertexId: vertexId, permissionId: permissionId });
      }
    }

    const neededTokens = {}; // TokenId -> bool

    forEachPermission(this.getPermissions(grainId, vertexId).array, (permissionId) => {
      pushVertex(grainId, vertexId, permissionId);
    });

    while (stack.length > 0) {
      const current = stack.pop();
      const variable = this.getVariable(current.grainId, current.vertexId, current.permissionId);
      const tokenId = variable.responsibleTokenId;
      if (tokenId) {
        const token = this.tokensById[tokenId];

        if (token.grainId && !token.objectId) {
          let sharerId = token.parentToken ? "t:" + token.parentToken : "i:" + token.accountId;
          pushVertex(token.grainId, sharerId, current.permissionId);
        } else if (token.parentToken) {
          pushVertex("tokenValid", "t:" + token.parentToken, "canAccess");
        }

        if (!neededTokens[tokenId]) {
          neededTokens[tokenId] = true;
          if (token.requirements) {
            token.requirements.forEach((requirement) => {
              if (requirement.permissionsHeld) {
                const held = requirement.permissionsHeld;
                const reqVertexId = held.accountId ? "i:" + held.accountId : "t:" + held.tokenId;
                forEachPermission(requirement.permissionsHeld.permissions, (permissionId) => {
                  pushVertex(requirement.permissionsHeld.grainId, reqVertexId, permissionId);
                });
              } else if (requirement.tokenValid) {
                pushVertex("tokenValid", "t:" + requirement.tokenValid, "canAccess");
              }
            });
          }
        }
      }
    }

    return { tokenIds: Object.keys(neededTokens), grainIds: Object.keys(visited) };
  }
}

function computeRelevantTokens(context, grainId, vertexId) {
  // Finds all tokens in `context` that could possibly carry permissions of the grain `grainId` to
  // the vertex `vertexId` -- that is, all tokens that are contained in a path starting at the
  // grain owner and ending at `vertexId`. Ignores any requirements that those tokens might be
  // conditional upon.
  //
  // Returns an object with two fields:
  //    tokenIds: list of relevant token IDs.
  //    ownerEdges: objects of the form { accountId: String, role: RoleAssignment }, representing
  //                initial pseudo-edges in the graph. `accountId` is typically
  //                the grain's owning user, but for the case of a legacy public grain it could
  //                be any user.
  //
  // Works by traversing the sharing graph twice: first backwards starting from `vertexId`, then
  // forwards starting from the grain owner using only those tokens touched in the first step.
  //
  // `context` contains all the information from the database which is available for now. This call
  // will not make any new database lookups; edges not listed in `context` will not be considered
  // (as if they'd been revoked).

  check(context, Context);
  check(grainId, String);
  check(vertexId, String);

  const grain = context.grains[grainId];
  if (!grain) return { tokenIds: [], ownerEdges: [] };
  const viewInfo = grain.cachedViewInfo || {};

  const vertexStack = []; // Vertex IDs that we need to explore.
  const visitedVertexIds = {}; // Set of vertex IDs that we have already enqueued to get explored.

  visitedVertexIds[vertexId] = true;
  vertexStack.push(vertexId);

  const visitedTokensBySharerId = {};
  const ownerEdges = [];

  // Repeatedly pop a vertex from the stack, find all its incoming edges (i.e. all other vertexes
  // that share permissions to this vertex), and push those vertexes onto the stack.
  while (vertexStack.length > 0) {
    const vertexId = vertexStack.pop();

    let incomingEdges = [];
    // List of edges in the sharing graph ending at this vertex. Each is an object with the fields:
    //     sharerId: The vertex ID of the edge's source.
    //     token: the token object backing this edge, if there is one.

    function tokenToEdge(token) {
      // Convert an ApiToken into an edge.
      return {
        token: token,
        sharerId: token.parentToken ? "t:" + token.parentToken : "i:" + token.accountId,
      };
    }

    if (vertexId.slice(0, 2) === "o:") {
      // Owner. We don't need to do anything.
      incomingEdges = [];
    } else if (vertexId.slice(0, 2) === "t:") {
      // A webkey token. Extract it from the context (or ignore if it isn't present).
      const token = context.tokensById[vertexId.slice(2)];
      if (token) {
        incomingEdges = [tokenToEdge(token)];
      }
    } else if (vertexId.slice(0, 2) === "i:") {
      // A user.
      const accountId = vertexId.slice(2);
      if (accountId === grain.userId) {
        // This is the owner.
        incomingEdges = [{ sharerId: "o:Owner" }];
        ownerEdges.push({ accountId: accountId, role: { allAccess: null } });
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
        incomingEdges = [{ sharerId: "o:Owner" }];
        ownerEdges.push({ accountId: accountId, role: { none: null } });
      } else {
        // Not a special case. Gather all tokens where this user is the recipient.
        incomingEdges = ((context.tokensByRecipient[grainId] || {})[vertexId.slice(2)] || [])
          .map(tokenToEdge);
      }
    } else {
      throw new Meteor.Error(500, "Unrecognized vertex ID: " + vertexId);
    }

    // For each edge incoming to this vertex, backpropagate this vertex's PermissionFlow to the
    // source vertex, joining it with the edge's constraints.
    incomingEdges.forEach((edge) => {
      const sharerId = edge.sharerId;
      if (edge.token) {
        if (!visitedTokensBySharerId[sharerId]) {
          visitedTokensBySharerId[sharerId] = {};
        }

        visitedTokensBySharerId[sharerId][edge.token._id] = edge.token;
      }

      if (!visitedVertexIds[sharerId]) {
        // Never saw this vertex before.
        visitedVertexIds[sharerId] = true;
        vertexStack.push(sharerId);
      }

    });
  }

  // Now walk forward from the owner.
  const relevantTokens = {};
  const visitedSharers = {};

  const sharerStack = [];
  sharerStack.push("i:" + grain.userId);
  while (sharerStack.length > 0) {
    const sharerId = sharerStack.pop();
    for (const tokenId in visitedTokensBySharerId[sharerId]) {
      relevantTokens[tokenId] = true;
      const token = visitedTokensBySharerId[sharerId][tokenId];
      const recipientId = vertexIdOfTokenOwner(token);

      if (!visitedSharers[recipientId]) {
        visitedSharers[recipientId] = true;
        sharerStack.push(recipientId);
      }
    }
  }

  return {
    tokenIds: Object.keys(relevantTokens),
    ownerEdges: ownerEdges,
  };
}

const vertexPattern = Match.OneOf(
  { token: Match.ObjectIncluding({ _id: String, grainId: String }) },
  {
    grain: Match.ObjectIncluding({
      _id: String,
      accountId: Match.OneOf(String, null, undefined),
    }),
  },
);
// A vertex in the sharing graph is a principal, e.g. a user or a token. Complicating
// matters, we may have to traverse sharing graphs for multiple grains in the same computation. A
// token is specific to one grain, but a user of course can have access to multiple grains, so in
// the case of a user we represent the vertex as a (user, grain) pair.
//
// TODO(cleanup): Perhaps `grain` should be renamed to `user`? In the common case
//   where only a single grain's shares need to be considered, it feels weird to think of the
//   grain ID as being the primary distinguishing feature of the vertex.

SandstormPermissions.mayOpenGrain = function (db, vertex) {
  // Determines whether the vertex is allowed to open the grain. May make multiple database
  // queries.

  check(vertex, vertexPattern);
  const grainId = vertex.token ? vertex.token.grainId : vertex.grain._id;
  const vertexId = vertex.token ? ("t:" + vertex.token._id) : "i:" + vertex.grain.accountId;
  const context = new Context();
  const emptyPermissions = new PermissionSet([]);
  return !!context.tryToProve(grainId, vertexId, emptyPermissions, db);
};

class CompoundObserveHandle {
  constructor() {
    this._handles = [];
  }

  push(handle) {
    this._handles.push(handle);
  }

  stop() {
    this._handles.forEach((handle) => handle.stop());
  }
}

SandstormPermissions.grainPermissions = function (db, vertex, viewInfo, onInvalidated) {
  // Computes the set of permissions received by `vertex`. Returns an object with a
  // `permissions` field containing the computed permissions. If the field is null then
  // the `vertex` does not even have the base "allowed to access at all" permission.
  //
  // `onInvalidated` is an optional callback. If provided, it will be called when the result
  // has been invalidated. If `onValidated` is provided, the result of `grainPermissions` will
  // have a `observeHandle` field, containing an object with a `stop()` method that must be
  // called once the computation becomes no longer relevant.

  check(db, SandstormDb);
  check(vertex, vertexPattern);
  const grainId = vertex.token ? vertex.token.grainId : vertex.grain._id;
  const vertexId = vertex.token ? ("t:" + vertex.token._id) : "i:" + vertex.grain.accountId;

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
    if (observeHandle) {
      observeHandle.stop();
      observeHandle = null;
    }

    const context = new Context();
    const allPermissions = PermissionSet.fromRoleAssignment({ allAccess: null }, viewInfo);
    const firstPhasePermissions = context.tryToProve(grainId, vertexId, allPermissions, db);

    if (!firstPhasePermissions) break; // No permissions; give up now.

    const needed = context.getResponsibleTokens(grainId, vertexId);
    const neededTokens = needed.tokenIds;
    const neededGrains = needed.grainIds;

    // Phase 2: Now let's verify those permissions.

    context.reset();

    let invalidated = false;
    function guardedOnInvalidated() {
      const shouldCall = onInvalidatedActive && !invalidated;
      invalidated = true;
      if (shouldCall) {
        onInvalidated();
      }
    }

    const tokenCursor = db.collections.apiTokens.find({
      _id: { $in: neededTokens },
      revoked: { $ne: true },
      suspended: { $ne: true },
      objectId: { $exists: false },
    });

    if (onInvalidated) {
      observeHandle = new CompoundObserveHandle();
      observeHandle.push(tokenCursor.observe({
        changed(newApiToken, oldApiToken) {
          if (newApiToken.trashed ||
              !_.isEqual(newApiToken.roleAssignment, oldApiToken.roleAssignment) ||
              !_.isEqual(newApiToken.suspended, oldApiToken.suspended) ||
              !_.isEqual(newApiToken.revoked, oldApiToken.revoked)) {
            observeHandle.stop();
            guardedOnInvalidated();
          }
        },

        removed(oldApiToken) {
          observeHandle.stop();
          guardedOnInvalidated();
        },
      }));

      const grainCursor = db.collections.grains.find({ _id: { $in: neededGrains } });
      observeHandle.push(grainCursor.observe({
        changed(newGrain, oldGrain) {
          if (newGrain.trashed || newGrain.suspended ||
              (!oldGrain.private && newGrain.private)
             ) {
            observeHandle.stop();
            guardedOnInvalidated();
          }
        },

        removed(oldGrain) {
          observeHandle.stop();
          guardedOnInvalidated();
        },
      }));
    }

    context.addTokensFromCursor(tokenCursor);

    // TODO(someday): Also account for accounts losing admin privileges. Currently we do not call
    //   `onInvalided()` on such events. We would need to set up more cursor observers.

    resultPermissions = context.tryToProve(grainId, vertexId, firstPhasePermissions);

    if (resultPermissions && firstPhasePermissions.isSubsetOf(resultPermissions)) {
      // We've confirmed the permissions that we found the in the first phase. Done!
      break;
    }
  } // for (let attemptCount ...) {

  onInvalidatedActive = true;
  const result = {};
  result.permissions = (resultPermissions && resultPermissions.array) || null;
  result.observeHandle = observeHandle || new CompoundObserveHandle();
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
                          { grain: Match.ObjectIncluding({ _id: String, accountId: String }) }));

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
                                  revoked: { $ne: true },
                                  suspended: { $ne: true },
                                }).forEach(function (token) {
    tokensById[token._id] = token;
    if (token.parentToken) {
      if (!tokensByParent[token.parentToken]) {
        tokensByParent[token.parentToken] = [];
      }

      tokensByParent[token.parentToken].push(token);
    } else if (token.accountId) {
      if (!tokensBySharer[token.accountId]) {
        tokensBySharer[token.accountId] = [];
      }

      tokensBySharer[token.accountId].push(token);
    }
  });

  if (root.token) {
    addChildren(root.token._id);
  } else if (root.grain) {
    addSharedTokens(root.grain.accountId);
  }

  while (tokenStack.length > 0) {
    const token = tokenStack.pop();
    result.push(token);
    addChildren(token._id);
    if (token.owner && token.owner.user) {
      addSharedTokens(token.owner.user.accountId);
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

const LocalizedString = {
  defaultText: String,
  localizations: Match.Optional([
     { locale: String, text: String },
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
  check(provider, Match.OneOf({ accountId: String, identityId: Match.Optional(String) /*obsolete*/ },
                              { rawParentToken: Match.OneOf(String, Buffer) }));
  check(owner, Match.OneOf({
    webkey: Match.OneOf(null, {
      forSharing: Boolean,
      expiresIfUnusedDuration: Match.Optional(Number),
    }),
  }, {
    user: {
      accountId: String,
      identityId: Match.Optional(String),  // obsolete
      title: String,
      renamed: Match.Optional(Boolean),
      upstreamTitle: Match.Optional(String),
      seenAllActivity: Match.Optional(Boolean),
    },
  }, {
    grain: {
      grainId: String,
      saveLabel: LocalizedString,
      introducerIdentity: Match.Optional(String),  // obsolete
      introducerUser: Match.Optional(String),  // obsolete
    },
  }, {
    clientPowerboxRequest: {
      grainId: String,
      sessionId: String,
      introducerIdentity: Match.Optional(String),  // obsolete
    },
  }, {
    frontend: null,
  }));

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
  if (encodeURIComponent(token) !== token) {
    // Sandstorm guarantees that tokens with a `clientPowerboxRequest` owner are URL-safe.
    // `Random.secret()` only uses base64url characters, so we should never get here.
    throw new Meteor.Error(500, "Random.secret() returned a non-URL safe token: " + token);
  }

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

    apiToken.accountId = parentApiToken.accountId;

    apiToken.parentToken = parentToken;
    result.parentApiToken = parentApiToken;
  } else if (provider.accountId) {
    apiToken.accountId = provider.accountId;
  }

  let oldUserIdentityToRemove = null;

  if (owner.webkey) {
    // Non-null webkey is a special case not covered in ApiTokenOwner.
    // TODO(cleanup): Maybe ApiTokenOwner.webkey should be extended with these fields?
    apiToken.owner = { webkey: null };
    apiToken.forSharing = parentForSharing || owner.webkey.forSharing;
    if (owner.webkey.expiresIfUnusedDuration) {
      apiToken.expiresIfUnused = new Date(Date.now() + owner.webkey.expiresIfUnusedDuration);
    }
  } else if (owner.user) {
    // Determine the user's identity ID (their user ID as seen by the grain).
    const identityId = db.getOrGenerateIdentityId(owner.user.accountId, grain);
    oldUserIdentityToRemove = identityId;

    const grainInfo = db.getDenormalizedGrainInfo(grainId);
    apiToken.owner = {
      user: {
        accountId: owner.user.accountId,
        identityId: identityId,
        title: owner.user.title,
        denormalizedGrainMetadata: grainInfo,
      },
    };

    if (grain.title !== owner.user.title) {
      apiToken.owner.user.upstreamTitle = grain.title;
    }
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

  if (oldUserIdentityToRemove) {
    // Remove the oldUsers entry that is no longer relevant.
    db.collections.grains.update({_id: grainId},
        {$pull: { oldUsers: { identityId: oldUserIdentityToRemove } } });
  }

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

SandstormPermissions.cleanupClientPowerboxTokens = function (db) {
  return function () {
    const tenMinutesAgo = new Date(Date.now() - 1000 * 60 * 10);
    db.removeApiTokens({
      $or: [
        { "owner.clientPowerboxRequest": { $exists: true } },
        { "owner.clientPowerboxOffer": { $exists: true } },
      ],
      created: { $lt: tenMinutesAgo },
    });
  };
};

Meteor.methods({
  transitiveShares: function (obsolete, grainId) {
    check(grainId, String);
    if (this.userId) {
      const db = this.connection.sandstormDb;
      return SandstormPermissions.downstreamTokens(db,
          { grain: { _id: grainId, accountId: this.userId } });
    }
  },

  newApiToken: function (provider, grainId, petname, roleAssignment, owner, unauthenticated) {
    check(provider, Match.OneOf({ identityId: String },  // obsolete
                                { accountId: String },
                                { rawParentToken: String }));
    if (!owner.user && !owner.webkey) {
      throw new Meteor.Error(403,
                             "'webkey' and 'user' are the only allowed owners in newApiToken()");
    }

    // other check()s happen in SandstormPermissions.createNewApiToken().
    const db = this.connection.sandstormDb;
    if (provider.identityId) {
      provider.accountId = this.userId;
      delete provider.identityId;
    } else if (provider.accountId) {
      if (provider.accountId !== this.userId) {
        throw new Meteor.Error(403, "Not the current user: " + provider.accountId);
      }
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
                      revoked: Match.Optional(Boolean),
                      suspended: Match.Optional(Boolean), });

    if (!this.userId) {
      throw new Meteor.Error(403, "Must be logged in to modify a token");
    }

    const apiToken = db.collections.apiTokens.findOne(token);
    if (!apiToken) {
      throw new Meteor.Error(404, "No such token found.");
    }

    if (apiToken.accountId === this.userId) {
      const modifier = { $set: newFields };
      db.collections.apiTokens.update(token, modifier);
    } else {
      throw new Meteor.Error(403, "User not authorized to modify this token.");
    }
  },
});
