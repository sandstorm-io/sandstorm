import { Template } from "meteor/templating";
import { globalDb } from "/imports/db-deprecated";

Template.billingPromptLocal.helpers({
  onDismiss: function () {
    return () => {
      if (this.onComplete) this.onComplete(false);
      return "remove";
    };
  },
});

Template._billingPromptPopupLocal.helpers({
  billingPromptUrl: function () {
    return globalDb.getBillingPromptUrl();
  },
});
