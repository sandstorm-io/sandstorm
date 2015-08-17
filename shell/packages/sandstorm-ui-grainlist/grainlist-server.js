// Publish _id, packageId, and lastUsed for grains that you have an API token for.
Meteor.publish('sharedGrainInfo', function() {
  // Non-logged-in users don't get a "shared with me" list.
  // TODO(someday): Maybe store a list of tokens in localStorage client-side?
  if (!this.userId) { return []; }

  // TODO(perf): This is possibly really inefficient to create a new subscription for each
  //   grain. Fortunately we only need it for "shared with me" grains, but if someday users
  //   have thousansd of grains shared with them this could get really slow. Need something
  //   better.
  var self = this;
  var db = this.connection.sandstormDb;
  var grainRefcounts = {};
  var grainSubs = {};
  var refGrain = function (grainId) {
    if (!(grainId in grainRefcounts)) {
      grainRefcounts[grainId] = 0;
      var thisGrainQuery = db.collections.grains.find(
          grainId, {fields: {packageId: 1, lastUsed: 1}});
      var thisGrainSub = thisGrainQuery.observe({
        added: function(grain) {
          self.added("grains", grain._id, {
            packageId: grain.packageId,
            lastUsed: grain.lastUsed,
          });
        },
        removed: function(grain) {
          self.removed("grains", grain._id);
        },
        updated: function(oldGrain, newGrain) {
          if (oldGrain.packageId !== newGrain.packageId ||
              oldGrain.lastUsed !== newGrain.lastUsed) {
            self.changed("grains", newGrain._id, {
              packageId: newGrain.packageId,
              lastUsed: newGrain.lastUsed,
            });
          }
        }
      });
      grainSubs[grainId] = thisGrainSub;
    }
    ++grainRefcounts[grainId];
  };
  var unrefGrain = function (grainId) {
    if (--grainRefcounts[grainId] === 0) {
      delete grainRefcounts[grainId];
      var sub = grainSubs[grainId];
      delete grainSubs[grainId];
      sub.stop();
    }
  };

  // TODO(now): TODO(security): This reveals information (package ID, last activity time, and
  //   existence) of REVOKED tokens. Computing whether or not tokens have been revoked is
  //   probably too inefficient to do here. In fact, revealing package ID even to non-revoked
  //   sharees is arguably wrong since the package could be private, and having the package ID
  //   is sufficient to install the app.
  var apiTokens = db.collections.apiTokens.find({'owner.user.userId': this.userId});
  var apiTokensHandle = apiTokens.observe({
    added: function(newToken) {
      refGrain(newToken.grainId);
    },
    removed: function(oldToken) {
      unrefGrain(oldToken.grainId);
    },
    updated: function(oldToken, newToken) {
      if (oldToken.grainId !== newToken.grainId) {
        unrefGrain(oldToken.grainId);
        refGrain(newToken.grainId);
      }
    }
  });
  this.onStop(function () {
    apiTokensHandle.stop();
    var cleanupSubs = function(subs) {
      var ids = Object.keys(subs);
      for (var i = 0 ; i < ids.length ; i++) {
        var id = ids[i];
        subs[id].stop();
        delete subs[id];
      }
    };
    cleanupSubs(grainSubs);
  });
  self.ready();
});

