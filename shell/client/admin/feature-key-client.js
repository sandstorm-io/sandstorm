Template.newAdminFeatureKey.onCreated(function () {
  this.showForm = new ReactiveVar(false);
});

Template.newAdminFeatureKey.helpers({
  currentFeatureKey() {
    return globalDb.currentFeatureKey();
  },

  showForm() {
    const instance = Template.instance();
    return instance.showForm.get();
  },

  hideFormCb() {
    const instance = Template.instance();
    return () => {
      instance.showForm.set(false);
    };
  },
});

function hexString(bytes) {
  const DIGITS = "0123456789abcdef";

  // Watch out: Uint8Array.map() constructs a new Uint8Arary.
  return Array.prototype.map
      .call(bytes, byte => DIGITS[Math.floor(byte / 16)] + DIGITS[byte % 16])
      .join("");
}

Template.adminFeatureKeyDetails.helpers({
  computeValidity(featureKey) {
    const nowSec = Date.now() / 1000;
    const expires = parseInt(featureKey.expires);
    if (expires >= nowSec) {
      const soonWindowLengthSec = 60 * 60 * 24 * 7; // one week
      if (expires < (nowSec + soonWindowLengthSec)) {
        return {
          className: "expires-soon",
          labelText: "Expires soon",
        };
      } else {
        return {
          className: "valid",
          labelText: "Valid",
        };
      }
    } else {
      return {
        className: "expired",
        labelText: "Expired",
      };
    }
  },

  renderUserLimitString(userLimit) {
    if (userLimit == 4294967295) {
      return "Unlimited users";
    } else {
      return `${userLimit} users`;
    }
  },

  renderDateString(stringSecondsSinceEpoch) {
    if (stringSecondsSinceEpoch === "18446744073709551615") { // UINT64_MAX means "never expires"
      return "Never";
    }

    // TODO: deduplicate this with the one in shared/shell.js or just import moment.js
    const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    const d = new Date();
    d.setTime(parseInt(stringSecondsSinceEpoch) * 1000);

    return MONTHS[d.getMonth()] + " " + d.getDate() + ", " + d.getFullYear();
  },

  keySecret(featureKey) {
    return hexString(featureKey.secret);
  },
});

// A properly-structured-but-signed-by-an-invalid-signer key to serve as an example in the input
// so when people see the formatted copyable feature key in the Sandstorm for Work dashboard,
// they will recognize the similar shape and ascii armor and hopefully connect to copy/paste it
// more easily.
const PLACEHOLDER_KEY = `--------------------- BEGIN SANDSTORM FEATURE KEY ----------------------
6tNStoksTdIeEUogIeE6KcF/gVFGrE8QKISLX0gy/SkPmnwGDh0M8fofCxPouY6DTgcqa5Zb
UPu9TJHMG0BiCRATUAMCD0Tg9lcPRG0eWB//////AREFolEMAQP/V457RSOWN5kBYLA9/2nC
fwkPemD3mf9sCbF+QdeTQgARCWIRDXIREYL/QmlnIHNwZW4AB2Rlcv9EYXZlIERldgAfIFVz
ZXL/dGVzdEB6YXIBdm94Lm9yZwA=
---------------------- END SANDSTORM FEATURE KEY -----------------------`;

Template.featureKeyUploadForm.onCreated(function () {
  this.error = new ReactiveVar(undefined);
  this.text = new ReactiveVar("");
});

Template.featureKeyUploadForm.events({
  "submit form": function (evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const state = Iron.controller().state;
    const token = state.get("token");

    const instance = Template.instance();
    const text = instance.text.get();

    if (text.lastIndexOf(PLACEHOLDER_KEY) !== -1) {
      instance.error.set("The example key is not actually a valid key. ☺");
      return;
    }

    Meteor.call("submitFeatureKey", token, text, (err) => {
      if (err) {
        instance.error.set(err.message);
      } else {
        instance.error.set(undefined);
        instance.data && instance.data.successCb && instance.data.successCb();
      }
    });
  },

  "change input[type='file']": function (evt) {
    const file = evt.currentTarget.files[0];
    const instance = Template.instance();
    const state = Iron.controller().state;
    const token = state.get("token");
    if (file) {
      // Read the file into memory, then call submitFeatureKey with the file's contents.
      const reader = new FileReader();
      reader.addEventListener("load", () => {
        Meteor.call("submitFeatureKey", token, reader.result, (err) => {
          if (err) {
            instance.error.set(err.message);
          } else {
            instance.data && instance.data.successCb && instance.data.successCb();
          }
        });
      });
      reader.readAsText(file);
    }
  },

  "input textarea"(evt) {
    const instance = Template.instance();
    instance.text.set(evt.currentTarget.value);
  },
});

Template.featureKeyUploadForm.helpers({
  currentError() {
    return Template.instance().error.get();
  },

  placeholderKey() {
    return PLACEHOLDER_KEY;
  },

  text() {
    return Template.instance().text.get();
  },

  disabled() {
    return !Template.instance().text.get();
  },
});

Template.adminFeatureKeyModifyForm.onCreated(function () {
  this.showForm = new ReactiveVar(undefined);
  this.renewInFlight = new ReactiveVar(false);
});

Template.adminFeatureKeyModifyForm.helpers({
  showUpdateForm() {
    return Template.instance().showForm.get() === "update";
  },

  showDeleteForm() {
    return Template.instance().showForm.get() === "delete";
  },

  token() {
    const state = Iron.controller().state;
    return state.get("token");
  },

  hideFormCb: function () {
    const instance = Template.instance();
    return () => {
      instance.showForm.set(undefined);
    };
  },

  keySecret() {
    return hexString(globalDb.currentFeatureKey().secret);
  },

  renewalProblem() {
    return globalDb.currentFeatureKey().renewalProblem;
  },

  renewInFlight() {
    return Template.instance().renewInFlight.get();
  },
});

Template.adminFeatureKeyModifyForm.events({
  "click button.feature-key-upload-button"(evt) {
    Template.instance().showForm.set("update");
  },

  "click button.feature-key-delete-button"(evt) {
    Template.instance().showForm.set("delete");
  },

  "click .feature-key-renewal-problem button.retry"(evt) {
    const instance = Template.instance();
    const state = Iron.controller().state;
    const token = state.get("token");
    const renewInFlight = instance.renewInFlight;
    renewInFlight.set(true);
    Meteor.call("renewFeatureKey", token, (err) => {
      renewInFlight.set(false);
      if (err) {
        // Note: Renewal failures aren't reported this way. If we get here there was a bug.
        console.error(err);
        alert(err.message);
      }
    });
  },
});

Template.featureKeyDeleteForm.events({
  "submit .feature-key-delete-form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    Meteor.call("submitFeatureKey", instance.data.token, null, (err) => {
      if (err) {
        console.error("Couldn't delete feature key");
      } else {
        instance.data.successCb && instance.data.successCb();
      }
    });
  },

  "click button.cancel"(evt) {
    const instance = Template.instance();
    instance.data.cancelCb && instance.data.cancelCb();
  },
});
