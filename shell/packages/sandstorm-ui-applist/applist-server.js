Meteor.publish("userPackages", function() {
  // Users should be able to see packages that are either:
  // 1. referenced by one of their userActions
  // 2. referenced by one of their grains
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

  this.onStop(function () {
    actionsHandle.stop();
    grainsHandle.stop();
  });
  this.ready();
});
