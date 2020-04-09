import { globalDb } from "/imports/db-deprecated.js";

const APP_LIMIT = 10;

Template.newAdminPreinstalledApps.onCreated(function () {
  this.formChanged = new ReactiveVar(false);
  this.formState = new ReactiveVar({
    state: "edit", // Other allowed states: "submitting", "success", and "error"
    message: undefined,
  });
  const preinstalledApps = globalDb.getSettingWithFallback("preinstalledApps", []);
  const preinstalledAppAndPackageIds = {};
  preinstalledApps.forEach((row) => {
    preinstalledAppAndPackageIds[row.appId] = row.packageId;
  });
  this.preinstalledAppAndPackageIds = new ReactiveVar(preinstalledAppAndPackageIds);
  this.showAllApps = new ReactiveVar(false);
  this.appIndexSubscription = this.subscribe("appIndexAdmin");
  this.packageSubscription = this.subscribe("allPackages");
});

Template.newAdminPreinstalledApps.helpers({
  saveDisabled() {
    const instance = Template.instance();
    return instance.formState.get().state === "submitting" || (!instance.formChanged.get());
  },

  hasError() {
    const instance = Template.instance();
    return instance.formState.get().state === "error";
  },

  hasSuccess() {
    const instance = Template.instance();
    return instance.formState.get().state === "success";
  },

  message() {
    const instance = Template.instance();
    return instance.formState.get().message;
  },

  productivityApps() {
    return globalDb.collections.appIndex.find({ _id: {
      $in: globalDb.getProductivitySuiteAppIds(), },
    }, { sort: { name: 1 } });
  },

  systemApps() {
    return globalDb.collections.appIndex.find({ _id: {
      $in: globalDb.getSystemSuiteAppIds(), },
    }, { sort: { name: 1 } });
  },

  allApps() {
    const instance = Template.instance();
    if (instance.showAllApps.get()) {
      return globalDb.collections.appIndex.find({}, { sort: { name: 1 } });
    } else {
      return globalDb.collections.appIndex.find({}, { sort: { name: 1 }, limit: APP_LIMIT });
    }
  },

  paginateApps() {
    return globalDb.collections.appIndex.find({}).count() > APP_LIMIT;
  },

  appCountMinusShown() {
    return globalDb.collections.appIndex.find({}).count() - APP_LIMIT;
  },

  getRowData() {
    const instance = Template.instance();
    this.preinstalledAppAndPackageIds = instance.preinstalledAppAndPackageIds;
    this.formChanged = instance.formChanged;
    return this;
  },

  showAllApps() {
    return Template.instance().showAllApps.get();
  },
});

Template._appRow.helpers({
  isAppPreinstalled() {
    return !!this.preinstalledAppAndPackageIds.get()[this.appId];
  },

  showAppStatus() {
    // Only show package status if the app has been set as preinstalled in the DB
    return globalDb.isPackagePreinstalled(this.packageId);
  },

  isAppDownloaded() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    return pack && pack.status === "ready" &&
      !!this.preinstalledAppAndPackageIds.get()[this.appId];
  },

  isAppDownloading() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    return pack && _.contains(["verify", "unpack", "analyze", "download"], pack.status);
  },

  isAppFailed() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    return pack && pack.status === "failed";
  },

  progressFraction() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    if (_.contains(["verify", "unpack", "analyze"], pack.status)) {
      // Downloading is done
      return 1;
    }

    return pack && pack.progress;
  },
});

Template.newAdminPreinstalledApps.events({
  "submit form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
  },

  "click .toggle-more"(evt, instance) {
    instance.showAllApps.set(!instance.showAllApps.get());
    evt.preventDefault();
    evt.stopPropagation();
  },

  "click .save"(evt) {
    const instance = Template.instance();
    const preinstalledAppAndPackageIds = instance.preinstalledAppAndPackageIds.get();

    instance.formState.set({
      state: "submitting",
      message: "",
    });
    const appAndPackageIdList = _.map(preinstalledAppAndPackageIds, (val, key) => {
      return {
        appId: key,
        packageId: val,
      };
    });
    Meteor.call("setPreinstalledApps", appAndPackageIdList, (err) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
      } else {
        let notYetInstalled = [];
        _.each(preinstalledAppAndPackageIds, (packageId) => {
          const pack = globalDb.collections.packages.findOne({ _id: packageId });
          if (!pack || pack.status !== "ready") {
            notYetInstalled.push(packageId);
          }
        });
        if (notYetInstalled.length > 0) {
          instance.formChanged.set(false);
          instance.formState.set({
            state: "success",
            message: "Saving changes. Downloading apps in the background: 0%",
          });
          Tracker.autorun((run) => {
            let progress = 0;
            let ready = 0;
            notYetInstalled.forEach((packageId) => {
              const pack = globalDb.collections.packages.findOne({ _id: packageId });
              if (pack) {
                if (pack.status === "download" && pack.progress > 0) {
                  progress += pack.progress;
                } else if (pack.status === "ready") {
                  progress += 1;
                  ready += 1;
                } else if (_.contains(["verify", "unpack", "analyze"], pack.status)) {
                  // This means it's stuck on analyzing/unpacking/verifying
                  progress += 1;
                }
              }
            });
            if (ready === notYetInstalled.length) {
              instance.formState.set({
                state: "success",
                message: "Saved changes. Downloading apps is complete.",
              });
              run.stop();
            } else {
              instance.formState.set({
                state: "success",
                message: "Saving changes. Downloading apps in the background: " +
                  Math.round(progress / notYetInstalled.length * 100) + "% complete",
              });
            }
          });
        } else {
          instance.formChanged.set(false);
          instance.formState.set({
            state: "success",
            message: "Saved changes.",
          });
        }
      }
    });
  },
});

Template._appRow.events({
  "change input[name=installedApp]"(evt) {
    let preinstalledAppAndPackageIds = this.preinstalledAppAndPackageIds.get();
    if (evt.currentTarget.checked) {
      preinstalledAppAndPackageIds[this.appId] = this.packageId;
    } else {
      delete preinstalledAppAndPackageIds[this.appId];
    }

    this.preinstalledAppAndPackageIds.set(preinstalledAppAndPackageIds);
    this.formChanged.set(true);
  },
});
