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

var Crypto = Npm.require("crypto");

function Permissions(array) {
  if (!array) {
    this.array = [];
  } else if (array instanceof Array) {
    this.array = array;
  } else {
    throw new Error("don't know how to interpret as Permissions: " + array);
  }
}

function permissionsFromRoleAssignment(roleAssignment, viewInfo) {
  var result;
  if ("allAccess" in roleAssignment) {
    var length = 0;
    if (viewInfo.permissions) {
      length = viewInfo.permissions.length;
    }
    var array = new Array(length);
    for (var ii = 0; ii < array.length; ++ii) {
      array[ii] = true;
    }
    result = new Permissions(array);
  } else if ("roleId" in roleAssignment) {
    if (viewInfo.roles && viewInfo.roles.length > 0) {
      result = new Permissions(viewInfo.roles[roleAssignment.roleId].permissions);
    } else {
      result = new Permissions([]);
    }
  }

  result.union(new Permissions(roleAssignment.addPermissions));
  result.remove(new Permissions(roleAssignment.removePermissions));
  return result;
}

Permissions.prototype.union = function(other) {
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

Permissions.prototype.remove = function(other) {
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

Permissions.prototype.intersection = function(other) {
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

roleAssignmentKeyPermissions = function (key, viewInfo) {
  var result = grainPermissionsInternal(key.grainId, key.sharer, viewInfo);
  var edge = permissionsFromRoleAssignment(key.roleAssignment, viewInfo);
  result.intersection(edge);
  return result.array;
}

function grainPermissionsInternal(grainId, userId, viewInfo) {
  var grain = Grains.findOne(grainId);
  var owner = grain.userId;

 // userId -> Permissions
  var permissionsMap = {}
  permissionsMap[owner] = permissionsFromRoleAssignment({allAccess: null}, viewInfo);

  var userStack = [owner];
  var user;

  while (userStack.length > 0) {
    var user = userStack.pop();
    RoleAssignments.find({active: true, sharer: user, grainId : grainId}).forEach(function (outEdge) {
      var recipient = outEdge.recipient;
      var sharer = outEdge.sharer;
      var changed = false;
      if (!permissionsMap[recipient]) {
        changed = true;
        permissionsMap[recipient] = new Permissions();
      }
      var newPermissions = permissionsFromRoleAssignment(outEdge.roleAssignment, viewInfo);
      newPermissions.intersection(permissionsMap[sharer]);
      if (permissionsMap[recipient].union(newPermissions)) {
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
    return new Permissions();
  }
}

grainPermissions = function (grainId, userId, viewInfo) {
  return grainPermissionsInternal(grainId, userId, viewInfo).array;
}

defaultSharedGrainPermissions = function(grainId, userId, viewInfo) {
  var result = grainPermissionsInternal(grainId, userId, viewInfo);
  var edge = permissionsFromRoleAssignment({roleId: 0}, viewInfo);
  result.intersection(edge);
  return result.array;
}

mayOpenGrain = function(grainId, userId) {
  if (!userId) { return false; }

  var grain = Grains.findOne(grainId);
  if (!grain) {
    return false;
  }
  var owner = grain.userId;
  if (userId == owner) {
    return true;
  }

  var stackedUsers = {}
  stackedUsers[userId] = true;

  var userStack = [userId];
  var user;

  while (userStack.length > 0) {
    user = userStack.pop();
    var edges = RoleAssignments.find({active: true, recipient: user, grainId : grainId}).fetch();
    for (var ii = 0; ii < edges.length; ++ii) {
      var inEdge = edges[ii];
      var sharer = inEdge.sharer;
      if (sharer == owner) {
        console.log("ALLOWED TO OPEN GRAIN");
        return true;
      }
      if (!stackedUsers[sharer]) {
        userStack.push(sharer);
        stackedUsers[sharer] = true;
      }
    }
  }
  console.log("NOT ALLOWED TO OPEN GRAIN");
  return false;

}

Meteor.methods({
  newRoleAssignmentKey: function(grainId, petname, title, roleId) {
    check(grainId, String);
    check(petname, String);
    check(title, String);
    check(roleId, Match.Integer);
    if (!this.userId) {
      throw new Meteor.Error(403, "Must be signed in.");
    }
    var key = Random.secret();
    RoleAssignmentKeys.insert({
      _id : Crypto.createHash("sha256").update(key).digest("base64"),
      grainId : grainId,
      sharer : this.userId,
      roleAssignment : {roleId : roleId},
      petname : petname,
      created : new Date(),
    });

    return key;
  },
});

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

  RoleAssignmentKeys.find().observe({
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
