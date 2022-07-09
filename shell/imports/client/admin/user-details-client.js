import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { Router } from "meteor/iron:router";

import { formatFutureTime } from "/imports/dates";
import { ACCOUNT_DELETION_SUSPENSION_TIME } from "/imports/constants";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { globalDb } from "/imports/db-deprecated";

Template.newAdminUserDetailsCredentialTableRow.helpers({
  isOrganizationMember(credential) {
    return globalDb.isCredentialInOrganization(credential);
  },

  emailsForCredential(credential, primaryEmail) {
    if (!credential) return [];

    const verifiedEmails = SandstormDb.getVerifiedEmailsForCredential(credential);
    const verifiedEmailSet = {};
    const emails = [];
    verifiedEmails.forEach((email) => {
      verifiedEmailSet[email.email] = true;
      emails.push({
        email: email.email,
        verified: true,
        primary: email === primaryEmail,
      });
    });

    if (credential.unverifiedEmail && !verifiedEmailSet[credential.unverifiedEmail]) {
      emails.push({
        email: credential.unverifiedEmail,
        verified: false,
        primary: credential.unverifiedEmail === primaryEmail,
      });
    }

    return emails;
  },
});

const lookupCredentialId = (credentialId) => {
  const credential = Meteor.users.findOne({ _id: credentialId });
  if (credential) {
    // Sometimes, DBs lack the corresponding user credential document.
    // Defensively avoid dereferencing a possibly-undefined credential.

    credential.intrinsicName = SandstormDb.getIntrinsicName(credential, true);
    credential.serviceName = SandstormDb.getServiceName(credential);
  }

  return credential;
};

const lookupCredential = (credentialRef) => {
  const credentialId = credentialRef.id;
  return lookupCredentialId(credentialId);
};

Template.newAdminUserDetailsCredentialTable.helpers({
  loginCredentials(account) {
    const credentialIds = account.loginCredentials || [];
    const credentials = credentialIds.map(lookupCredential);
    return credentials;
  },

  nonloginCredentials(account) {
    const credentialIds = account.nonloginCredentials || [];
    const credentials = credentialIds.map(lookupCredential);
    return credentials;
  },
});

Template.newAdminUserDetails.onCreated(function () {
  const userId = Router.current().params.userId;
  this.userId = userId;
  this.userSub = this.subscribe("adminUserDetails", userId);
  this.formState = new ReactiveVar({
    state: "default", // Also: submitting, error, success
    message: undefined,
  });
  this.deleteSubmitting = new ReactiveVar(false);
  this.showDeletePopup = new ReactiveVar(false);
  this.deleteError = new ReactiveVar(null);
  this.suspendSubmitting = new ReactiveVar(false);
  this.showSuspendPopup = new ReactiveVar(false);
  this.suspendError = new ReactiveVar(null);

  this.isReady = () => {
    // We guard on Router.current().params.userId existing because Iron Router and Blaze
    // somehow manage to trigger a rerender of this template as the page navigates away,
    // despite the fact that we are leaving this page.  This causes targetAccount() to return
    // undefined, and then everything else on the page tries to use it, which causes exceptions
    // everywhere.
    //
    // This probably shouldn't happen.
    return Router.current().params.userId && this.userSub.ready();
  };

  this.targetAccount = () => {
    const userId = Router.current().params.userId;
    const account = Meteor.users.findOne({ _id: userId });
    if (account) SandstormDb.fillInPictureUrl(account);
    return account;
  };

  this.setUserOptions = (options) => {
    this.formState.set({
      state: "submitting",
      message: undefined,
    });
    const methodOptions = {
      userId: this.userId,
      signupKey: options.signupKey,
      isAdmin: options.isAdmin,
    };
    Meteor.call("adminUpdateUser", undefined, methodOptions, this.onFormSubmissionCallback);
  };

  this.onFormSubmissionCallback = (err) => {
    if (err) {
      this.formState.set({
        state: "error",
        message: err.message,
      });
    } else {
      this.formState.set({
        state: "success",
        message: "Changed user's permission level.",
      });
    }
  };
});

function guessUserName(instance) {
  if (!instance.isReady()) return "loading...";

  const account = instance.targetAccount();
  return (account.profile && account.profile.name) || "<unknown name>";
}

Template.newAdminUserDetails.helpers({
  ready() {
    const instance = Template.instance();
    return instance.isReady();
  },

  guessUserName() {
    const instance = Template.instance();

    return guessUserName(instance);
  },

  targetAccount() {
    const instance = Template.instance();
    return instance.targetAccount();
  },

  isAdmin(account) {
    return account && account.isAdmin;
  },

  isPreciselyUser(account) {
    return (!account.isAdmin) && globalDb.isAccountSignedUpOrDemo(account);
  },

  isPreciselyVisitor(account) {
    return (!account.isAdmin) && !globalDb.isAccountSignedUpOrDemo(account);
  },

  canBeMadeVisitor(account) {
    // Don't allow changing permissions on your own account.
    if (account._id === Meteor.userId()) return false;

    // An account can be made into a visitor iff:
    // * They currently have a signupKey (which we can remove).
    // * It's not a demo account (has no .expires)
    // * The server doesn't have allowUninvited enabled.
    // * It's not in the organization.
    if (!account.signupKey || account.expires || Meteor.settings.public.allowUninvited || globalDb.isUserInOrganization(account)) {
      return false;
    }

    return true;
  },

  canBeMadeUser(account) {
    // Don't allow changing permissions on your own account.
    if (account._id === Meteor.userId()) return false;

    // If they're an admin, we can demote them to user.
    if (account.isAdmin) return true;

    // If they're a user, we can't do anything (meaningful) to them.
    // If they're a visitor, we can promote them to user.
    return !globalDb.isAccountSignedUpOrDemo(account);
  },

  hasSuccessMessage() {
    const instance = Template.instance();
    const formState = instance.formState.get();
    return formState.state === "success";
  },

  hasErrorMessage() {
    const instance = Template.instance();
    const formState = instance.formState.get();
    return formState.state === "error";
  },

  message() {
    const instance = Template.instance();
    const formState = instance.formState.get();
    return formState.message;
  },

  isSubmitting() {
    const instance = Template.instance();
    const formState = instance.formState.get();
    return formState.state === "submitting";
  },

  showDeletePopup() {
    const instance = Template.instance();
    return instance.showDeletePopup.get();
  },

  deleteError() {
    const instance = Template.instance();
    return instance.deleteError.get();
  },

  disableDelete() {
    const instance = Template.instance();
    return instance.deleteSubmitting.get();
  },

  cancelDelete() {
    const instance = Template.instance();
    return () => {
      instance.showDeletePopup.set(false);
    };
  },

  showSuspendPopup() {
    const instance = Template.instance();
    return instance.showSuspendPopup.get();
  },

  suspendError() {
    const instance = Template.instance();
    return instance.suspendError.get();
  },

  suspendSubmitting() {
    const instance = Template.instance();
    return instance.suspendSubmitting.get();
  },

  cancelSuspend() {
    const instance = Template.instance();
    return () => {
      instance.showSuspendPopup.set(false);
    };
  },

  accountDeleting() {
    const instance = Template.instance();
    const account = instance.targetAccount();

    if (!account.suspended || !account.suspended.willDelete) return false;

    return formatFutureTime(account.suspended.timestamp.getTime()
      + ACCOUNT_DELETION_SUSPENSION_TIME - new Date());
  },

  accountSuspended() {
    const instance = Template.instance();
    const account = instance.targetAccount();

    return !!account.suspended;
  },
});

Template.newAdminUserDetails.events({
  "click .make-admin"(evt) {
    const instance = Template.instance();
    instance.setUserOptions({
      signupKey: true,
      isAdmin: true,
    });
  },

  "click .make-user"(evt) {
    const instance = Template.instance();
    instance.setUserOptions({
      signupKey: true,
      isAdmin: false,
    });
  },

  "click .make-visitor"(evt) {
    const instance = Template.instance();
    instance.setUserOptions({
      signupKey: false,
      isAdmin: false,
    });
  },

  "click [name=\"delete-account\"]"(evt, instance) {
    instance.showDeletePopup.set(true);
    instance.deleteError.set(null);
  },

  "click [name=\"cancel-delete-account\"]"(evt, instance) {
    instance.showDeletePopup.set(false);
  },

  "click [name=\"delete-account-real\"]"(evt, instance) {
    instance.deleteSubmitting.set(true);
    Meteor.call("suspendAccount", instance.userId, true, (err) => {
      instance.deleteSubmitting.set(false);
      if (err) {
        instance.deleteError.set(err.message);
      } else {
        instance.showDeletePopup.set(false);
      }
    });
  },

  "click [name=\"suspend-account\"]"(evt, instance) {
    instance.showSuspendPopup.set(true);
    instance.suspendError.set(null);
  },

  "click [name=\"cancel-suspend-account\"]"(evt, instance) {
    instance.showSuspendPopup.set(false);
  },

  "click [name=\"suspend-account-real\"]"(evt, instance) {
    instance.suspendSubmitting.set(true);
    Meteor.call("suspendAccount", instance.userId, false, (err) => {
      instance.suspendSubmitting.set(false);
      if (err) {
        instance.suspendError.set(err.message);
      } else {
        instance.showSuspendPopup.set(false);
      }
    });
  },

  "click [name=\"unsuspend-account\"]"(evt, instance) {
    instance.formState.set({
      state: "submitting",
      message: undefined,
    });
    Meteor.call("unsuspendAccount", instance.userId, (err) => {
      instance.suspendSubmitting.set(false);
      if (err) {
        instance.formState.set({
          state: "error",
          message: err.message,
        });
      } else {
        const username = guessUserName(instance) || "Account";
        instance.formState.set({
          state: "success",
          message: username + " is no longer suspended.",
        });
      }
    });
  },
});
