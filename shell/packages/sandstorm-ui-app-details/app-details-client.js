SandstormAppDetails = function(db, quotaEnforcer, appId) {
  this._db = db;
  this._quotaEnforcer = quotaEnforcer;
  this._appId = appId;

  this._filter = new ReactiveVar("");
  this._sortOrder = new ReactiveVar([]);
  this._staticHost = db.makeWildcardHost("static");

  this._keybaseSubscription = undefined;

  this._newGrainIsLaunching = new ReactiveVar(false);
  this._showPublisherDetails = new ReactiveVar(false);
};

var latestPackageForAppId = function (db, appId) {
  // Dev apps mask current package version.
  var devPackage = db.collections.devPackages.findOne({appId: appId});
  if (devPackage) {
    devPackage.dev = true;
    return devPackage;
  }
  // Look in user actions for this app
  var firstAction = db.collections.userActions.findOne({appId: appId});
  return firstAction && db.collections.packages.findOne(firstAction.packageId);
};

var latestAppManifestForAppId = function (db, appId) {
  var pkg = latestPackageForAppId(db, appId);
  return pkg && pkg.manifest;
};

var getAppTitle = function (appDetailsHandle) {
  var pkg = latestPackageForAppId(appDetailsHandle._db, appDetailsHandle._appId);
  return SandstormDb.appNameFromPackage(pkg);
};

var matchesGrainTitle = function (needle, grain) {
  return grain.title && grain.title.toLowerCase().indexOf(needle) !== -1;
};
var compileMatchFilter = function (searchString) {
  // split up searchString into an array of regexes, use them to match against item
  var searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter(function(k) { return k !== "";});
  return function matchFilter(item) {
    if (searchKeys.length === 0) return true;
    return _.chain(searchKeys)
        .map(function (searchKey) { return matchesGrainTitle(searchKey, item); })
        .reduce(function (a, b) { return a && b; })
        .value();
  };
};

var filteredSortedGrains = function(db, staticAssetHost, appId, appTitle, filterText) {
  var pkg = latestPackageForAppId(db, appId);

  var grainsMatchingAppId = _.filter(db.currentUserGrains().fetch(),
                        function (grain) { return grain.appId === appId; });
  var tokensForGrain = _.groupBy(db.currentUserApiTokens().fetch(), 'grainId');
  var grainIdsForApiTokens = Object.keys(tokensForGrain);
  // grainTokens is a list of all apiTokens, but guarantees at most one token per grain
  var grainTokens = grainIdsForApiTokens.map(function(grainId) { return tokensForGrain[grainId][0]; });
  var grainTokensMatchingAppTitle = grainTokens.filter(function(token) {
    var tokenMetadata = token.owner.user.denormalizedGrainMetadata;
    return tokenMetadata && tokenMetadata.appTitle &&
        tokenMetadata.appTitle.defaultText === appTitle;
  });
  var itemsFromGrains = SandstormGrainListPage.mapGrainsToTemplateObject(grainsMatchingAppId, db);
  var itemsFromSharedGrains = SandstormGrainListPage.mapApiTokensToTemplateObject(
    grainTokensMatchingAppTitle, staticAssetHost);
  var filter = compileMatchFilter(filterText);
  return _.chain([itemsFromGrains, itemsFromSharedGrains])
      .flatten()
      .filter(filter)
      .sortBy('lastUsed') // TODO: allow sorting by other columns
      .reverse()
      .value();
};

var pgpFingerprint = function (pkg) {
  return pkg && pkg.authorPgpKeyFingerprint;
}

Template.sandstormAppDetails.onCreated(function () {
  var ref = Template.instance().data;
  var templateThis = this;
  Tracker.autorun(function () {
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    if (templateThis._keybaseSubscription) {
      templateThis._keybaseSubscription.stop();
      templateThis._keybaseSubscription = undefined;
    }
    var fingerprint = pgpFingerprint(pkg);
    if (fingerprint) {
      templateThis._keybaseSubscription = Meteor.subscribe("keybaseProfile", fingerprint);
    }
  });
});

Template.sandstormAppDetails.onDestroyed(function () {
  if (this._keybaseSubscription) {
    this._keybaseSubscription.stop();
    this._keybaseSubscription = undefined;
  }
});

var codeUrlForPackage = function(pkg) {
  return pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.codeUrl;
};

var contactEmailForPackage = function (pkg) {
  return pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.author &&
         pkg.manifest.metadata.author.contactEmail;
};

Template.sandstormAppDetails.helpers({
  setDocumentTitle: function() {
    var ref = Template.instance().data;
    document.title = (getAppTitle(ref) + " details · Sandstorm");
  },
  isAppInDevMode: function() {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    return pkg && pkg.dev;
  },
  newGrainIsLoading: function () {
    var ref = Template.instance().data;
    return ref._newGrainIsLaunching.get();
  },
  appId: function() {
    var ref = Template.instance().data;
    return ref._appId
  },
  appIconSrc: function() {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    return pkg && Identicon.iconSrcForPackage(pkg, 'appGrid', ref._staticHost);
  },
  appTitle: function() {
    var ref = Template.instance().data;
    return getAppTitle(ref);
  },
  actions: function () {
    var ref = Template.instance().data;
    if (ref._filter.get()) return []; // Hide actions when searching.
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    if (!pkg) return []; // No package means no actions.
    var appTitle = getAppTitle(ref);
    if (pkg.dev) {
      // Dev mode.  Only show dev mode actions.
      var actions = [];
      for (var i = 0; i < pkg.manifest.actions.length ; i++) {
        var index = i; // for use inside the closure below
        actions.push({
          buttonText: "(Dev) Create new " + SandstormDb.nounPhraseForActionAndAppTitle(
            pkg.manifest.actions[i],
            appTitle
          ),
          onClick: function () {
            ref._quotaEnforcer.ifQuotaAvailable(function () {
              ref._newGrainIsLaunching.set(true);
              // TODO(soon): this calls a global function in shell.js, refactor
              launchAndEnterGrainByActionId(undefined, pkg._id, index);
            });
          },
        });
      }
      return actions;
    } else {
      // N.B. it's weird that we have to look up our userAction ID here when it'd be easier to just
      // enumerate the actions listed in the package that we've already retrieved.  UserActions is
      // not a very useful collection.
      return _.chain(ref._db.currentUserActions().fetch())
          .filter(function(a) { return a.appId === ref._appId; })
          .map(function(a) {
            return {
              buttonText: "Create new " + SandstormDb.nounPhraseForActionAndAppTitle(a, appTitle),
              onClick: function() {
                ref._quotaEnforcer.ifQuotaAvailable(function () {
                  ref._newGrainIsLaunching.set(true);
                  // TODO(soon): this calls a global function in shell.js, refactor
                  launchAndEnterGrainByActionId(a._id);
                });
              },
            }
          })
          .value();
    }

  },
  onGrainClicked: function() {
    return function (grainId) {
      Router.go("grain", {grainId: grainId});
    };
  },
  website: function () {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    return pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.website;
  },
  codeUrl: function () {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    return codeUrlForPackage(pkg);
  },
  contactEmail: function () {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    return contactEmailForPackage(pkg);
  },
  bugReportLink: function () {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    // TODO(someday): allow app manifests to include an explicit bug report link.
    // If the source code link is a github URL, then append /issues to it and use that.
    var codeUrl = codeUrlForPackage(pkg);
    if (codeUrl && codeUrl.lastIndexOf("https://github.com/", 0) === 0) {
      return codeUrl + "/issues";
    }
    // Otherwise, provide a mailto: to the package's contact email if available.
    var contactEmail = contactEmailForPackage(pkg);
    if (contactEmail) {
      return "mailto:" + contactEmail;
    }
    // Older app packages may have neither; return undefined.
    return undefined;
  },
  isPgpKey: function (arg) {
    return arg === "pgpkey";
  },
  filteredSortedGrains: function () {
    var ref = Template.instance().data;
    return filteredSortedGrains(ref._db, ref._staticHost, ref._appId, getAppTitle(ref), ref._filter.get());
  },
  lastUpdated: function () {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    if (!pkg) return undefined;
    if (pkg.dev) return new Date(); // Might as well just indicate "now"
    var db = ref._db;
    var appIndexEntry = db.collections.appIndex.findOne({packageId: pkg._id});
    return appIndexEntry && appIndexEntry.createdAt && new Date(appIndexEntry.createdAt);
  },
  showPublisherDetails: function () {
    var ref = Template.instance().data;
    return ref._showPublisherDetails.get();
  },
  authorPgpFingerprint: function () {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    return pgpFingerprint(pkg);
  },
  marketingVersion: function () {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    return pkg && pkg.manifest && pkg.manifest.appMarketingVersion &&
           pkg.manifest.appMarketingVersion.defaultText || "<unknown>";
  },
  publisherDisplayName: function () {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    var fingerprint = pgpFingerprint(pkg);
    var profile = fingerprint && ref._db.getKeybaseProfile(fingerprint);
    return (profile && profile.displayName) || fingerprint;
  },
  publisherProofs: function () {
    var ref = Template.instance().data;
    var pkg = latestPackageForAppId(ref._db, ref._appId);
    var fingerprint = pgpFingerprint(pkg);
    if (!fingerprint) return [];
    var profile = ref._db.getKeybaseProfile(fingerprint);
    if (!profile) return [];

    var returnValue = [];

    // Add the key fingerprint.
    var keyFragments = [];
    for (var i = 0 ; i <= ((fingerprint.length / 4) - 1); i++) {
      keyFragments.push({ fragment: fingerprint.slice(4*i, 4*(i+1)) });
    }
    returnValue.push({
      proofTypeClass: "pgpkey",
      linkTarget: "",
      linkText: fingerprint,
      keyFragments: keyFragments,
    });

    // Add the keybase profile for that key
    if (profile.handle) {
      returnValue.push({
        proofTypeClass: "keybase",
        linkTarget: "https://keybase.io/" + profile.handle,
        linkText: profile.handle,
      });
    }

    var proofs = profile.proofs;
    if (proofs) {
      var externalProofs = _.chain(proofs)
          // Filter down to twitter, github, and web
          .filter(function(proof) {
             return _.contains(["twitter", "github", "dns", "https"],
             proof.proof_type);
          })
          // Then map fields into the things the template cares about
          .map(function (proof) { return {
            proofTypeClass: proof.proof_type,
            linkTarget: proof.service_url,
            linkText: proof.nametag,
          }; })
          .value();
      externalProofs.forEach(function (proof) { returnValue.push(proof) });
    }
    return returnValue;
  },
});
Template.sandstormAppDetails.events({
  "input .search-bar": function(event) {
    Template.instance().data._filter.set(event.target.value);
  },
  "keypress .search-bar": function(event) {
    var ref = Template.instance().data;
    if (event.keyCode === 13) {
      // Enter pressed.  If a single grain is shown, open it.
      var grains = filteredSortedGrains(ref._db, ref._staticHost, ref._appId,
                                        getAppTitle(ref), ref._filter.get());
      if (grains.length === 1) {
        // Unique grain found with current filter.  Activate it!
        var grainId = grains[0]._id;
        Router.go("grain", {grainId: grainId});
      }
    }
  },
  "click .uninstall-button": function(event) {
    var ref = Template.instance().data;
    var db = ref._db;
    if (window.confirm("Really uninstall " + getAppTitle(ref) + "?")) {
      // TODO(soon): make this a method on SandstormDb to uninstall an app for a user by appId/userId
      db.collections.userActions.find({appId: ref._appId, userId: Meteor.userId()}).forEach(function (action) {
        db.collections.userActions.remove(action._id);
      });
      Meteor.call("deleteUnusedPackages", ref._appId);
      Router.go("apps");
    }
  },
  "click .show-authorship-button": function(event) {
    var ref = Template.instance().data;
    ref._showPublisherDetails.set(!ref._showPublisherDetails.get());
  },
});
