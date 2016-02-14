var INSTALL_STEPS = ["download", "verify", "unpack", "analyze", "ready", "failed", "delete"];
var checkStep = function (step) {
  if (INSTALL_STEPS.indexOf(step) === -1) throw new Error("Invalid step " + step + ".");
};

SandstormAppInstall = class SandstormAppInstall {
  constructor(packageId, packageUrl, db) {
    this._packageId = packageId;
    this._packageUrl = packageUrl;
    this._db = db;
    this._error = new ReactiveVar("");
    this._recoverable = new ReactiveVar(true);
    this._keybaseSubscription = undefined;
    this._appIndexSubscription = undefined;
  }

  pkg() {
    return this._packageId && this._db.collections.packages.findOne(this._packageId);
  }

  appId() {
    var pkg = this.pkg();
    return pkg && pkg.appId;
  }

  packageId() {
    return this._packageId;
  }

  packageUrl() {
    return this._packageUrl;
  }

  setUnrecoverableError(error) {
    this._error.set(error);
    this._recoverable.set(false);
  }

  setError(error) {
    this._error.set(error);
  }

  error() {
    return this._error.get();
  }

  appVersion() {
    var pkg = this.pkg();
    return pkg && pkg.manifest && pkg.manifest.appVersion;
  }

  step() {
    if (this._error.get() !== "") return "error"; // Some error not associated with the package in the DB
    var pkg = this.pkg();
    if (!pkg) return "wait"; // Awaiting write access
    checkStep(pkg.status); // Expect no novel package statuses.
    if (pkg.status !== "ready") return pkg.status;
    return this.isInstalled() ? "run" : "confirm";
  }

  isInstalled() {
    return this._db.collections.userActions.findOne({ userId: Meteor.userId(), packageId: this.packageId() });
  }

  hasOlderVersion() {
    var existingGrains = this._db.collections.grains.find({ userId: Meteor.userId(), appId: this.appId() }).fetch();
    var thisVersion = this.appVersion();
    for (var i in existingGrains) {
      var grain = existingGrains[i];
      if (grain.packageId !== this.packageId()) {
        // Some other package version.
        if (grain.appVersion <= thisVersion) {
          return true;
        }
      }
    }

    return false;
  }

  hasNewerVersion() {
    var existingGrains = this._db.collections.grains.find({ userId: Meteor.userId(), appId: this.appId() }).fetch();
    var thisVersion = this.appVersion();
    for (var i in existingGrains) {
      var grain = existingGrains[i];
      if (grain.packageId !== this.packageId()) {
        // Some other package version.
        if (grain.appVersion > thisVersion) {
          return true;
        }
      }
    }

    return false;
  }

  hasFractionalProgress() {
    var pkg = this.pkg();
    var progress = pkg && pkg.progress;
    return (progress > 0 && progress < 1);
  }

  progressFraction() {
    var pkg = this.pkg();
    var progress = pkg && pkg.progress;
    return progress;
  }

  progressText() {
    var pkg = this.pkg();
    var progress = pkg && pkg.progress;
    if (!progress) return "";
    if (progress < 0) return ""; // -1 means no progress to report
    if (progress > 1) {
      // Progress outside [0,1] indicates a byte count rather than a fraction.
      // TODO(cleanup):  This is pretty ugly.  What if exactly 1 byte had been downloaded?
      return Math.round(progress / 1024) + " KiB";
    }

    // Value between 0 and 1 indicates fractional progress.
    return Math.round(progress * 100) + "%";
  }
};

Template.sandstormAppInstallPage.onCreated(function () {
  var ref = Template.instance().data;
  this.autorun(() => {
    var pkg = ref.pkg();
    if (ref._keybaseSubscription) {
      ref._keybaseSubscription.stop();
      ref._keybaseSubscription = undefined;
    }

    var fingerprint = pkg && pkg.authorPgpKeyFingerprint;
    if (fingerprint) {
      ref._keybaseSubscription = Meteor.subscribe("keybaseProfile", fingerprint);
    }

    var appId = pkg && pkg.appId;
    if (appId) {
      ref._appIndexSubscription = Meteor.subscribe("appIndex", pkg.appId);
    }
  });
});

Template.sandstormAppInstallPage.onDestroyed(function () {
  if (this._keybaseSubscription) {
    this._keybaseSubscription.stop();
    this._keybaseSubscription = undefined;
  }

  if (this._appIndexSubscription) {
    this._appIndexSubscription.stop();
    this._appIndexSubscription = undefined;
  }
});

Template.sandstormAppInstallPage.helpers({
  setDocumentTitle() {
    var ref = Template.instance().data;
    document.title = "Installing app · " + ref._db.getServerTitle();
  },

  error() {
    var ref = Template.instance().data;
    return ref.error();
  },

  step() {
    var ref = Template.instance().data;
    return ref.step();
  },

  ready() {
    return !!Template.instance().data;
  },

  packageId() {
    var ref = Template.instance().data;
    return ref.packageId();
  },

  packageUrl() {
    var ref = Template.instance().data;
    return ref.packageUrl();
  },

  isCurrentStep(step) {
    var ref = Template.instance().data;
    return ref.step() === step;
  },

  hasFractionalProgress() {
    var ref = Template.instance().data;
    return ref.hasFractionalProgress();
  },

  progressFraction() {
    var ref = Template.instance().data;
    return ref.progressFraction();
  },

  progressText() {
    var ref = Template.instance().data;
    return ref.progressText();
  },

  pkg() {
    var ref = Template.instance().data;
    return ref.pkg();
  },

  staticHost() {
    var ref = Template.instance().data;
    return ref._db.makeWildcardHost("static");
  },

  keybaseProfile() {
    var ref = Template.instance().data;
    var pkg = ref.pkg();
    var fingerprint = pkg && pkg.authorPgpKeyFingerprint;
    var profile = fingerprint && ref._db.getKeybaseProfile(fingerprint);
    return profile;
  },

  lastUpdated() {
    var ref = Template.instance().data;
    var pkg = ref.pkg();
    if (!pkg) return undefined;
    if (pkg.dev) return new Date(); // Might as well just indicate 'now'
    var db = ref._db;
    var appIndexEntry = db.collections.appIndex.findOne({ packageId: pkg._id });
    return appIndexEntry && appIndexEntry.createdAt && new Date(appIndexEntry.createdAt);
  },

  appTitle() {
    var ref = Template.instance().data;
    var pkg = ref.pkg();
    return pkg && SandstormDb.appNameFromPackage(pkg);
  },

  appId() {
    var ref = Template.instance().data;
    return ref.appId();
  },
});

Template.sandstormAppInstallPage.events({
  "click #retry": function (event) {
    var ref = Template.instance().data;
    Meteor.call("ensureInstalled", ref._packageId, ref._packageUrl, true);
  },

  "click #cancelDownload": function (event) {
    var ref = Template.instance().data;
    Meteor.call("cancelDownload", ref.packageId());
    Router.go("apps");
  },

  "click #confirmInstall": function (event) {
    var ref = Template.instance().data;
    ref._db.addUserActions(ref.packageId());
  },
});
