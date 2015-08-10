SandstormAppList = function(db) {
  this._filter = new ReactiveVar("");
  this._sortOrder = new ReactiveVar([["appTitle", "desc"]]);
  this._staticHost = db.makeWildcardHost("static");
  var ref = this;
  if (Meteor.isServer) {
    Meteor.publish("userPackages", function() {
      var actions = db.userActions(this.userId, {}, {});
      var packageSet = {};
      actions.forEach(function (action) {
        packageSet[action.packageId] = 1;
      });
      return [db.collections.packages.find({_id: {$in: Object.keys(packageSet)}})];
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
      return iconSrcForPackage(pkg, 'appGrid', ref._staticHost);
    };
    var appTitleForAction = function (action) {
      if (action.appTitle) return action.appTitle;
      // Legacy cruft: guess at the app title from the action text.
      // N.B.: calls into shell.js.  TODO: refactor
      return appNameFromActionName(action.title);
    };
    var orClauseFor = function (searchString) {
      var searchKeys = searchString.split(" ").filter(function(k) { return k != "";});
      var searchRegexes = searchKeys.map(function(key) {
         return { "appTitle": { $regex: key , $options: 'i' } };
      }).concat(searchKeys.map(function(key) {
         return { "title": { $regex: key , $options: 'i' } };
      }));
      var orClause = searchRegexes.length > 0 ? { $or: searchRegexes} : {};
      return orClause;
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
        var orClause = orClauseFor(searchString);
        var actions = db.currentUserActions(orClause, { sort: sortOrder } );
        return actions;
    };
    var nounFromAction = function (action, appTitle) {
      // A hack to deal with legacy apps not including fields in their manifests.
      // I look forward to the day I can remove most of this code.
      // Attempt to figure out the appropriate noun that this action will create.
      // Use an explicit noun phrase is one is available.  Apps should add these in the future.
      if (action.nounPhrase && action.nounPhrase) return action.nounPhrase;
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
        var appIdsByGrainsCreated = _.sortBy(appIds, function(appId) {
          return -1*appCounts[appId];
        });
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
              iconSrc: iconSrcForDevPackage(devapp, 'appGrid', ref._staticHost),
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
        // N.B.: this calls into a global in shell.js.  TODO: refactor into a safer dependency.
        promptRestoreBackup();
      },
      "click .app-action": function(event) {
        var actionId = event.target.getAttribute("data-actionid");
        // N.B.: this calls into a global in shell.js.  TODO: refactor into a safer dependency.
        launchAndEnterGrainByActionId(actionId);
      },
      "click .dev-action": function(event) {
        var devId = event.target.getAttribute("data-devid");
        var actionIndex = event.target.getAttribute("data-actionindex");
        // N.B.: this calls into a global in shell.js.  TODO: refactor into a safer dependency.
        launchAndEnterGrainByActionId("dev", devId, actionIndex);
      },
      // We use keyup rather than keypress because keypress's event.target.value will not have
      // taken into account the keypress generating this event, so we'll miss a letter to filter by
      "keyup .search-bar": function(event) {
        ref._filter.set(event.target.value);
      },
      "keypress .search-bar": function(event) {
        if (event.keyCode === 13) {
          // Enter pressed.  If a single grain is shown, open it.
          var actions = matchActions(ref._filter.get(), ref._sortOrder.get()).fetch();
          if (actions.length === 1) {
            // Unique grain found with current filter.  Activate it!
            var action = actions[0]._id;
            // N.B.: this calls into a global in shell.js.  TODO: refactor into a safer dependency.
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
