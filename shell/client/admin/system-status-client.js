const systemStatus = new Mongo.Collection("systemStatus");

Template.newAdminStatus.helpers({
  grainsActive() {
    const data = systemStatus.findOne("globalStatus");
    return data && data.activeGrains || 0;
  },

  usersActive() {
    const data = systemStatus.findOne("globalStatus");
    return data && data.activeUsers || 0;
  },

  sandstormVersion() {
    return "0.147";
  },

  logHtml() {
    return AnsiUp.ansi_to_html(
      AdminLog.find({}, { $sort: { _id: 1 } })
          .map(entry => entry.text)
          .join(""),
      { use_classes: true }
    );
  },
});

Template.newAdminStatus.onCreated(function () {
  this.subscribe("adminLog");
  this.subscribe("systemStatus");
});
