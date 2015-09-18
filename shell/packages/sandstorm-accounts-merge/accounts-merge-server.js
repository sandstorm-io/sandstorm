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

var Future = Npm.require("fibers/future");

promiseToFuture = function (promise) {
  var result = new Future();
  promise.then(result.return.bind(result), result.throw.bind(result));
  return result;
}

waitPromise = function (promise) {
  return promiseToFuture(promise).wait();
}

Meteor.methods({
  mergeWithAccount: function (token) {
    check(token, String);
    if (!this.userId) {
      throw new Meteor.Error(403, "Cannot merge accounts if not logged in.");
    }
    var hashed = Accounts._hashLoginToken(token);
    var winningUser = Meteor.users.findOne({"services.resume.loginTokens.hashedToken": hashed});

    if (!winningUser) {
      throw new Meteor.Error(404, "No account found for token: " + token);
    }

    var losingUser = Meteor.user();

    if (losingUser.merging) {
      throw new Meteor.Error(400, "Account is already being merged.");
    }

    // We need to verify that we can actually do the merge.
    // For now, this means that there is at most one instance of each service
    // in the two identities arrays.
    var servicesPresent = {};
    function verifyUnique(service) {
      if (service in servicesPresent) {
        throw new Meteor.Error(400, "Cannot merge accounts with duplicate service: " + service);
      }
      servicesPresent[service] = true;
    }
    winningUser.identities.forEach(function(identity) {
      verifyUnique(identity.service);
    });
    losingUser.identities.forEach(function(identity) {
      verifyUnique(identity.service);
    });

    // assert that there are no other pending merges?
    Meteor.users.update(losingUser._id,
                        {$set: {merging: {destinationUserId: winningUser._id, status: "pending",
                                          sourceIdentities: losingUser.identities,
                                          sourceServices: losingUser.services}},
                         $unset: {identities: 1, services: 1}});

  },

  unmergeToAccount: function (destUserId) {
    check(destUserId, String);
    if (!this.userId) {
      throw new Meteor.Error(403, "Cannot merge accounts if not logged in.");
    }
    var sourceUser = Meteor.user();
    if (!sourceUser.mergedUsers || sourceUser.mergedUsers.indexOf(destUserId) == -1) {
      throw new Meteor.Error(403, "Current user was never merged with user " + destUserId);
    }

    // Now look up the destination user to figure out which identities and services
    // to restore.

    var destUser = Meteor.users.findOne(destUserId);

    /// what if the status is still pending? Then we abort.
    var oldServices = destUser.merging && destUser.merging.status === "done" &&
        destUser.merging.sourceServices;

    if (!oldServices) {
      throw new Meteor.Error(400, "Cannot unmerge");
    }
    var oldIdentities = {};
    var servicesToRemove = {};
    destUser.merging.sourceIdentities.forEach(function(identity) {
      oldIdentities[identity.id] = identity;
      servicesToRemove["services." + identity.service] = 1;
    });

    var sourceIdentities = sourceUser.identities.filter(function (identity) {
      return identity.id in oldIdentities;
    });

    // TODO what about the case when there are multiple email identities
    // in a single emailToken service?

    // what about quota, login?
    Meteor.users.update(sourceUser._id,
                        {$set: {unmerging: {destinationUserId: destUserId, status: "pending",
                                            sourceIdentities: sourceIdentities,
                                            sourceServices: oldServices}},
                         $unset: servicesToRemove,
                         $pull: {identities: {id: {$in: Object.keys(oldIdentities)}},
                                 mergedUsers: destUserId} });
  }
});

SandstormAccountsMerge.registerObservers = function (db, backend) {

  Meteor.users.find({"merging.status": "pending"}).observe({
    added: function(losingUser) {
      console.log("merging user " + JSON.stringify(sourceUser));
      var winningUserId = losingUser.merging.destinationUserId;
      var winningUser = Meteor.users.findOne(winningUserId);

      if (winningUser.mergedUsers.indexOf(losingUser._id) == -1) {
        // Now let's construct a modifier that will update the new user.
        var fieldsToSet = {};
        var identitiesToPush = [];
        losingUser.merging.sourceIdentities.forEach(function(identity) {
          identitiesToPush.push(identity);
          if (identity.service === "dev") {
            fieldsToSet.devName = losingUser.devName;
          } else if (identity.service === "demo") {
            fieldsToSet.expires = losingUser.expires;
          } else if (identity.service === "github") {
            fieldsToSet["services.github"] = losingUser.merging.sourceServices.github;
          } else if (identity.service === "google") {
            fieldsToSet["services.google"] = losingUser.merging.sourceServices.google;
          } else if (identity.service === "emailToken") {
            fieldsToSet["services.emailToken"] = losingUser.merging.sourceServices.emailToken;
          }
        });

        var modifier = {$push: {identities: {$each: identitiesToPush},
                                mergedUsers: losingUser._id}};
        if (Object.keys(fieldsToSet).length > 0) {
          modifier["$set"] = fieldsToSet;
        }
        Meteor.users.update({_id: winningUserId}, modifier);
      }

      db.collections.notifications.update({userId: losingUser._id},
                                          {$set: {userId: winningUserId}},
                                          {multi: true});

      db.collections.userActions.find({userId: losingUser._id}).forEach(function (action) {
        var newAction = _.omit(action, "_id");
        newAction.userId = winningUserId;
        db.collections.userActions.upsert({userId: winningUserId, packageId: action.packageId,
                                           title: action.title, nounPhrase: action.nounPhrase,
                                           command: action.command},
                                          {$set: newAction});
      });

      var grains = Grains.find({userId: losingUser._id}).fetch();

      db.collections.grains.update({userId: losingUser._id},
                                   {$set: {userId: winningUserId}}, {multi: true});

      // Force all grains to shut down.
      grains.map(function (grain) {
        return backend.shutdownGrain(grain._id, losingUser._id, false);
      }).forEach(function (promise) {
        waitPromise(promise);
      });

      // Transfer grain storage to new owner.
      // Note: We don't parallelize this because it can cause some contention in the Blackrock
      //   back-end.
      grains.forEach(function (grain) {
        return waitPromise(backend.cap().transferGrain(grain.userId, grain._id, winningUserId));
      });

      var result = Meteor.users.update(losingUser._id, {$unset: {devName: 1, expires: 1},
                                                        $set: {"merging.status": "done"}});

    },
  });

  Meteor.users.find({"unmerging.status": "pending"}).observe({
    added: function(sourceUser) {
      console.log("unmerging user " + JSON.stringify(sourceUser));
      var destUserId = sourceUser.unmerging.destinationUserId;
      var servicesSetter = {};
      for (var key in sourceUser.unmerging.sourceServices) {
        servicesSetter["services." + key] = sourceUser.unmerging.sourceServices[key];
      }

      var destUser = Meteor.users.findOne(destUserId);
      if (destUser.merging) {
        Meteor.users.update(destUserId,
                            {$push: {identities: {$each: sourceUser.unmerging.sourceIdentities}},
                             $unset: {merging: 1},
                             $set: servicesSetter});
      }

      var sourceIdentityIds = sourceUser.unmerging.sourceIdentities.map(function (x) { return x.id; });

      var grains = Grains.find({userId: sourceUser._id, identityId: {$in: sourceIdentityIds}}).fetch();

      db.collections.grains.update({userId: sourceUser._id, identityId: {$in: sourceIdentityIds}},
                                   {$set: {userId: destUserId}},
                                   {multi: true});

      // Force all grains to shut down.
      grains.map(function (grain) {
        return backend.shutdownGrain(grain._id, sourceUser._id, false);
      }).forEach(function (promise) {
        waitPromise(promise);
      });

      // Transfer grain storage to new owner.
      // Note: We don't parallelize this because it can cause some contention in the Blackrock
      //   back-end.
      grains.forEach(function (grain) {
        return waitPromise(backend.cap().transferGrain(grain.userId, grain._id, destUserId));
      });

      var result = Meteor.users.update(sourceUser._id, {$unset: {"unmerging": 1}});
    },
  });

}
