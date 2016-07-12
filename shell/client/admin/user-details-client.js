Template.newAdminUserDetailsIdentityTableRow.helpers({
  isOrganizationMember(identity) {
    return globalDb.isIdentityInOrganization(identity);
  },

  emailsForIdentity(identity, primaryEmail) {
    if (!identity) return [];

    const verifiedEmails = SandstormDb.getVerifiedEmails(identity);
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

    if (identity.unverifiedEmail && !verifiedEmailSet[identity.unverifiedEmail]) {
      emails.push({
        email: identity.unverifiedEmail,
        verified: false,
        primary: identity.unverifiedEmail === primaryEmail,
      });
    }

    return emails;
  },
});

const lookupIdentityId = (identityId) => {
  const identity = Meteor.users.findOne({ _id: identityId });
  if (identity) {
    // Sometimes, DBs lack the corresponding user identity document.
    // Defensively avoid dereferencing a possibly-undefined identity.
    SandstormDb.fillInProfileDefaults(identity);
    SandstormDb.fillInIntrinsicName(identity);
    SandstormDb.fillInPictureUrl(identity);
  }

  return identity;
};

const lookupIdentity = (identityRef) => {
  const identityId = identityRef.id;
  return lookupIdentityId(identityId);
};

Template.newAdminUserDetailsIdentityTable.helpers({
  loginIdentities(account) {
    const identityIds = account.loginIdentities || [];
    const identities = identityIds.map(lookupIdentity);
    return identities;
  },

  nonloginIdentities(account) {
    const identityIds = account.nonloginIdentities || [];
    const identities = identityIds.map(lookupIdentity);
    return identities;
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
    return Meteor.users.findOne({ _id: userId });
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

Template.newAdminUserDetails.helpers({
  ready() {
    const instance = Template.instance();
    return instance.isReady();
  },

  guessUserName() {
    const instance = Template.instance();

    if (!instance.isReady()) return "loading...";

    const account = instance.targetAccount();
    const identityIds = SandstormDb.getUserIdentityIds(account);
    if (identityIds.length === 0) {
      return "<unknown user>";
    }

    const chosenIdentity = lookupIdentityId(identityIds[identityIds.length - 1]);
    return chosenIdentity.profile.name || "<unknown name>";
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

  deleteSubmitting() {
    const instance = Template.instance();
    return instance.deleteSubmitting.get();
  },

  cancelDelete() {
    const instance = Template.instance();
    return () => {
      instance.showDeletePopup.set(false);
    };
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
    Meteor.call("deleteAccount", instance.userId, function (err) {
      if (err) {
        instance.deleteError.set(err);
      } else {
        Router.go("newAdminUsers");
      }
    });
  },
});
