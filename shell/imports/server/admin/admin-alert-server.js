import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { checkAuth } from "/imports/server/auth";

const maintenanceMessageShape = {
  text: String,
  time: Match.OneOf(Date, undefined, null),
  url: Match.Optional(String),
};

Meteor.methods({
  setMaintenanceMessage(params) {
    checkAuth(undefined);
    check(params, maintenanceMessageShape);
    const db = this.connection.sandstormDb;
    // TODO(soon): make this a single write to a single settings object
    db.collections.settings.upsert({ _id: "adminAlertTime" }, { value: params.time });
    db.collections.settings.upsert({ _id: "adminAlertUrl" }, { value: params.url });
    db.collections.settings.upsert({ _id: "adminAlert" }, { value: params.text });
  },
});
