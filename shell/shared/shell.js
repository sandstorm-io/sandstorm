Apps = new Meteor.Collection("apps");

Meteor.methods({
  ensureInstalled: function (appid, url) {
    var app = Apps.findOne({ appid: appid });
    if (app) {
      if (app.status === "ready" || app.status === "failed") {
        // Don't try to install.
        return;
      }
    } else {
      Apps.insert({ appid: appid, status: "download", progress: 0 });
    }

    // Start installing on the server side if we aren't already.
    if (!this.isSimulation) {
      startInstall(appid, url);
    }
  },

  cancelDownload: function (appid) {
    if (!this.isSimulation) {
      cancelDownload(appid);
    }
  }
});

if (Meteor.isClient) {
  var activeAppId;
  var appDatabaseIdToRemove;
  Template.install.events({
    "click #retry": function (event) {
      if (appDatabaseIdToRemove) {
        Apps.remove(appDatabaseIdToRemove);
        appDatabaseIdToRemove = undefined;
      }
    },

    "click #cancelDownload": function (event) {
      if (activeAppId) {
        Meteor.call("cancelDownload", activeAppId);
        activeAppId = undefined;
      }
    }
  });
}

Router.map(function () {
  this.route("grain", {
    path: "/"
  });

  this.route("install", {
    path: "/install",
    data: function () {
      // TODO(soon):  Don't display until Apps subscription loaded.

      activeAppId = undefined;
      appDatabaseIdToRemove = undefined;

      if (!this.params.appid) {
        // TODO(now):  Display upload page.
        return { error: "You must specify an app ID." };
      }

      if (this.params.url) {
        Meteor.call("ensureInstalled", this.params.appid, this.params.url);
      }

      var app = Apps.findOne({ appid: this.params.appid });
      if (app === undefined) {
        // Apparently, this app is not installed nor installing, which implies that no URL was
        // provided, which means we cannot install it.
        // TODO(now):  Display upload page, or at least don't display "try again" button.
        return { error: "Unknown app ID: " + this.params.appid +
                        "\nPerhaps it hasn't been uploaded?" };
      }

      if (app.status !== "ready") {
        activeAppId = this.params.appid;
        appDatabaseIdToRemove = app._id;

        var progress;
        if (app.progress < 0) {
          progress = "";  // -1 means no progress to report
        } else if (app.progress > 1) {
          // Progress outside [0,1] indicates a byte count rather than a fraction.
          // TODO(cleanup):  This is pretty ugly.  What if exactly 1 byte had been downloaded?
          progress = Math.round(app.progress / 1024) + " KiB";
        } else {
          progress = Math.round(app.progress * 100) + "%";
        }

        return {
          step: app.status,
          progress: progress,
          error: app.status === "failed" ? app.error : null
        };
      }

      return {
        step: "confirm"
      };
    }
  });
});
