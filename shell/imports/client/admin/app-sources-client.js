import { globalDb } from "/imports/db-deprecated.js";

const DEFAULT_APP_MARKET_URL = "https://apps.sandstorm.io";
const DEFAULT_APP_UPDATES_ENABLED = true;
const DEFAULT_APP_INDEX_URL = "https://app-index.sandstorm.io";

Template.newAdminAppSources.onCreated(function () {
  this.appMarketUrl = new ReactiveVar(globalDb.getSettingWithFallback("appMarketUrl", ""));
  this.enableAppUpdates = new ReactiveVar(globalDb.getSettingWithFallback("appUpdatesEnabled", false));
  this.appIndexUrl = new ReactiveVar(globalDb.getSettingWithFallback("appIndexUrl", ""));
  this.formChanged = new ReactiveVar(false);
  this.formState = new ReactiveVar({
    state: "edit", // Other allowed states: "submitting", "success", and "error"
    message: undefined,
  });
});

Template.newAdminAppSources.helpers({
  appMarketUrl() {
    const instance = Template.instance();
    return instance.appMarketUrl.get();
  },

  enableAppUpdates() {
    const instance = Template.instance();
    return instance.enableAppUpdates.get();
  },

  appIndexUrl() {
    const instance = Template.instance();
    return instance.appIndexUrl.get();
  },

  saveDisabled() {
    const instance = Template.instance();
    return instance.formState.get().state === "submitting" || (!instance.formChanged.get());
  },

  restoreDisabled() {
    const instance = Template.instance();
    return instance.appMarketUrl.get() === DEFAULT_APP_MARKET_URL &&
           instance.enableAppUpdates.get() === DEFAULT_APP_UPDATES_ENABLED &&
           instance.appIndexUrl.get() === DEFAULT_APP_INDEX_URL;
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
});

Template.newAdminAppSources.events({
  "submit .admin-app-sources"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
  },

  "input input[name=appMarketUrl]"(evt) {
    const instance = Template.instance();
    instance.appMarketUrl.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "click input[name=enableAppUpdates]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.enableAppUpdates.set(!instance.enableAppUpdates.get());
    instance.formChanged.set(true);
  },

  "input input[name=appIndexUrl]"(evt) {
    const instance = Template.instance();
    instance.appIndexUrl.set(evt.currentTarget.value);
    instance.formChanged.set(true);
  },

  "click .save"(evt) {
    // TODO(soon): make this use a single, atomic Meteor method call.  For now, it's only 3 calls,
    // and leaving things this way means I don't have to backport more changes to the old admin UI
    // to build the new one.
    const instance = Template.instance();
    const newAppMarketUrl = instance.appMarketUrl.get();
    const newEnableAppUpdates = instance.enableAppUpdates.get();
    const newAppIndexUrl = instance.appIndexUrl.get();

    instance.formState.set({
      state: "submitting",
      message: "",
    });

    Meteor.call("setSetting", undefined, "appMarketUrl", newAppMarketUrl, (err) => {
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
      } else {
        Meteor.call("setSetting", undefined, "appIndexUrl", newAppIndexUrl, (err) => {
          if (err) {
            instance.formState.set({
              state: "error",
              message: err.message,
            });
          } else {
            Meteor.call("setSetting", undefined, "enableAppUpdates", newEnableAppUpdates, (err) => {
              if (err) {
                instance.formState.set({
                  state: "error",
                  message: err.message,
                });
              } else {
                instance.formChanged.set(false);
                instance.formState.set({
                  state: "success",
                  message: "Saved changes.",
                });
              }
            });
          }
        });
      }
    });
  },

  "click .restore"(evt) {
    const instance = Template.instance();
    instance.appMarketUrl.set(DEFAULT_APP_MARKET_URL);
    instance.enableAppUpdates.set(DEFAULT_APP_UPDATES_ENABLED);
    instance.appIndexUrl.set(DEFAULT_APP_INDEX_URL);
    instance.formChanged.set(true);
  },
});
