var INSTALL_STEPS = ["download", "verify", "unpack", "analyze", "ready", "failed", "delete"];
var checkStep = function(step) {
  if (INSTALL_STEPS.indexOf(step) === -1) throw new Error("Invalid step " + step + ".");
};

SandstormAppInstall = function(packageId, packageUrl, db) {
  this._packageId = packageId;
  this._packageUrl = packageUrl;
  this._db = db;
  this._error = new ReactiveVar("");
  this._recoverable = new ReactiveVar(true);
  this._keybaseSubscription = undefined;
  this._appIndexSubscription = undefined;
};

SandstormAppInstall.prototype.pkg = function () {
  return this._packageId && this._db.collections.packages.findOne(this._packageId);
};

SandstormAppInstall.prototype.appId = function () {
  var pkg = this.pkg();
  return pkg && pkg.appId;
};

SandstormAppInstall.prototype.packageId = function () {
  return this._packageId;
};

SandstormAppInstall.prototype.packageUrl = function () {
  return this._packageUrl;
};

SandstormAppInstall.prototype.setUnrecoverableError = function (error) {
  this._error.set(error);
  this._recoverable.set(false);
}

SandstormAppInstall.prototype.setError = function (error) {
  this._error.set(error);
};

SandstormAppInstall.prototype.error = function () {
  return this._error.get();
};

SandstormAppInstall.prototype.appVersion = function () {
  var pkg = this.pkg();
  return pkg && pkg.manifest && pkg.manifest.appVersion;
};

SandstormAppInstall.prototype.step = function () {
  if (this._error.get() !== "") return "error"; // Some error not associated with the package in the DB
  var pkg = this.pkg();
  if (!pkg) return "wait"; // Awaiting write access
  checkStep(pkg.status); // Expect no novel package statuses.
  if (pkg.status !== "ready") return pkg.status;
  return this.isInstalled() ? "run" : "confirm";
};

SandstormAppInstall.prototype.isInstalled = function () {
  return this._db.collections.userActions.findOne({userId: Meteor.userId(), packageId: this.packageId()});
};

SandstormAppInstall.prototype.hasOlderVersion = function () {
  var existingGrains = this._db.collections.grains.find({userId: Meteor.userId(), appId: this.appId() }).fetch();
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
};

SandstormAppInstall.prototype.hasNewerVersion = function () {
  var existingGrains = this._db.collections.grains.find({userId: Meteor.userId(), appId: this.appId() }).fetch();
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
};

SandstormAppInstall.prototype.hasFractionalProgress = function () {
  var pkg = this.pkg();
  var progress = pkg && pkg.progress;
  return (progress > 0 && progress < 1);
};

SandstormAppInstall.prototype.progressFraction = function () {
  var pkg = this.pkg();
  var progress = pkg && pkg.progress;
  return progress;
}

SandstormAppInstall.prototype.progressText = function () {
  var pkg = this.pkg();
  var progress = pkg && pkg.progress;
  if (!progress) return ""
  if (progress < 0) return ""; // -1 means no progress to report
  if (progress > 1) {
    // Progress outside [0,1] indicates a byte count rather than a fraction.
    // TODO(cleanup):  This is pretty ugly.  What if exactly 1 byte had been downloaded?
    return Math.round(progress / 1024) + " KiB";
  }
  // Value between 0 and 1 indicates fractional progress.
  return Math.round(progress * 100) + "%";
};

Template.sandstormAppInstallPage.onCreated(function () {
  var ref = Template.instance().data;
  Tracker.autorun(function () {
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
  setDocumentTitle: function() {
    document.title = "Installing app · Sandstorm";
  },
  error: function() {
    var ref = Template.instance().data;
    return ref.error();
  },
  step: function() {
    var ref = Template.instance().data;
    return ref.step();
  },
  ready: function () {
    return !!Template.instance().data;
  },
  packageId: function () {
    var ref = Template.instance().data;
    return ref.packageId();
  },
  packageUrl: function () {
    var ref = Template.instance().data;
    return ref.packageUrl();
  },
  isCurrentStep: function (step) {
    var ref = Template.instance().data;
    return ref.step() === step;
  },
  hasFractionalProgress: function () {
    var ref = Template.instance().data;
    return ref.hasFractionalProgress();
  },
  progressFraction: function () {
    var ref = Template.instance().data;
    return ref.progressFraction();
  },
  progressText: function () {
    var ref = Template.instance().data;
    return ref.progressText();
  },
  pkg: function () {
    var ref = Template.instance().data;
    return ref.pkg();
  },
  staticHost: function () {
    var ref = Template.instance().data;
    return ref._db.makeWildcardHost("static");
  },
  keybaseProfile: function () {
    var ref = Template.instance().data;
    var pkg = ref.pkg();
    var fingerprint = pkg && pkg.authorPgpKeyFingerprint;
    var profile = fingerprint && ref._db.getKeybaseProfile(fingerprint);
    return profile;
  },
  lastUpdated: function () {
    var ref = Template.instance().data;
    var pkg = ref.pkg();
    if (!pkg) return undefined;
    if (pkg.dev) return new Date(); // Might as well just indicate "now"
    var db = ref._db;
    var appIndexEntry = db.collections.appIndex.findOne({packageId: pkg._id});
    return appIndexEntry && appIndexEntry.createdAt && new Date(appIndexEntry.createdAt);
  },
  appTitle: function () {
    var ref = Template.instance().data;
    var pkg = ref.pkg();
    return pkg && SandstormDb.appNameFromPackage(pkg);
  },
  appId: function () {
    var ref = Template.instance().data;
    return ref.appId();
  },
});

Template.sandstormAppInstallPage.events({
  "click #retry": function(event) {
    var ref = Template.instance().data;
    Meteor.call("ensureInstalled", ref._packageId, ref._packageUrl, true);
  },
  "click #cancelDownload": function (event) {
    var ref = Template.instance().data;
    Meteor.call("cancelDownload", ref.packageId());
    Router.go('apps');
  },
  "click #confirmInstall": function (event) {
    var ref = Template.instance().data;
    ref._db.addUserActions(ref.packageId());
  },
});
