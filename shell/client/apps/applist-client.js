import { introJs } from "intro.js";

SandstormAppList = function (db, quotaEnforcer) {
  this._filter = new ReactiveVar("");
  this._sortOrder = new ReactiveVar([["appTitle", 1]]);
  this._staticHost = db.makeWildcardHost("static");
  this._db = db;
  this._quotaEnforcer = quotaEnforcer;
  this._uninstalling = new ReactiveVar(false);
};

const matchesApp = function (needle, app) {
  const pkg = app && app.pkg;
  const appTitle = SandstormDb.appNameFromPackage(pkg);
  // We match if the app title is matched...
  if (appTitle.toLowerCase().indexOf(needle) !== -1) return true;
  // ...or the metadata's shortDescription matches...
  const shortDesc = SandstormDb.appShortDescriptionFromPackage(pkg);
  if (shortDesc && shortDesc.toLowerCase().indexOf(needle) !== -1) return true;
  // ...or any of the app's action's nouns match.
  for (let i = 0; i < pkg.manifest.actions.length; i++) {
    const nounPhrase = SandstormDb.nounPhraseForActionAndAppTitle(pkg.manifest.actions[i], appTitle);
    if (nounPhrase.toLowerCase().indexOf(needle) !== -1) return true;
  }
  // Otherwise, nope.
  return false;
};

const compileMatchFilter = function (searchString) {
  const searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter(function (k) { return k !== "";});

  return function matchFilter(item) {
    if (searchKeys.length === 0) return true;
    return _.chain(searchKeys)
        .map(function (searchKey) {return matchesApp(searchKey, item); })
        .reduce(function (a, b) {return a && b; })
        .value();
  };
};

const appToTemplateObject = function (app) {
  const ref = Template.instance().data;
  return {
    iconSrc: app.pkg ? ref._db.iconSrcForPackage(app.pkg, "appGrid") : "",
    appTitle: SandstormDb.appNameFromPackage(app.pkg),
    shortDescription: SandstormDb.appShortDescriptionFromPackage(app.pkg),
    appId: app.appId,
    dev: app.dev,
  };
};

const matchApps = function (searchString) {
  const filter = compileMatchFilter(searchString);

  const db = Template.instance().data._db;
  const allActions = db.currentUserActions().fetch();
  const appsFromUserActionsByAppId = _.chain(allActions)
      .groupBy("packageId")
      .pairs()
      .map(function (pair) {
        const pkg = db.collections.packages.findOne(pair[0]);
        return {
          packageId: pair[0],
          actions: pair[1],
          appId: pkg.appId,
          pkg: pkg,
          dev: false,
        };
      })
      .indexBy("appId")
      .value();
  const devPackagesByAppId = _.chain(db.collections.devPackages.find().fetch())
      .map(function (devPackage) {
        return {
          packageId: devPackage._id,
          actions: devPackage.manifest.actions,
          appId: devPackage.appId,
          pkg: devPackage,
          dev: true,
        };
      })
      .indexBy("appId")
      .value();
  // Merge, making sure that dev apps overwrite user actions if they share appId
  const allApps = _.chain({})
                 .extend(appsFromUserActionsByAppId, devPackagesByAppId)
                 .values()
                 .value();

  const matchingApps = _.chain(allApps)
                      .filter(filter)
                      .value();
  return matchingApps;
};

Template.sandstormAppListPage.helpers({
  setDocumentTitle: function () {
    const ref = Template.instance().data;
    document.title = "Apps · " + ref._db.getServerTitle();
  },

  searching: function () {
    const ref = Template.instance().data;
    return ref._filter.get().length > 0;
  },

  actionsCount: function () {
    const ref = Template.instance().data;
    return ref._db.currentUserActions().count();
  },

  apps: function () {
    const ref = Template.instance().data;
    const apps = matchApps(ref._filter.get());
    return _.chain(apps)
            .map(appToTemplateObject)
            .sortBy(function (appTemplateObj) { return appTemplateObj.appTitle.toLowerCase(); })
            .sortBy(function (appTemplateObj) { return appTemplateObj.dev ? 0 : 1; })
            .value();
  },

  popularApps: function () {
    const ref = Template.instance().data;
    // Count the number of grains owned by this user created by each app.
    const actions = ref._db.currentUserActions().fetch();
    const appIds = _.pluck(actions, "appId");
    const grains = ref._db.currentUserGrains().fetch();
    const appCounts = _.countBy(grains, function (x) { return x.appId; });
    // Sort apps by the number of grains created, descending.
    const apps = matchApps(ref._filter.get());
    return _.chain(apps)
        .sortBy(function (app) { return appCounts[app.appId] || 0; })
        .reverse()
        .map(appToTemplateObject)
        .value();
  },

  assetPath: function (assetId) {
    return makeWildcardHost("static") + assetId;
  },

  appMarketUrl: function () {
    const appMarket = Settings.findOne({ _id: "appMarketUrl" });
    if (!appMarket) {
      return "#";
    }

    return appMarket.value + "/?host=" + document.location.protocol + "//" + document.location.host;
  },

  isSignedUpOrDemo: function () {
    return this._db.isSignedUpOrDemo();
  },

  showMostPopular: function () {
    // Only show if not searching, not uninstalling, and you have >= 6 apps installed
    const ref = Template.instance().data;
    return (ref._filter.get().length === 0) &&
           (!ref._uninstalling.get()) &&
           (ref._db.currentUserActions().count() >= 6);
  },

  uninstalling: function () {
    return Template.instance().data._uninstalling.get();
  },

  appIsLoading: function () {
    return Template.instance().appIsLoading.get();
  },
});
Template.sandstormAppListPage.events({
  "click .install-button": function (evt) {
    evt.preventDefault();
    evt.stopPropagation();
    Template.instance().data._quotaEnforcer.ifQuotaAvailable(function () {
      window.open("https://apps.sandstorm.io/?host=" +
          document.location.protocol + "//" + document.location.host, "_blank");
    });
  },

  "click .upload-button": function (evt, instance) {
    const input = instance.find(instance.find(".upload-button input"));
    if (input == evt.target) {
      // Click event generated by upload handler.
      return;
    }

    instance.data._quotaEnforcer.ifPlanAllowsCustomApps(function () {
      // N.B.: this calls into a global in shell.js.
      // TODO(cleanup): refactor into a safer dependency.
      promptUploadApp(input);
    });
  },

  "click .uninstall-action": function (evt) {
    const db = Template.instance().data._db;
    const appId = this.appId;
    db.collections.userActions.find({ appId: this.appId }).forEach(function (action) {
      Meteor.call("removeUserAction", action._id);
    });
  },

  "click button.toggle-uninstall": function (evt) {
    const uninstallVar = Template.instance().data._uninstalling;
    uninstallVar.set(!uninstallVar.get());
  },
  // We use keyup rather than keypress because keypress's evt.currentTarget.value will not
  // have taken into account the keypress generating this event, so we'll miss a letter to
  // filter by
  "keyup .search-bar": function (evt) {
    Template.instance().data._filter.set(evt.currentTarget.value);
  },

  "keypress .search-bar": function (evt, template) {
    const ref = Template.instance().data;
    if (evt.keyCode === 13) {
      // Enter pressed.  If a single grain is shown, open it.
      const apps = matchApps(ref._filter.get());
      if (apps.length === 1) {
        Router.go("appDetails", { appId: apps[0].appId });
      }
    }
  },
});

Template.sandstormAppListPage.onDestroyed(() => {
  if (Template.instance().intro) {
    Template.instance().intro.exit();
    Template.instance().intro = undefined;
  }
});

Template.sandstormAppListPage.onRendered(() => {
  const instance = Template.instance();
  const db = instance.data._db;
  // Set up automatically-opening hint explaining what installing is, if zero apps installed.
  // Only show it if the user is allowed to install apps.
  if (!db.collections.userActions.find().count() &&
          !Session.get("dismissedInstallHint") &&
          isSignedUpOrDemo()) {
    // If the user had 0 grains (including in the trash) at the time they see this message, then
    // when they open a grain for the first time, we want to show them our guided-tour message
    // about how "Share access" works.
    //
    // Persist between reloads via localStorage.
    const grainsCount = db.currentUserGrains().count();
    if (grainsCount === 0) {
      Meteor._localStorage.setItem("userNeedsShareAccessHint", true);
    }

    const intro = Template.instance().intro = introJs();
    let introOptions = {
      steps: [
        {
          element: document.querySelector(".install-icon"),
          intro: "<strong>Welcome!</strong><br>Create documents, chat rooms, blogs, and more.<br><br>Get started by installing an app.",
        },
      ],
      tooltipPosition: "auto",
      positionPrecedence: ["right", "top", "left", "bottom"],
      highlightClass: "hidden-introjs-highlight",
      showStepNumbers: false,
      exitOnOverlayClick: true,
      overlayOpacity: 0,
      showBullets: false,
      doneLabel: "Got it",
    };

    if (window.innerWidth < 500) {
      // Detect if the window is skinner than 500px; if so, force the hint to appear vertically.
      introOptions.tooltipPosition = "bottom";
      introOptions.positionPrecedence = ["bottom"];
      // Avoid placing the hint over the text when laid-out vertically.
      introOptions.steps[0].element = document.querySelector(".install-button");
    }

    intro.setOptions(introOptions);
    const dismissHint = () => {
      Session.set("dismissedInstallHint", true);
    };

    intro.oncomplete(dismissHint);
    intro.onexit(dismissHint);

    intro.start();
  }

  // Auto-focus search bar on desktop, but not mobile (on mobile it will open the software
  // keyboard which is undesirable). window.orientation is generally defined on mobile browsers
  // but not desktop browsers, but some mobile browsers don't support it, so we also check
  // clientWidth. Note that it's better to err on the side of not auto-focusing.
  if (window.orientation === undefined && window.innerWidth > 600) {
    // If there are no apps available, don't bother focusing it.
    if (db.collections.userActions.find().count() === 0) {
      return;
    }

    const searchbar = instance.findAll(".search-bar")[0];
    if (searchbar) searchbar.focus();
  }
});

Template.sandstormAppListPage.onCreated(function () {
  this.appIsLoading = new ReactiveVar(false);
});
