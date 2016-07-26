const PRODUCTIVITY_APP_IDS = [
  "8aspz4sfjnp8u89000mh2v1xrdyx97ytn8hq71mdzv4p4d8n0n3h", // Davros
  "h37dm17aa89yrd8zuqpdn36p6zntumtv08fjpu8a8zrte7q1cn60", // Etherpad
  "vfnwptfn02ty21w715snyyczw0nqxkv3jvawcah10c6z7hj1hnu0", // Rocket.Chat
  "m86q05rdvj14yvn78ghaxynqz7u2svw6rnttptxx49g1785cdv1h", // Wekan
];
const SYSTEM_APP_IDS = [];
const APP_LIMIT = 10;

Template.newAdminPreinstalledApps.onCreated(function () {
  this.formChanged = new ReactiveVar(false);
  this.formState = new ReactiveVar({
    state: "edit", // Other allowed states: "submitting", "success", and "error"
    message: undefined,
  });
  const preinstalledApps = globalDb.getSettingWithFallback("preinstalledApps", {});
  this.preinstalledAppIds = new ReactiveVar(_.pluck(preinstalledApps, "appId"));
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
    return globalDb.collections.appIndex.find({ _id: { $in: PRODUCTIVITY_APP_IDS } },
      { sort: { name: 1 } });
  },

  systemApps() {
    return globalDb.collections.appIndex.find({ _id: { $in: SYSTEM_APP_IDS } },
      { sort: { name: 1 } });
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
    this.preinstalledAppIds = instance.preinstalledAppIds;
    this.formChanged = instance.formChanged;
    return this;
  },

  showAllApps() {
    return Template.instance().showAllApps.get();
  },
});

Template._appRow.helpers({
  isAppPreinstalled() {
    return _.contains(this.preinstalledAppIds.get(), this.appId);
  },

  isAppDownloaded() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    return pack && pack.status === "ready";
  },

  isAppDownloading() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    return pack && pack.status === "download";
  },

  progressFraction() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
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
    const preinstalledAppIds = instance.preinstalledAppIds.get();

    instance.formState.set({
      state: "submitting",
      message: "",
    });
    Meteor.call("setPreinstalledApps", preinstalledAppIds, (err) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
      } else {
        let notYetInstalled = [];
        preinstalledAppIds.forEach((appId) => {
          const packageId = globalDb.collections.appIndex.findOne({ appId: appId }).packageId;
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
                } else if (_.contains["verify", "unpack", "analyze"], pack.status) {
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
    const currentAppId = this.appId;
    let preinstalledAppIds = this.preinstalledAppIds.get();
    if (evt.currentTarget.checked) {
      preinstalledAppIds.push(currentAppId);
    } else {
      preinstalledAppIds = _.without(preinstalledAppIds, currentAppId);
    }

    this.preinstalledAppIds.set(preinstalledAppIds);
    this.formChanged.set(true);
  },
});
