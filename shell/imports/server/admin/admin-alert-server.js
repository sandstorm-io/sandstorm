import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import { checkAuthAsync } from "/imports/server/auth";

const maintenanceMessageShape = {
  text: String,
  time: Match.OneOf(Date, undefined, null),
  url: Match.Optional(String),
};

Meteor.methods({
  async setMaintenanceMessage(params) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId);
    check(params, maintenanceMessageShape);
    const db = this.connection.sandstormDb;
    // TODO(soon): make this a single write to a single settings object
    await db.collections.settings.upsertAsync({ _id: "adminAlertTime" }, { value: params.time });
    await db.collections.settings.upsertAsync({ _id: "adminAlertUrl" }, { value: params.url });
    await db.collections.settings.upsertAsync({ _id: "adminAlert" }, { value: params.text });
  },
});
