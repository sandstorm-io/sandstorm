// Pseudo-collection defined via publish.
const RealTimeStats = new Mongo.Collection("realTimeStats");

Template.newAdminStats.onCreated(function () {
  this.formState = new ReactiveVar("default");
  this.message = new ReactiveVar("");

  this.currentPackageDate = new ReactiveVar(null);
  this.autorun(() => {
    const stat = ActivityStats.findOne({}, { sort: { timestamp: -1 } });
    if (stat) {
      this.currentPackageDate.set(stat._id);
    }
  });

  this.activityStatsSub = this.subscribe("activityStats", undefined);
  this.realTimeStatsSub = this.subscribe("realTimeStats", undefined);
  this.statsTokensSub = this.subscribe("statsTokens", undefined);
  this.allPackagesSub = this.subscribe("allPackages", undefined);

  this.setReportStats = (newValue) => {
    this.formState.set("submitting");
    Meteor.call("setSetting", undefined, "reportStats", newValue, (err) => {
      if (err) {
        this.formState.set("error");
        this.message.set(err.message);
      } else {
        this.formState.set("success");
        this.message.set(
          (newValue ? "Enabled" : "Disabled") +
          " sending stats to the Sandstorm team." +
          (newValue ? "  Thank you!" : "")
        );
        // TODO(someday): factor setting reportStats out into a separate method that implies
        // dismissing the notifications
        Meteor.call("dismissAdminStatsNotifications", undefined);
      }
    });
  };

  this.ready = () => {
    return this.activityStatsSub.ready() && this.realTimeStatsSub.ready() &&
        this.statsTokensSub.ready() && this.allPackagesSub.ready();
  };
});

Template.newAdminStats.helpers({
  ready() {
    const instance = Template.instance();
    return instance.ready();
  },

  undecided() {
    const setting = Settings.findOne({ _id: "reportStats" });
    return setting && setting.value === "unset";
  },

  sendStats() {
    const setting = Settings.findOne({ _id: "reportStats" });
    return setting && setting.value;
  },

  statsLink() {
    const tokenObj = StatsTokens.findOne();
    const token = tokenObj && tokenObj._id;
    return token && (getOrigin() + "/fetchStats/" + token);
  },

  current: function () {
    return RealTimeStats.findOne("now");
  },

  today: function () {
    return RealTimeStats.findOne("today");
  },

  points() {
    const instance = Template.instance();
    if (!instance.ready()) return [];
    return ActivityStats.find({}, { sort: { timestamp: -1 } }).map((point) => {
      return _.extend({
        // Report date of midpoint of sample period.
        day: new Date(point.timestamp.getTime() - 12 * 60 * 60 * 1000).toLocaleDateString(),
      }, point);
    });
  },

  appDates() {
    const instance = Template.instance();
    return ActivityStats.find({}, { sort: { timestamp: -1 }, fields: { timestamp: 1 } })
        .map(function (point) {
      return _.extend({
        // Report date of midpoint of sample period.
        day: new Date(point.timestamp.getTime() - 12 * 60 * 60 * 1000).toLocaleDateString(),
        selected: point._id === instance.currentPackageDate.get(),
      }, point);
    });
  },

  apps() {
    const instance = Template.instance();
    if (!instance.ready()) return;

    const stats = ActivityStats.findOne({ _id: instance.currentPackageDate.get() });
    if (!stats) {
      return;
    }

    const apps = {};
    const pivotApps = function (time) {
      let data = stats[time];
      if (!data) {
        return;
      }

      data = data.apps;
      for (const appId in data) {
        const p = data[appId];
        apps[appId] = apps[appId] || {};
        apps[appId][time] = p;
      }
    };

    pivotApps("daily");
    pivotApps("weekly");
    pivotApps("monthly");
    pivotApps("forever");
    return _.chain(apps)
      .map(function (packObj, appId) {
        packObj.appId = appId;
        // Find the newest version of this app.
        const p = Packages.findOne({
          appId: appId,
          manifest: { $exists: true },
        }, {
          sort: { "manifest.appVersion": -1 },
        });
        if (p) {
          packObj.appTitle = SandstormDb.appNameFromPackage(p);
        }

        return packObj;
      })
      .sortBy(function (app) { return -((app.daily || {}).owners || 0); })
      .value();
  },

  hasSuccess() {
    const instance = Template.instance();
    return instance.formState.get() === "success";
  },

  hasError() {
    const instance = Template.instance();
    return instance.formState.get() === "error";
  },

  message() {
    const instance = Template.instance();
    return instance.message.get();
  },
});

Template.newAdminStats.events({
  "submit form.stats-request"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.setReportStats(true);
  },

  "click button[name=enable-stats]"(evt) {
    const instance = Template.instance();
    instance.setReportStats(true);
  },

  "click button[name=disable-stats]"(evt) {
    const instance = Template.instance();
    instance.setReportStats(false);
  },

  "click button[name=regenerate-stats-token]"(evt) {
    Meteor.call("regenerateStatsToken");
  },

  "change select.package-date"(evt) {
    const instance = Template.instance();
    instance.currentPackageDate.set(evt.currentTarget.value);
  },
});
