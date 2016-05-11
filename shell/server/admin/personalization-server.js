import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { checkAuth } from "/imports/server/auth.js";

const personalizationMessageShape = {
  serverTitle: String,
  splashUrl: String,
  signupDialog: String,
  termsOfServiceUrl: String,
  privacyPolicyUrl: String,
};

Meteor.methods({
  setPersonalizationSettings(params) {
    checkAuth(undefined);
    check(params, personalizationMessageShape);
    const db = this.connection.sandstormDb;
    // TODO(soon): make this a single write to a single settings object
    db.collections.settings.upsert({ _id: "serverTitle" }, { value: params.serverTitle });
    db.collections.settings.upsert({ _id: "splashUrl" }, { value: params.splashUrl });
    db.collections.settings.upsert({ _id: "signupDialog" }, { value: params.signupDialog });
    db.collections.settings.upsert({ _id: "termsUrl" }, { value: params.termsOfServiceUrl });
    db.collections.settings.upsert({ _id: "privacyUrl" }, { value: params.privacyPolicyUrl });
  },
});
