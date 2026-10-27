import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { checkAuthAsync } from "/imports/server/auth";
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
  async setPersonalizationSettings(params) {
    await checkAuthAsync(this.connection.sandstormDb, this.userId);
    check(params, personalizationMessageShape);
    const db = this.connection.sandstormDb;
    // TODO(soon): make this a single write to a single settings object
    await db.collections.settings.upsertAsync({ _id: "serverTitle" }, { value: params.serverTitle });
    await db.collections.settings.upsertAsync({ _id: "splashUrl" }, { value: params.splashUrl });
    await db.collections.settings.upsertAsync({ _id: "signupDialog" }, { value: params.signupDialog });
    await db.collections.settings.upsertAsync({ _id: "termsUrl" }, { value: params.termsOfServiceUrl });
    await db.collections.settings.upsertAsync({ _id: "privacyUrl" }, { value: params.privacyPolicyUrl });

    await db.collections.settings.upsertAsync({ _id: "whitelabelCustomLoginProviderName" },
      { value: params.whitelabelCustomLoginProviderName });
    await db.collections.settings.upsertAsync({ _id: "whitelabelHideSendFeedback" },
      { value: params.whitelabelHideSendFeedback });
    await db.collections.settings.upsertAsync({ _id: "whitelabelHideTroubleshooting" },
      { value: params.whitelabelHideTroubleshooting });
    await db.collections.settings.upsertAsync({ _id: "whiteLabelHideAbout" },
      { value: params.whiteLabelHideAbout });
    await db.collections.settings.upsertAsync({ _id: "whitelabelUseServerTitleForHomeText" },
      { value: params.whitelabelUseServerTitleForHomeText });
  },

  async getWhitelabelLogoUploadToken() {
    await checkAuthAsync(this.connection.sandstormDb, this.userId);
    const db = this.connection.sandstormDb;
    return await db.newAssetUpload({ loginLogo: {} });
  },

  async resetWhitelabelLogo() {
    await checkAuthAsync(this.connection.sandstormDb, this.userId);
    const db = this.connection.sandstormDb;
    const result = await globalDb.collections.settings.rawCollection().findOneAndDelete(
        { _id: "whitelabelCustomLogoAssetId" },
        { projection: { value: 1 } });
    const old = result && result.value !== undefined ? result.value : result;

    if (old) {
      await db.unrefStaticAsset(old.value);
    }
  },
});
