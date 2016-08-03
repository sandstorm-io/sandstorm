const latestPackageForAppId = function (db, appId) {
  // Dev apps mask current package version.
  const devPackage = db.collections.devPackages.findOne({ appId: appId });
  if (devPackage) {
    devPackage.dev = true;
    return devPackage;
  }
  // Look in user actions for this app
  const firstAction = db.collections.userActions.findOne({ appId: appId });
  return firstAction && db.collections.packages.findOne(firstAction.packageId);
};

const latestAppManifestForAppId = function (db, appId) {
  const pkg = latestPackageForAppId(db, appId);
  return pkg && pkg.manifest;
};

const getAppTitle = function (appDetailsHandle) {
  const pkg = latestPackageForAppId(appDetailsHandle._db, appDetailsHandle._appId);
  return pkg && SandstormDb.appNameFromPackage(pkg) || "<unknown>";
};

const matchesGrainTitle = function (needle, grain) {
  return grain.title && grain.title.toLowerCase().indexOf(needle) !== -1;
};

const compileMatchFilter = function (searchString) {
  // split up searchString into an array of regexes, use them to match against item
  const searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter(function (k) { return k !== "";});

  return function matchFilter(item) {
    if (searchKeys.length === 0) return true;
    return _.chain(searchKeys)
        .map(function (searchKey) { return matchesGrainTitle(searchKey, item); })
        .reduce(function (a, b) { return a && b; })
        .value();
  };
};

const appGrains = function (db, appId, trashed) {
  return _.filter(db.currentUserGrains(trashed).fetch(),
                  function (grain) {return grain.appId === appId; });
};

const filteredSortedGrains = function (db, staticAssetHost, appId, appTitle, filterText, viewingTrash) {
  const pkg = latestPackageForAppId(db, appId);

  const grainsMatchingAppId = appGrains(db, appId, viewingTrash);
  const grainIdSet = {};
  grainsMatchingAppId.map((g) => grainIdSet[g._id] = true);

  const tokensForGrain = _.groupBy(db.currentUserApiTokens(viewingTrash).fetch(), "grainId");
  const grainIdsForApiTokens = Object.keys(tokensForGrain)
        .filter((grainId) => !(grainId in grainIdSet));

  // grainTokens is a list of all apiTokens, but guarantees at most one token per grain
  const grainTokens = grainIdsForApiTokens
        .map(function (grainId) { return tokensForGrain[grainId][0]; })
      .filter((token) => !!token.trashed == viewingTrash);

  const grainTokensMatchingAppTitle = grainTokens.filter(function (token) {
    const tokenMetadata = token.owner.user.denormalizedGrainMetadata;
    return tokenMetadata && tokenMetadata.appTitle &&
        tokenMetadata.appTitle.defaultText === appTitle;
  });

  const itemsFromGrains = SandstormGrainListPage.mapGrainsToTemplateObject(grainsMatchingAppId, db);
  const itemsFromSharedGrains = SandstormGrainListPage.mapApiTokensToTemplateObject(
    grainTokensMatchingAppTitle, staticAssetHost);
  const filter = compileMatchFilter(filterText);
  return _.chain([itemsFromGrains, itemsFromSharedGrains])
      .flatten()
      .filter(filter)
      .sortBy("lastUsed") // TODO: allow sorting by other columns
      .reverse()
      .value();
};

const pgpFingerprint = function (pkg) {
  return pkg && pkg.authorPgpKeyFingerprint;
};

Template.sandstormAppDetailsPage.onCreated(function () {
  this._filter = new ReactiveVar("");
  this._keybaseSubscription = undefined;
  this._newGrainIsLaunching = new ReactiveVar(false);
  this._showPublisherDetails = new ReactiveVar(false);

  const ref = Template.instance().data;
  this.autorun(() => {
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    if (this._keybaseSubscription) {
      this._keybaseSubscription.stop();
      this._keybaseSubscription = undefined;
    }

    const fingerprint = pgpFingerprint(pkg);
    if (fingerprint) {
      this._keybaseSubscription = Meteor.subscribe("keybaseProfile", fingerprint);
    }
  });
});

Template.sandstormAppDetailsPage.onDestroyed(function () {
  if (this._keybaseSubscription) {
    this._keybaseSubscription.stop();
    this._keybaseSubscription = undefined;
  }
});

const codeUrlForPackage = function (pkg) {
  return pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.codeUrl;
};

const contactEmailForPackage = function (pkg) {
  return pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.author &&
         pkg.manifest.metadata.author.contactEmail;
};

Template.sandstormAppDetails.helpers({
  isPgpKey: function (arg) {
    return arg === "pgpkey";
  },

  appIconSrc: function () {
    const ref = Template.instance().data;
    const pkg = ref.pkg;
    return pkg && Identicon.iconSrcForPackage(pkg, "appGrid", window.location.protocol + "//" + ref.staticHost);
  },

  appId: function () {
    const pkg = Template.instance().data.pkg;
    return pkg && pkg.appId;
  },

  appTitle: function () {
    const pkg = Template.instance().data.pkg;
    return pkg && SandstormDb.appNameFromPackage(pkg) || "<unknown>";
  },

  website: function () {
    const pkg = Template.instance().data.pkg;
    return pkg && pkg.manifest && pkg.manifest.metadata && pkg.manifest.metadata.website;
  },

  codeUrl: function () {
    const pkg = Template.instance().data.pkg;
    return codeUrlForPackage(pkg);
  },

  contactEmail: function () {
    const pkg = Template.instance().data.pkg;
    return contactEmailForPackage(pkg);
  },

  bugReportLink: function () {
    const pkg = Template.instance().data.pkg;
    // TODO(someday): allow app manifests to include an explicit bug report link.
    // If the source code link is a github URL, then append /issues to it and use that.
    const codeUrl = codeUrlForPackage(pkg);
    if (codeUrl && codeUrl.lastIndexOf("https://github.com/", 0) === 0) {
      return codeUrl + "/issues";
    }
    // Otherwise, provide a mailto: to the package's contact email if available.
    const contactEmail = contactEmailForPackage(pkg);
    if (contactEmail) {
      return "mailto:" + contactEmail;
    }
    // Older app packages may have neither; return undefined.
    return undefined;
  },

  authorPgpFingerprint: function () {
    const pkg = Template.instance().data.pkg;
    return pgpFingerprint(pkg);
  },

  marketingVersion: function () {
    const pkg = Template.instance().data.pkg;
    return pkg && pkg.manifest && pkg.manifest.appMarketingVersion &&
           pkg.manifest.appMarketingVersion.defaultText || "<unknown>";
  },

  publisherDisplayName: function () {
    const ref = Template.instance().data;
    const fingerprint = pgpFingerprint(ref.pkg);
    const profile = ref.keybaseProfile;
    return (profile && profile.displayName) || fingerprint;
  },

  publisherProofs: function () {
    const ref = Template.instance().data;
    const pkg = ref.pkg;
    const fingerprint = pgpFingerprint(pkg);
    if (!fingerprint) return [];
    const profile = ref.keybaseProfile;
    if (!profile) return [];

    const returnValue = [];

    // Add the key fingerprint.
    const keyFragments = [];
    for (let i = 0; i <= ((fingerprint.length / 4) - 1); i++) {
      keyFragments.push({ fragment: fingerprint.slice(4 * i, 4 * (i + 1)) });
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

    // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
    const proofs = profile.proofs;
    if (proofs) {
      const externalProofs = _.chain(proofs)
          // Filter down to twitter, github, and web
          .filter(function (proof) {
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
      externalProofs.forEach(function (proof) { returnValue.push(proof); });
    }
    // jscs:enable requireCamelCaseOrUpperCaseIdentifiers

    return returnValue;
  },
});

Template.sandstormAppDetailsPage.helpers({
  setDocumentTitle: function () {
    const ref = Template.instance().data;
    document.title = (getAppTitle(ref) + " details · " + ref._db.getServerTitle());
  },

  pkg: function () {
    const ref = Template.instance().data;
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    return pkg;
  },

  staticHost: function () {
    const ref = Template.instance().data;
    return ref._staticHost;
  },

  isAppInDevMode: function () {
    const ref = Template.instance().data;
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    return pkg && pkg.dev;
  },

  isAppNotInDevMode: function () {
    const ref = Template.instance().data;
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    return !(pkg && pkg.dev);
  },

  newGrainIsLoading: function () {
    return Template.instance()._newGrainIsLaunching.get();
  },

  appTitle: function () {
    const ref = Template.instance().data;
    return getAppTitle(ref);
  },

  actions: function () {
    const instance = Template.instance();
    const ref = instance.data;
    if (instance._filter.get()) return [];    // Hide actions when searching.
    if (ref.viewingTrash) return []; // Hide actions when viewing trash.
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    if (!pkg) return []; // No package means no actions.
    const appTitle = getAppTitle(ref);
    if (pkg.dev) {
      // Dev mode.  Only show dev mode actions.
      const actions = [];
      const launchDevAction = function (actionIndex) {
        ref._quotaEnforcer.ifQuotaAvailable(function () {
          instance._newGrainIsLaunching.set(true);
          // TODO(soon): this calls a global function in shell.js, refactor
          launchAndEnterGrainByActionId(undefined, pkg._id, actionIndex);
        });
      };

      for (let i = 0; i < pkg.manifest.actions.length; i++) {
        actions.push({
          buttonText: "(Dev) Create new " + SandstormDb.nounPhraseForActionAndAppTitle(
            pkg.manifest.actions[i],
            appTitle
          ),
          onClick: launchDevAction.bind(this, i),
        });
      }

      return actions;
    } else {
      // N.B. it's weird that we have to look up our userAction ID here when it'd be easier to just
      // enumerate the actions listed in the package that we've already retrieved.  UserActions is
      // not a very useful collection.
      return _.chain(ref._db.currentUserActions().fetch())
          .filter(function (a) { return a.appId === ref._appId; })
          .map(function (a) {
            return {
              buttonText: "Create new " + SandstormDb.nounPhraseForActionAndAppTitle(a, appTitle),
              onClick: function () {
                ref._quotaEnforcer.ifQuotaAvailable(function () {
                  instance._newGrainIsLaunching.set(true);
                  // TODO(soon): this calls a global function in shell.js, refactor
                  launchAndEnterGrainByActionId(a._id);
                });
              },
            };
          })
          .value();
    }

  },

  onGrainClicked: function () {
    return function (grainId) {
      Router.go("grain", { grainId: grainId });
    };
  },

  filteredSortedGrains: function () {
    const instance = Template.instance();
    const ref = instance.data;
    return filteredSortedGrains(ref._db, ref._staticHost, ref._appId, getAppTitle(ref),
                                instance._filter.get(), ref.viewingTrash);
  },

  filteredSortedTrashedGrains: function () {
    const instance = Template.instance();
    const ref = instance.data;
    return filteredSortedGrains(ref._db, ref._staticHost, ref._appId, getAppTitle(ref),
                                instance._filter.get(), true);
  },

  isFiltering: function () {
    return !!Template.instance()._filter.get();
  },

  lastUpdated: function () {
    const ref = Template.instance().data;
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    if (!pkg) return undefined;
    if (pkg.dev) return new Date(); // Might as well just indicate "now"
    const db = ref._db;
    const appIndexEntry = db.collections.appIndex.findOne({ packageId: pkg._id });
    return appIndexEntry && appIndexEntry.createdAt && new Date(appIndexEntry.createdAt);
  },

  showPublisherDetails: function () {
    return Template.instance()._showPublisherDetails.get();
  },

  viewingTrash: function () {
    return Template.instance().data.viewingTrash;
  },

  keybaseProfile: function () {
    const ref = Template.instance().data;
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    const fingerprint = pgpFingerprint(pkg);
    const profile = fingerprint && ref._db.getKeybaseProfile(fingerprint);
    return profile;
  },

  hasNewerVersion: function () {
    const ref = Template.instance().data;
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    if (!pkg) return false;
    const grains = appGrains(ref._db, ref._appId);
    return _.some(grains, function (grain) {
      return grain.appVersion > pkg.manifest.appVersion;
    });
  },

  hasOlderVersion: function () {
    const ref = Template.instance().data;
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    if (!pkg) return false;

    // Don't offer upgrading grains to a dev app. The dev app already overrides the regular app
    // for all grains executed while spk dev is active.
    if (pkg.dev) return false;

    const grains = appGrains(ref._db, ref._appId);
    return _.some(grains, function (grain) {
      // Note that we consider a different package with the same appVersion to be "older" because
      // this usually happens when the developer is iterating on their own app and isn't bumping
      // the version number for every iteration. The developer will likely want to be able to
      // upgrade their grains with each iteration, so we want to show them the upgrade button.
      // The app market will refuse to publish two spks of the same app with the same appVersion,
      // so this logic should rarely affect end users.
      return grain.appVersion < pkg.manifest.appVersion ||
          (grain.appVersion === pkg.manifest.appVersion &&
           grain.packageId !== pkg._id);
    });
  },

  bulkActionButtons: function () {
    const ref = Template.instance().data;
    return SandstormGrainListPage.bulkActionButtons(ref.viewingTrash);
  },
});
Template.sandstormAppDetailsPage.events({
  "click .restore-button": function (event, instance) {
    const input = instance.find(".restore-button input");
    if (input == event.target) {
      // Click event generated by upload handler.
      return;
    }

    instance.data._quotaEnforcer.ifQuotaAvailable(function () {
      // N.B.: this calls into a global in shell.js.
      // TODO(cleanup): refactor into a safer dependency.
      promptRestoreBackup(input);
    });
  },

  "input .search-bar": function (event) {
    Template.instance()._filter.set(event.target.value);
  },

  "keypress .search-bar": function (event, instance) {
    const ref = Template.instance().data;
    if (event.keyCode === 13) {
      // Enter pressed.  If a single grain is shown, open it.
      const grains = filteredSortedGrains(ref._db, ref._staticHost, ref._appId,
                                          getAppTitle(ref), instance._filter.get(), ref.viewingTrash);
      if (grains.length === 1) {
        // Unique grain found with current filter.  Activate it!
        const grainId = grains[0]._id;
        Router.go("grain", { grainId: grainId });
      }
    }
  },

  "click .uninstall-button": function (event) {
    const ref = Template.instance().data;
    const db = ref._db;
    if (window.confirm("Really uninstall " + getAppTitle(ref) + "?")) {
      // TODO(soon): make this a method on SandstormDb to uninstall an app for a user by appId/userId
      db.collections.userActions.find({ appId: ref._appId, userId: Meteor.userId() }).forEach(function (action) {
        Meteor.call("removeUserAction", action._id);
      });

      Router.go("apps");
    }
  },

  "click .show-authorship-button": function (event, instance) {
    instance._showPublisherDetails.set(!instance._showPublisherDetails.get());
  },

  "click .upgradeGrains": function (event) {
    const ref = Template.instance().data;
    const pkg = latestPackageForAppId(ref._db, ref._appId);
    Meteor.call("upgradeGrains", ref._appId, pkg.manifest.appVersion, pkg._id);
  },

  "click button.toggle-show-trash": function (event, instance) {
    const ref = Template.instance().data;
    const params = ref.viewingTrash ? {} : { hash: "trash" };
    Router.go("appDetails", { appId:  ref._appId }, params);
  },
});
