import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { checkAuth } from "/imports/server/auth";
import { globalDb } from "/imports/db-deprecated";

const personalizationMessageShape = {
  serverTitle: String,
  splashUrl: String,
  signupDialog: String,
  termsOfServiceUrl: String,
  privacyPolicyUrl: String,

  whitelabelCustomLoginProviderName: String,
  whitelabelHideSendFeedback: Boolean,
  whitelabelHideTroubleshooting: Boolean,
  whiteLabelHideAbout: Boolean,
  whitelabelUseServerTitleForHomeText: Boolean,
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

    db.collections.settings.upsert({ _id: "whitelabelCustomLoginProviderName" },
      { value: params.whitelabelCustomLoginProviderName });
    db.collections.settings.upsert({ _id: "whitelabelHideSendFeedback" },
      { value: params.whitelabelHideSendFeedback });
    db.collections.settings.upsert({ _id: "whitelabelHideTroubleshooting" },
      { value: params.whitelabelHideTroubleshooting });
    db.collections.settings.upsert({ _id: "whiteLabelHideAbout" },
      { value: params.whiteLabelHideAbout });
    db.collections.settings.upsert({ _id: "whitelabelUseServerTitleForHomeText" },
      { value: params.whitelabelUseServerTitleForHomeText });
  },

  getWhitelabelLogoUploadToken() {
    checkAuth(undefined);
    const db = this.connection.sandstormDb;
    return db.newAssetUpload({ loginLogo: {} });
  },

  resetWhitelabelLogo() {
    checkAuth(undefined);
    const db = this.connection.sandstormDb;
    const result = globalDb.collections.settings.findAndModify({
      query: { _id: "whitelabelCustomLogoAssetId" },
      remove: true,
      fields: { value: 1 },
    });

    if (result.ok) {
      const old = result.value;
      if (old) {
        db.unrefStaticAsset(old.value);
      }
    } else {
      throw new Meteor.Error(500, "Couldn't remove whitelabelCustomLogoAssetId");
    }
  },
});
