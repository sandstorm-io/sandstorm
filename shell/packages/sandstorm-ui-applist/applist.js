SandstormAppList = function(db) {
  this._filter = new ReactiveVar("");
  this._sortOrder = new ReactiveVar([["appTitle", "desc"]]);
  this._staticHost = db.makeWildcardHost("static");
  var ref = this;
  // TODO(cleanup): Separate into separate files for client and server. Note that the server side
  //   can grab the database in method and publish implementations as `this.connection.sandstormDb`,
  //   so perhaps it's not necessary to construct a SandstormAppList object on the server.
  // TODO(cleanup): Don't do Meteor.publish, Template.x.{helpers,events}, etc. in constructor code
  //   since these things cannot be executed multiple times.
  if (Meteor.isServer) {
    Meteor.publish("userPackages", function() {
      // Users should be able to see packages that are any of:
      // 1. referenced by one of their userActions
      // 2. referenced by one of their grains
      // 3. referenced by the grain of an ApiToken they possess
      // Sadly, this is rather a pain to make reactive.  This could probably benefit from some
      // refactoring or being turned into a library that handles reactive server-side joins.
      var self = this;

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
  }
  if (Meteor.isClient) {
    var iconForAction = function (action) {
      var appId = action.appId;
      var pkg = db.collections.packages.findOne({_id: action.packageId});
      if (!pkg) {
        // Sometimes pkg may not have synced to minimongo yet on pageload.
        // Reactivity will ensure the page looks right when the data loads, but in the meantime,
        // avoid causing noisy backtraces in the console.
        return "";
      }
      return Identicon.iconSrcForPackage(pkg, 'appGrid', ref._staticHost);
    };
    var appTitleForAction = function (action) {
      if (action.appTitle) return action.appTitle;
      // Legacy cruft: guess at the app title from the action text.
      // N.B.: calls into shell.js.  TODO: refactor
      return appNameFromActionName(action.title);
    };
    var andClauseFor = function (searchString) {
      var searchKeys = searchString.split(" ").filter(function(k) { return k != "";});
      var searchRegexes = searchKeys.map(function(key) {
         return {$or: [{ "appTitle": { $regex: key , $options: 'i' } },
                       { "title": { $regex: key , $options: 'i' } }]};
      });
      var andClause = searchRegexes.length > 0 ? { $and: searchRegexes } : {};
      return andClause;
    };
    var actionToTemplateObject = function(action) {
      var title = appTitleForAction(action);
      return {
        _id: action._id,
        iconSrc: iconForAction(action),
        appTitle: title,
        noun: nounFromAction(action, title)
      };
    };
    var mapToTemplateObject = function (actions) {
      var result = actions.map(actionToTemplateObject);
      return result;
    };
    var matchActions = function (searchString, sortOrder) {
        var andClause = andClauseFor(searchString);
        var actions = db.currentUserActions(andClause, { sort: sortOrder } );
        return actions;
    };
    var nounFromAction = function (action, appTitle) {
      // A hack to deal with legacy apps not including fields in their manifests.
      // I look forward to the day I can remove most of this code.
      // Attempt to figure out the appropriate noun that this action will create.
      // Use an explicit noun phrase is one is available.  Apps should add these in the future.
      if (action.nounPhrase) return action.nounPhrase;
      // Otherwise, try to guess one from the structure of the action title field
      if (action.title) {
        var text = action.title;
        if (text.defaultText) {
          // Dev apps require dereferencing the defaultText field; manifests do not.
          text = text.defaultText;
        }
        // Strip a leading "New "
        if (text.lastIndexOf("New ", 0) === 0) {
          var candidate = text.slice(4);
          // Strip a leading appname too, if provided
          if (candidate.lastIndexOf(appTitle, 0) === 0) {
            var newCandidate = candidate.slice(appTitle.length);
            // Unless that leaves you with no noun, in which case, use "instance"
            if (newCandidate.length > 0) {
              return newCandidate.toLowerCase();
            } else {
              return "instance";
            }
          }
          return candidate.toLowerCase();
        }
        // Some other verb phrase was given.  Just use it verbatim, and hope the app author updates
        // the package soon.
        return text;
      } else {
        return "instance";
      }
    };
    Template.sandstormAppList.helpers({
      searching: function() {
        return ref._filter.get().length > 0;
      },
      actions: function() {
        var actions = matchActions(ref._filter.get(), ref._sortOrder.get());
        return actions.map(actionToTemplateObject);
      },
      assetPath: function(assetId) {
        return makeWildcardHost("static") + assetId;
      },
      popularActions: function() {
        // We approximate action popularity by the number of grains the user has for the app
        // which provides that action.
        var actions = matchActions(ref._filter.get(), ref._sortOrder.get()).fetch();
        // Map actions into the apps that own them.
        var appIds = _.pluck(actions, "appId");
        // Count the number of grains owned by this user created by that app.
        var grains = db.currentUserGrains({}, {fields: {appId: 1}}).fetch();
        var appCounts = _.countBy(grains, function(x) { return x.appId; });
        // Sort apps by the number of grains created descending.
        var appIdsByGrainsCreated = _.chain(appIds)
            .sortBy(function(appId) { return appCounts[appId] || 0; })
            .reverse()
            .value();
        // Sort actions by the number of grains created by the matching app.
        var actionsByGrainCount = _.sortBy(actions, function(action) {
           return appIdsByGrainsCreated.indexOf(action.appId);
        });
        return actionsByGrainCount.map(actionToTemplateObject);
      },
      devActions: function () {
        var result = db.collections.devApps.find().fetch();
        var actionList = result.map(function(devapp) {
          var thisAppActions = [];
          for (var i = 0 ; i < devapp.manifest.actions.length ; i++) {
            thisAppActions.push({
              _id: devapp._id,
              appTitle: devapp.manifest.appTitle.defaultText,
              noun: nounFromAction(devapp.manifest.actions[i], devapp.manifest.appTitle.defaultText),
              iconSrc: Identicon.iconSrcForDevPackage(devapp, 'appGrid', ref._staticHost),
              actionIndex: i
            });
          }
          return thisAppActions;
        });
        // Flatten array of arrays of actions into single array
        if (actionList.length > 0) {
          return _.flatten(actionList, true);
        } else {
          return [];
        }
      },
      origin: function() {
        return document.location.protocol + "//" + document.location.host;
      }
    });
    Template.sandstormAppList.events({
      "click .restore-button": function (event) {
        // N.B.: this calls into a global in shell.js.
        // TODO(cleanup): refactor into a safer dependency.
        promptRestoreBackup();
      },
      "click .app-action": function(event) {
        var actionId = event.currentTarget.getAttribute("data-actionid");
        // N.B.: this calls into a global in shell.js.
        // TODO(cleanup): refactor into a safer dependency.
        launchAndEnterGrainByActionId(actionId);
      },
      "click .dev-action": function(event) {
        var devId = event.currentTarget.getAttribute("data-devid");
        var actionIndex = event.currentTarget.getAttribute("data-actionindex");
        // N.B.: this calls into a global in shell.js.
        // TODO(cleanup): refactor into a safer dependency.
        launchAndEnterGrainByActionId("dev", devId, actionIndex);
      },
      // We use keyup rather than keypress because keypress's event.currentTarget.value will not
      // have taken into account the keypress generating this event, so we'll miss a letter to
      // filter by
      "keyup .search-bar": function(event) {
        ref._filter.set(event.currentTarget.value);
      },
      "keypress .search-bar": function(event) {
        if (event.keyCode === 13) {
          // Enter pressed.  If a single grain is shown, open it.
          var actions = matchActions(ref._filter.get(), ref._sortOrder.get()).fetch();
          if (actions.length === 1) {
            // Unique grain found with current filter.  Activate it!
            var action = actions[0]._id;
            // N.B.: this calls into a global in shell.js.
            // TODO(cleanup): refactor into a safer dependency.
            launchAndEnterGrainByActionId(action);
          }
        }
      }
    });
    Template.sandstormAppList.onCreated(function() {
      Template.instance().subscribe("grainsMenu"); // provides userActions, grains, apitokens
      Template.instance().subscribe("devApps");
      Template.instance().subscribe("userPackages");
    });
  }
};
