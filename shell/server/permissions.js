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
    this.array = array;
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
  }

  result.add(new PermissionSet(roleAssignment.addPermissionSet));
  result.remove(new PermissionSet(roleAssignment.removePermissionSet));
  return result;
}

function grainPermissionsInternal(grainId, userId, viewInfo) {
  // Computes the permissions of the user by propagating permissions out from the grain's
  // owner along role assignments until the graph is saturated.
  //
  // TODO(perf): This actually computes the permissions for *all* users. We should investigate ways
  // to share results between calls. It may also make sense to cache some graph-connectivity
  // information from the`mayOpenGrain()` computation to use here.

  var grain = Grains.findOne(grainId);
  var owner = grain.userId;

  // userId -> PermissionSet
  var permissionsMap = {}
  permissionsMap[owner] = roleAssignmentPermissions({allAccess: null}, viewInfo);

  var userStack = [owner];
  var user;

  while (userStack.length > 0) {
    var user = userStack.pop();
    RoleAssignments.find({active: true, sharer: user,
                          grainId : grainId}).forEach(function (outEdge) {
      var recipient = outEdge.recipient;
      var sharer = outEdge.sharer;
      var changed = false;
      if (!permissionsMap[recipient]) {
        changed = true;
        permissionsMap[recipient] = new PermissionSet();
      }
      var newPermissions = roleAssignmentPermissions(outEdge.roleAssignment, viewInfo);
      newPermissions.intersect(permissionsMap[sharer]);
      if (permissionsMap[recipient].add(newPermissions)) {
        changed = true;
      }
      if (changed) {
        userStack.push(recipient);
      }
    });
  }

  if (permissionsMap[userId]) {
    return permissionsMap[userId];
  } else {
    return new PermissionSet();
  }
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

  while (userStack.length > 0) {
    var user = userStack.pop();
    var edges = RoleAssignments.find({active: true, recipient: user, grainId : grainId}).fetch();
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
  return false;
}

Meteor.startup(function () {
  RoleAssignments.find().observe({
    changed : function (newRoleAssignment, oldRoleAssignment) {
      if (newRoleAssignment.active != oldRoleAssignment.active) {
        Sessions.remove({grainId: oldRoleAssignment.grainId,
                         userId : {$ne : oldRoleAssignment.sharer}});
      }
    },
    removed : function (oldRoleAssignment) {
      Sessions.remove({grainId: oldRoleAssignment.grainId,
                       userId : {$ne : oldRoleAssignment.sharer}});
    },
  });

  ApiTokens.find().observe({
    changed : function (newRoleAssignmentKey, oldRoleAssignmentKey) {
      // Anonymous users are the only ones allowed to open a grain directly from a
      // role assignment key.
      Sessions.remove({grainId: oldRoleAssignmentKey.grainId, userId: null});
    },
    removed : function (oldRoleAssignmentKey) {
      Sessions.remove({grainId: oldRoleAssignmentKey.grainId, userId: null});
    },
  });
});
