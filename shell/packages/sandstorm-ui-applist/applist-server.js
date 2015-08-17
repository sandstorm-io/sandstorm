Meteor.publish("userPackages", function() {
  // Users should be able to see packages that are any of:
  // 1. referenced by one of their userActions
  // 2. referenced by one of their grains
  // 3. referenced by the grain of an ApiToken they possess
  // Sadly, this is rather a pain to make reactive.  This could probably benefit from some
  // refactoring or being turned into a library that handles reactive server-side joins.
  var self = this;
  var db = this.connection.sandstormDb;

  // Note that package information, once it is in the database, is static. There's no need to
  // reactively subscribe to changes to a package since they don't change. It's also unecessary
  // to reactively remove a package from the client side when it is removed on the server, or
  // when the client stops using it, because the worst case is the client has a small amount
  // of extra info on a no-longer-used package held in memory until they refresh Sandstorm.
  // So, we implement this as a cache: the first time each package ID shows up among the user's
  // stuff, we push the package info to the client, and then we never update it.
  //
  // Alternatively, we could subscribe to each individual package query, but this would waste
  // lots of server-side resources watching for events that will never happen or don't matter.
  var hasPackage = {};
  var cachedPackageRefcounts = {};
  var refPackage = function (packageId) {
    // Ignore dev apps.
    if (packageId.lastIndexOf("dev-", 0) === 0) return;

    if (!hasPackage[packageId]) {
      hasPackage[packageId] = true;
      var pkg = db.collections.packages.findOne(packageId);
      if (pkg) {
        self.added("packages", packageId, pkg);
      } else {
        console.error(
            "shouldn't happen: missing package referenced by user's stuff:", packageId);
      }
    }
  };

  // Refcounting and subscription-tracking for grains
  // TODO(perf): This is possibly really inefficient to create a new subscription for each
  //   grain. Fortunately we only need it for "shared with me" grains, but if someday users
  //   have thousansd of grains shared with them this could get really slow. Need something
  //   better.
  var cachedGrainRefcounts = {};
  var cachedGrainSubscriptions = {};
  var refGrain = function (grainId) {
    if (!(grainId in cachedGrainRefcounts)) {
      cachedGrainRefcounts[grainId] = 0;
      var thisGrainQuery = db.collections.grains.find({_id: grainId});
      var thisGrainSub = thisGrainQuery.observe({
        added: function(grain) {
          refPackage(grain.packageId);
        },
        updated: function(oldGrain, newGrain) {
          refPackage(newGrain.packageId);
        }
      });
      cachedGrainSubscriptions[grainId] = thisGrainSub;
    }
    ++cachedGrainRefcounts[grainId];
  };
  var unrefGrain = function (grainId) {
    if (--cachedGrainRefcounts[grainId] === 0) {
      delete cachedGrainRefcounts[grainId];
      var sub = cachedGrainSubscriptions[grainId];
      delete cachedGrainSubscriptions[grainId];
      sub.stop();
    }
  };

  // package source 1: packages referred to by actions
  var actions = db.userActions(this.userId, {}, {});
  var actionsHandle = actions.observe({
    added: function(newAction) {
      refPackage(newAction.packageId);
    },
    updated: function(oldAction, newAction) {
      refPackage(newAction.packageId);
    }
  });

  // package source 2: packages referred to by grains directly
  var grains = db.userGrains(this.userId, {}, {});
  var grainsHandle = grains.observe({
    added: function(newGrain) {
      refPackage(newGrain.packageId);
    },
    updated: function(oldGrain, newGrain) {
      refPackage(newGrain.packageId);
    }
  });

  // package source 3: packages referred to by grains referred to by apiTokens.
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
    actionsHandle.stop();
    grainsHandle.stop();
    apiTokensHandle.stop();
    // Clean up intermediate subscriptions too
    var cleanupSubs = function(subs) {
      var ids = Object.keys(subs);
      for (var i = 0 ; i < ids.length ; i++) {
        var id = ids[i];
        subs[id].stop();
        delete subs[id];
      }
    };
    cleanupSubs(cachedGrainSubscriptions);
  });
  this.ready();
});
