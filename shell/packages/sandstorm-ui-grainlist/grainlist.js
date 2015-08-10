SandstormGrainList = function (db) {
  this._filter = new ReactiveVar("");
  this._staticHost = db.makeWildcardHost('static');
  var ref = this;
  if (Meteor.isServer) {
    // Publish _id, packageId, and lastUsed for grains that you have an API token for.
    Meteor.publish('sharedGrainInfo', function() {
      // TODO: figure out what to do for not-logged-in users viewing a grain with a sharing link.
      // For now, return an empty set for non-logged-in users.
      if (!this.userId) { return []; }
      var self = this;
      var grainRefcounts = {};
      var grainSubs = {};
      var refGrain = function (grainId) {
        if (grainRefcounts[grainId] === undefined) {
          grainRefcounts[grainId] = 0;
          var thisGrainQuery = db.collections.grains.find({_id: grainId});
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
              if (oldGrain.packageId !== newGrain.packageId || oldGrain.lastUsed !== newGrain.lastUsed) {
                self.changed("grains", newGrain._id, {
                  packageId: newGrain.packageId,
                  lastUsed: newGrain.lastUsed,
                });
              }
            }
          });
          grainSubs[grainId] = thisGrainSub;
        }
        grainRefcounts[grainId] = grainRefcounts[grainId] + 1;
      };
      var unrefGrain = function (grainId) {
        grainRefcounts[grainId] = grainRefcounts[grainId] - 1;
        if (grainRefcounts[grainId] === 0) {
          delete grainRefcounts[grainId];
          var sub = grainSubs[grainId];
          delete grainSubs[grainId];
          sub.stop();
        }
      };

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
  }
  if (Meteor.isClient) {
    var compileMatchFilter = function (searchString) {
      // split up searchString into an array of regexes, use them to match against item
      var searchKeys = searchString.toLowerCase()
          .split(" ")
          .filter(function(k) { return k != "";});
      return function matchFilter(item) {
        // special case: no text in filter should pass all items
        if (searchKeys.length === 0) return true;
        // Keep any item that matches any given substring
        var haystack = item.title.toLowerCase();
        for (var i = 0 ; i < searchKeys.length ; i++) {
          if (haystack.indexOf(searchKeys[i]) !== -1) {
            return true;
          }
        }
        return false;
      };
    };
    var mapGrainsToTemplateObject = function (grains) {
      // Do package lookup all at once, rather than doing N queries for N grains
      var packageIds = _.chain(grains)
          .pluck('packageId')
          .uniq()
          .value();
      var packages = db.collections.packages.find({ _id: { $in: packageIds } }).fetch();
      var packagesById = _.indexBy(packages, '_id');
      return grains.map(function(grain) {
        var pkg = packagesById[grain.packageId];
        var iconSrc = pkg ? iconSrcForPackage(pkg, 'grain', ref._staticHost) : "";
        var appTitle = (pkg && pkg.manifest && pkg.manifest.appTitle && pkg.manifest.appTitle.defaultText) || "";
        return {
          _id: grain._id,
          title: grain.title,
          appTitle: appTitle,
          lastUsed: grain.lastUsed,
          size: "0kb",
          iconSrc: iconSrc,
        };
      });
    };
    var mapApiTokensToTemplateObject = function (apiTokens) {
      var tokensForGrain = _.groupBy(apiTokens, 'grainId');
      var grainIdsForApiTokens = Object.keys(tokensForGrain);
      var sharedGrains = db.collections.grains.find({_id: {$in: grainIdsForApiTokens}}).fetch();
      var packageIds = _.chain(sharedGrains)
          .pluck('packageId')
          .uniq()
          .value();
      var packages = db.collections.packages.find({ _id: { $in: packageIds } }).fetch();
      var packagesById = _.indexBy(packages, '_id');
      return sharedGrains.map(function(grain) {
        var pkg = packagesById[grain.packageId];
        var iconSrc = pkg ? iconSrcForPackage(pkg, 'grain', ref._staticHost) : "";
        var appTitle = (pkg && pkg.manifest && pkg.manifest.appTitle && pkg.manifest.appTitle.defaultText) || "";
        // It's theoretically possible to have multiple API tokens for the same grain.
        // Pick one arbitrarily to assign the grain petname from.
        var token = tokensForGrain[grain._id][0];
        return {
          _id: grain._id,
          title: token.owner.user.title,
          appTitle: appTitle,
          lastUsed: grain.lastUsed,
          iconSrc: iconSrc,
        };
      });
    };
    var filteredSortedGrains = function() {
        var grains = db.currentUserGrains({}, {}).fetch();
        var itemsFromGrains = mapGrainsToTemplateObject(grains);
        var apiTokens = db.currentUserApiTokens().fetch();
        var itemsFromSharedGrains = mapApiTokensToTemplateObject(apiTokens);
        var filter = compileMatchFilter(ref._filter.get());
        return _.chain([itemsFromGrains, itemsFromSharedGrains])
            .flatten()
            .filter(filter)
            .sortBy('lastUsed') // TODO: allow sorting by other columns
            .reverse()
            .value();
    };
    Template.sandstormGrainList.helpers({
      filteredSortedGrains: filteredSortedGrains,
      searchText: function() {
        return ref._filter.get();
      }
    });
    Template.sandstormGrainList.onCreated(function () {
      Template.instance().subscribe("grainsMenu");
      Template.instance().subscribe("userPackages");
      Template.instance().subscribe("sharedGrainInfo");
    });
    Template.sandstormGrainList.events({
      "click tr": function(event) {
        var grainId = event.currentTarget.getAttribute('data-grainid');
        Router.go("grain", {grainId: grainId});
      },
      // We use keyup rather than keypress because keypress's event.target.value will not have
      // taken into account the keypress generating this event, so we'll miss a letter to filter by
      "keyup .search-bar": function(event) {
        ref._filter.set(event.target.value);
      },
      "keypress .search-bar": function(event) {
        if (event.keyCode == 13) {
          // Enter pressed.  If a single grain is shown, open it.
          var grains = filteredSortedGrains();
          if (grains.length == 1) {
            // Unique grain found with current filter.  Activate it!
            var grainId = grains[0]._id;
            // router.go grain/grainId?
            Router.go("grain", {grainId: grainId});
          }
        }
      }
    });
  }
};
