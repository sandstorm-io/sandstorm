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

function PermissionSet(array) {
  // A wrapper around an array of booleans.

  if (!array) {
    this.array = [];
  } else if (array instanceof Array) {
    this.array = array.slice(0);
  } else {
    throw new Error("don't know how to interpret as PermissionSet: " + array);
  }
}

// Methods for mutating a PermissionSet by combining it with another PermissionSet.
// These return a boolean indicating whether the operation had any effect.

PermissionSet.prototype.add = function(other) {
  var changed = false;
  for (var ii = 0; ii < other.array.length; ++ii) {
    var old = this.array[ii];
    this.array[ii] = this.array[ii] || other.array[ii];
    if (old != this.array[ii]) {
      changed = true;
    }
  }
  return changed;
}

PermissionSet.prototype.remove = function(other) {
  var changed = false;
  for (var ii = 0; ii < other.array.length && ii < this.array.length; ++ii) {
    var old = this.array[ii];
    this.array[ii] = this.array[ii] && !other.array[ii];
    if (old != this.array[ii]) {
      changed = true;
    }
  }
  return changed;
}

PermissionSet.prototype.intersect = function(other) {
  var changed = false;
  for (var ii = 0; ii < this.array.length; ++ii) {
    var old = this.array[ii];
    this.array[ii] = this.array[ii] && other.array[ii];
    if (old != this.array[ii]) {
      changed = true;
    }
  }
  return changed;
}

function roleAssignmentPermissions(roleAssignment, viewInfo) {
  var result = new PermissionSet([]);
  if (!roleAssignment) {
    return result;
  }

  if ("allAccess" in roleAssignment) {
    var length = 0;
    if (viewInfo.permissions) {
      length = viewInfo.permissions.length;
    }
    var array = new Array(length);
    for (var ii = 0; ii < array.length; ++ii) {
      array[ii] = true;
    }
    result = new PermissionSet(array);
  } else if ("roleId" in roleAssignment && viewInfo.roles && viewInfo.roles.length > 0) {
    var roleDef = viewInfo.roles[roleAssignment.roleId];
    if (roleDef) {
      result = new PermissionSet(roleDef.permissions);
    }
  } else if ("none" in roleAssignment && viewInfo.roles) {
    for (var ii = 0; ii < viewInfo.roles.length; ++ii) {
      var roleDef = viewInfo.roles[ii];
      if (roleDef.default) {
        result = new PermissionSet(roleDef.permissions);
        break;
      }
    }
  }

  result.add(new PermissionSet(roleAssignment.addPermissionSet));
  result.remove(new PermissionSet(roleAssignment.removePermissionSet));
  return result;
}

function grainPermissionsInternal(grainId, openerUserId, viewInfo) {
  // Computes the permissions of a user who is opening a grain.

  var grain = Grains.findOne(grainId);

  if (!grain.private) {
    // Grains using the old sharing model always share the default role to anyone who has the
    // grain URL.
    return roleAssignmentPermissions({none: null}, viewInfo);
  }

  if (!openerUserId) { return new PermissionSet(); }
  var owner = grain.userId;
  if (openerUserId == owner) {
    // Optimization: return early in this easy and common case.
    return roleAssignmentPermissions({allAccess: null}, viewInfo);
  }

  var permissionsMap = {};
  // Keeps track of the permissions that the opener receives from each user. The final result of
  // our computation will be stored in permissionsMap[owner].

  permissionsMap[openerUserId] = roleAssignmentPermissions({allAccess: null}, viewInfo);
  permissionsMap[owner] = new PermissionSet();

  var userStack = [openerUserId];
  var edgesByRecipient = {};
  RoleAssignments.find({active: true, grainId: grainId}).forEach(function (edge) {
    if (!edgesByRecipient[edge.recipient]) {
      edgesByRecipient[edge.recipient] = []
    }
    edgesByRecipient[edge.recipient].push(edge);
  });

  while (userStack.length > 0) {
    var recipient = userStack.pop();
    if (edgesByRecipient[recipient]) {
      edgesByRecipient[recipient].forEach(function (inEdge) {
        var sharer = inEdge.sharer;
        if (!permissionsMap[sharer]) {
          permissionsMap[sharer] = new PermissionSet();
        }
        var newPermissions = roleAssignmentPermissions(inEdge.roleAssignment, viewInfo);
        newPermissions.intersect(permissionsMap[recipient]);

        // Optimization: we don't care about permissions that we've already proven the opener has.
        newPermissions.remove(permissionsMap[owner]);

        if (permissionsMap[sharer].add(newPermissions)) {
          userStack.push(sharer);
        }
      });
    }
  }

  return permissionsMap[owner];
}

apiTokenPermissions = function (token, viewInfo) {
  var result = grainPermissionsInternal(token.grainId, token.userId, viewInfo);
  var edge = roleAssignmentPermissions(token.roleAssignment, viewInfo);
  result.intersect(edge);
  return result.array;
}

grainPermissions = function (grainId, userId, viewInfo) {
  return grainPermissionsInternal(grainId, userId, viewInfo).array;
}

mayOpenGrain = function(grainId, userId) {
  // Determines whether the user is allowed to open the grain by searching depth first
  // for a path of active role assignments leading from the grain owner to the user.

  var grain = Grains.findOne(grainId);
  if (!grain) { return false; }
  if (!grain.private) { return true; }
  if (!userId) { return false; }
  var owner = grain.userId;
  if (userId == owner) {
    return true;
  }

  var stackedUsers = {userId : true};
  var userStack = [userId];
  var edgesByRecipient = {};
  RoleAssignments.find({active: true, grainId: grainId}).forEach(function (edge) {
    if (!edgesByRecipient[edge.recipient]) {
      edgesByRecipient[edge.recipient] = []
    }
    edgesByRecipient[edge.recipient].push(edge);
  });

  while (userStack.length > 0) {
    var recipient = userStack.pop();
    var edges = edgesByRecipient[recipient];
    if (edges) {
      for (var ii = 0; ii < edges.length; ++ii) {
        var inEdge = edges[ii];
        var sharer = inEdge.sharer;
        if (sharer == owner) {
          return true;
        }
        if (!stackedUsers[sharer]) {
          userStack.push(sharer);
          stackedUsers[sharer] = true;
        }
      }
    }
  }
  return false;
}
