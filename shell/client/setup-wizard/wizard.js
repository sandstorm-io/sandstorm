import SandstormAccountSettingsUi from "/imports/client/accounts/account-settings-ui.js";
import AccountsUi from "/imports/client/accounts/accounts-ui.js";
import downloadFile from "/imports/client/download-file.js";

// Pseudocollection telling the client if there's an admin user yet.
HasAdmin = new Mongo.Collection("hasAdmin");

const AdminToken = new Mongo.Collection("adminToken"); // see Meteor.publish("adminToken")

const setupSteps = ["intro", "identity", "email", "preinstalled", "user", "success"];
const setupStepsForWork = [
  "intro",
  "identity",
  "organization",
  "email",
  "preinstalled",
  "user",
  "success",
];

// Combined with the list of steps above to DRY up the ordering.
const setupStepRouteMap = {
  intro: "setupWizardIntro",
  identity: "setupWizardIdentity",
  organization: "setupWizardOrganization",
  email: "setupWizardEmailConfig",
  preinstalled: "setupWizardPreinstalled",
  user: "setupWizardLoginUser",
  success: "setupWizardSuccess",
};

const providerEnabled = function (providerString) {
  const setting = globalDb.collections.settings.findOne({ _id: providerString });
  if (setting) {
    return setting.value;
  } else {
    return false;
  }
};

const setupIsStepCompleted = {
  intro() {
    return true;
  },

  identity() {
    return (
      providerEnabled("emailToken") ||
      providerEnabled("google") ||
      providerEnabled("github") ||
      providerEnabled("ldap") ||
      providerEnabled("saml")
    );
  },

  organization() {
    // all states are valid here
    return true;
  },

  email() {
    // We allow skipping email unless you have emailToken login configured, in which case we don't.
    if (providerEnabled("emailToken")) {
      const smtpConfig = globalDb.getSmtpConfig();
      return !!(smtpConfig && smtpConfig.hostname && smtpConfig.port && smtpConfig.returnAddress);
    } else {
      return true;
    }
  },

  preinstalled() {
    return globalDb.isPreinstalledAppsReady();
  },

  user() {
    return true;
  },

  success() {
    return true;
  },
};

const getRouteAfter = (currentStep) => {
  const steps = globalDb.isFeatureKeyValid() ? setupStepsForWork : setupSteps;
  const currentIdx = steps.indexOf(currentStep);
  const nextIdx = currentIdx + 1;
  return setupStepRouteMap[steps[nextIdx]];
};

const getRouteBefore = (currentStep) => {
  const steps = globalDb.isFeatureKeyValid() ? setupStepsForWork : setupSteps;
  const currentIdx = steps.indexOf(currentStep);
  const prevIdx = currentIdx - 1;
  return setupStepRouteMap[steps[prevIdx]];
};

Template.setupWizardProgressBar.helpers({
  currentStep() {
    return Template.instance().data.currentStep;
  },

  currentStepIs(step) {
    return Template.instance().data.currentStep === step;
  },

  currentStepAtOrPast(otherStep) {
    const steps = globalDb.isFeatureKeyValid() ? setupStepsForWork : setupSteps;
    const currentStep = Template.instance().data.currentStep;
    const currentIdx = steps.indexOf(currentStep);
    const otherIdx = steps.indexOf(otherStep);
    if (otherIdx === -1) {
      console.error("Invalid step '" + otherStep + "' - acceptable steps are " + steps);
    }

    return currentIdx >= otherIdx;
  },

  itemClassName() {
    return globalDb.isFeatureKeyValid() ? "of-five" : "of-four";
  },

  mayJumpTo(step) {
    // You may jump to a step if all the previous steps are considered completed.
    const steps = globalDb.isFeatureKeyValid() ? setupStepsForWork : setupSteps;
    for (let i = 0; i < steps.length; i++) {
      const stepName = steps[i];
      if (stepName === step) {
        return true;
      }

      if (!setupIsStepCompleted[stepName]()) {
        return false;
      }
    }

    return true;
  },

  hasFeatureKey() {
    return globalDb.isFeatureKeyValid();
  },
});

Template.setupWizardProgressBarItem.helpers({
  linkClassName() {
    const instance = Template.instance();
    return instance.data.isCurrentStep ? "setup-current-step" : "setup-not-current-step";
  },
});

Template.setupWizardVerifyToken.helpers({
  verifyState() {
    return Iron.controller().state.get("redeemStatus");
  },

  rejected() {
    return Iron.controller().state.get("redeemStatus") === "rejected";
  },
});

Template.setupWizardHelpFooter.onCreated(function () {
  this.showSystemLogOverlay = new ReactiveVar(false);
});

Template.setupWizardHelpFooter.helpers({
  showSystemLog() {
    const instance = Template.instance();
    return instance.showSystemLogOverlay.get();
  },

  hideSystemLogCallback() {
    const instance = Template.instance();
    return () => {
      instance.showSystemLogOverlay.set(false);
    };
  },
});

Template.setupWizardHelpFooter.events({
  "click button[name=system-log]"() {
    const instance = Template.instance();
    instance.showSystemLogOverlay.set(true);
  },
});

Template.setupWizardSystemLog.onCreated(function () {
  const token = sessionStorage.getItem("setup-token");
  this.token = token;
  if (this.token) {
    this.adminTokenSub = this.subscribe("adminToken", token);
  }

  this.adminLogSub = this.subscribe("adminLog", token);
});

Template.setupWizardSystemLog.helpers({
  ready() {
    const instance = Template.instance();
    return (!instance.token || instance.adminTokenSub.ready()) &&
        instance.adminLogSub.ready();
  },

  isUserPermitted() {
    const instance = Template.instance();
    let tokenStatus = undefined;
    if (instance.token) {
      tokenStatus = AdminToken.findOne();
    }

    const isUserPermitted = isAdmin() || (tokenStatus && tokenStatus.tokenIsValid);
    return isUserPermitted;
  },
});

Template.setupWizardSystemLog.events({
  "click button[name=download-full-log]"(evt) {
    Meteor.call("adminGetServerLogDownloadToken", sessionStorage.getItem("setup-token"),
        (err, token) => {
      if (err) {
        console.log(err.message);
      } else {
        const url = "/admin/status/server-log/" + token;
        const suggestedFilename = "sandstorm.log";
        downloadFile(url, suggestedFilename);
      }
    });
  },
});

Template.setupWizardIntro.onCreated(function () {
  this.errorMessage = new ReactiveVar(undefined);
  this.successMessage = new ReactiveVar(undefined);
  this.showSignInPanel = new ReactiveVar(false);
});

Template.setupWizardIntro.helpers({
  initialSetupComplete() {
    // We use the existence of any user as the heuristic for determining
    // if setup is complete, since creating the admin user is the final step.
    const hasUsersEntry = HasUsers.findOne("hasUsers");
    return hasUsersEntry && hasUsersEntry.hasUsers;
  },

  noIdpEnabled() {
    return !setupIsStepCompleted.identity();
  },

  currentUserIsAdmin() {
    return isAdmin();
  },

  showSignInPanel() {
    const instance = Template.instance();
    return instance.showSignInPanel.get();
  },

  identityUser() {
    const user = Meteor.user();
    return user && user.profile;
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },

  successMessage() {
    const instance = Template.instance();
    return instance.successMessage.get();
  },

  notLinkingNewIdentity() {
    return undefined;
  },

  freshAccountsUi() {
    return new AccountsUi(globalDb);
  },

  hasFeatureKey() {
    return globalDb.isFeatureKeyValid();
  },
});

Template.setupWizardIntro.events({
  "click .setup-sandstorm-standard"() {
    Router.go("setupWizardIdentity");
  },

  "click .setup-sandstorm-for-work"() {
    Router.go("setupWizardFeatureKey");
  },

  "click .make-self-admin"() {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("signUpAsAdmin", token, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
      } else {
        sessionStorage.removeItem("setup-token");
        instance.successMessage.set("You are now an admin.");
      }
    });
  },

  "click .sign-in-button"() {
    const instance = Template.instance();
    instance.showSignInPanel.set(true);
  },
});

Template.setupWizardFeatureKey.helpers({
  currentFeatureKey() {
    return globalDb.currentFeatureKey();
  },

  nextButtonClass() {
    return globalDb.isFeatureKeyValid() ? "" : "disabled";
  },
});

Template.setupWizardFeatureKey.events({
  "click .setup-next-button"() {
    if (globalDb.isFeatureKeyValid()) {
      Router.go(getRouteAfter("intro"));
    }
  },

  "click .setup-back-button"() {
    Router.go("setupWizardIntro");
  },
});

Template.setupWizardIdentity.helpers({
  nextHtmlDisabled() {
    const allowProgress = setupIsStepCompleted.identity();
    return allowProgress ? "" : "disabled";
  },
});

Template.setupWizardIdentity.events({
  "click .setup-next-button"() {
    Router.go(getRouteAfter("identity"));
  },

  "click .setup-back-button"() {
    Router.go(getRouteBefore("identity"));
  },
});

Template.setupWizardOrganization.onCreated(function () {
  const ldapChecked = globalDb.getOrganizationLdapEnabled() || false;
  const samlChecked = globalDb.getOrganizationSamlEnabled() || false;
  const gappsChecked = globalDb.getOrganizationGoogleEnabled() || false;
  const emailChecked = globalDb.getOrganizationEmailEnabled() || false;

  const featureKey = globalDb.currentFeatureKey();
  const featureKeyContactAddress = featureKey && featureKey.customer && featureKey.customer.contactEmail;
  const inferredDomain = featureKeyContactAddress && featureKeyContactAddress.split("@")[1] || "";

  const gappsDomain = globalDb.getOrganizationGoogleDomain() || inferredDomain;
  const emailDomain = globalDb.getOrganizationEmailDomain() || inferredDomain;

  const disallowGuests = globalDb.getOrganizationDisallowGuestsRaw() || false;
  const shareContacts = globalDb.getOrganizationShareContactsRaw() || false;

  this.ldapChecked = new ReactiveVar(ldapChecked);
  this.samlChecked = new ReactiveVar(samlChecked);
  this.gappsChecked = new ReactiveVar(gappsChecked);
  this.emailChecked = new ReactiveVar(emailChecked);
  this.gappsDomain = new ReactiveVar(gappsDomain);
  this.emailDomain = new ReactiveVar(emailDomain);
  this.disallowGuests = new ReactiveVar(disallowGuests);
  this.shareContacts = new ReactiveVar(shareContacts);
  this.errorMessage = new ReactiveVar(undefined);
});

Template.setupWizardOrganization.helpers({
  hasFeatureKey() {
    return globalDb.isFeatureKeyValid();
  },

  emailChecked() {
    const instance = Template.instance();
    return instance.emailChecked.get();
  },

  gappsChecked() {
    const instance = Template.instance();
    return instance.gappsChecked.get();
  },

  ldapChecked() {
    const instance = Template.instance();
    return instance.ldapChecked.get();
  },

  samlChecked() {
    const instance = Template.instance();
    return instance.samlChecked.get();
  },

  emailDisabled() {
    return !providerEnabled("emailToken");
  },

  gappsDisabled() {
    return !providerEnabled("google");
  },

  ldapDisabled() {
    return !providerEnabled("ldap");
  },

  samlDisabled() {
    return !providerEnabled("saml");
  },

  emailHtmlDisabled() {
    return providerEnabled("emailToken") ? "" : "disabled";
  },

  gappsHtmlDisabled() {
    return providerEnabled("google") ? "" : "disabled";
  },

  ldapHtmlDisabled() {
    return providerEnabled("ldap") ? "" : "disabled";
  },

  samlHtmlDisabled() {
    return providerEnabled("saml") ? "" : "disabled";
  },

  emailDomain() {
    const instance = Template.instance();
    return instance.emailDomain.get();
  },

  gappsDomain() {
    const instance = Template.instance();
    return instance.gappsDomain.get();
  },

  disallowGuests() {
    const instance = Template.instance();
    return instance.disallowGuests.get();
  },

  shareContacts() {
    const instance = Template.instance();
    return instance.shareContacts.get();
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },
});

Template.setupWizardOrganization.events({
  "click input[name=email-toggle]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.emailChecked.set(!instance.emailChecked.get());
  },

  "click input[name=gapps-toggle]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.gappsChecked.set(!instance.gappsChecked.get());
  },

  "click input[name=ldap-toggle]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.ldapChecked.set(!instance.ldapChecked.get());
  },

  "click input[name=saml-toggle]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.samlChecked.set(!instance.samlChecked.get());
  },

  "input input[name=email-domain]"(evt) {
    const instance = Template.instance();
    instance.emailDomain.set(evt.currentTarget.value);
  },

  "input input[name=gapps-domain]"(evt) {
    const instance = Template.instance();
    instance.gappsDomain.set(evt.currentTarget.value);
  },

  "click input[name=disallow-guests]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.disallowGuests.set(!instance.disallowGuests.get());
  },

  "click input[name=share-contacts]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    const instance = Template.instance();
    instance.shareContacts.set(!instance.shareContacts.get());
  },

  "click .setup-next-button"() {
    const instance = Template.instance();
    const params = {
      membership: {
        emailToken: {
          enabled: instance.emailChecked.get(),
          domain: instance.emailDomain.get().trim(),
        },
        google: {
          enabled: instance.gappsChecked.get(),
          domain: instance.gappsDomain.get().trim(),
        },
        ldap: {
          enabled: instance.ldapChecked.get(),
        },
        saml: {
          enabled: instance.samlChecked.get(),
        },
      },
      settings: {
        disallowGuests: instance.disallowGuests.get(),
        shareContacts: instance.shareContacts.get(),
      },
    };
    const token = Iron.controller().state.get("token");
    Meteor.call("saveOrganizationSettings", token, params, (err) => {
      if (err) {
        // Force repaint of focusingErrorBox to cause the error to be focused/scrolled on-screen,
        // even if err.message is the same as the previous value.
        instance.errorMessage.set(undefined);
        Tracker.flush();
        instance.errorMessage.set(err.message);
      } else {
        Router.go(getRouteAfter("organization"));
      }
    });
  },

  "click .setup-back-button"() {
    Router.go(getRouteBefore("organization"));
  },
});

Template.setupWizardEmailConfig.onCreated(function () {
  const smtpConfig = globalDb.getSmtpConfig();
  this.errorMessage = new ReactiveVar(undefined);
  this.smtpHostname = new ReactiveVar(smtpConfig && smtpConfig.hostname);
  this.smtpPort = new ReactiveVar(smtpConfig && smtpConfig.port);
  this.smtpUsername = new ReactiveVar(smtpConfig && smtpConfig.auth && smtpConfig.auth.user || "");
  this.smtpPassword = new ReactiveVar(smtpConfig && smtpConfig.auth && smtpConfig.auth.pass || "");
  this.smtpReturnAddress = new ReactiveVar(smtpConfig && smtpConfig.returnAddress);
  this.showTestSendEmailPopup = new ReactiveVar(false);
  this.getSmtpConfig = () => {
    const portValue = parseInt(this.smtpPort.get());
    const smtpConfig = {
      hostname: this.smtpHostname.get().trim(),
      port: _.isNaN(portValue) ? 25 : portValue,
      auth: {
        user: this.smtpUsername.get(),
        pass: this.smtpPassword.get(),
      },
      returnAddress: this.smtpReturnAddress.get().trim(),
    };
    return smtpConfig;
  };
});

Template.setupWizardEmailConfig.events({
  "input input[name=smtp-hostname]"(evt) {
    const instance = Template.instance();
    instance.smtpHostname.set(evt.currentTarget.value);
  },

  "input input[name=smtp-port]"(evt) {
    const instance = Template.instance();
    instance.smtpPort.set(evt.currentTarget.value);
  },

  "input input[name=smtp-username]"(evt) {
    const instance = Template.instance();
    instance.smtpUsername.set(evt.currentTarget.value);
  },

  "input input[name=smtp-password]"(evt) {
    const instance = Template.instance();
    instance.smtpPassword.set(evt.currentTarget.value);
  },

  "input input[name=smtp-return-address]"(evt) {
    const instance = Template.instance();
    instance.smtpReturnAddress.set(evt.currentTarget.value);
  },

  "click .setup-test-email-button"() {
    const instance = Template.instance();
    instance.showTestSendEmailPopup.set(true);
  },

  "click .setup-next-button"() {
    const instance = Template.instance();
    const smtpConfig = instance.getSmtpConfig();
    const token = Iron.controller().state.get("token");
    Meteor.call("setSmtpConfig", token, smtpConfig, (err) => {
      if (err) {
        // Force repaint of focusingErrorBox to cause the error to be focused/scrolled on-screen,
        // even if err.message is the same as the previous value.
        instance.errorMessage.set(undefined);
        Tracker.flush();
        instance.errorMessage.set(err.message);
      } else {
        Router.go(getRouteAfter("email"));
      }
    });
  },

  "click .setup-back-button"() {
    Router.go(getRouteBefore("email"));
  },

  "click .setup-skip-email"() {
    Router.go(getRouteAfter("email"));
  },
});

Template.setupWizardEmailConfig.helpers({
  smtpHostname() {
    const instance = Template.instance();
    return instance.smtpHostname.get();
  },

  smtpPort() {
    const instance = Template.instance();
    return instance.smtpPort.get();
  },

  smtpUsername() {
    const instance = Template.instance();
    return instance.smtpUsername.get();
  },

  smtpPassword() {
    const instance = Template.instance();
    return instance.smtpPassword.get();
  },

  smtpReturnAddress() {
    const instance = Template.instance();
    return instance.smtpReturnAddress.get();
  },

  showTestSendEmailPopup() {
    const instance = Template.instance();
    return instance.showTestSendEmailPopup.get();
  },

  closePopupCallback() {
    const instance = Template.instance();
    return () => {
      instance.showTestSendEmailPopup.set(false);
    };
  },

  nextHtmlDisabled() {
    const instance = Template.instance();
    // If email login is enabled, require a valid hostname, port, and return address.
    const forbidProgress = providerEnabled("emailToken") && (
        !instance.smtpHostname.get() ||
        !instance.smtpPort.get() ||
        !instance.smtpReturnAddress.get()
        );
    return forbidProgress ? "disabled" : "";
  },

  skipHtmlDisabled() {
    const smtpConfig = globalDb.getSmtpConfig();
    const forbidProgress = providerEnabled("emailToken") && (
        !(smtpConfig && smtpConfig.hostname && smtpConfig.port && smtpConfig.returnAddress)
    );
    return forbidProgress ? "disabled" : "";
  },

  testHtmlDisabled() {
    const instance = Template.instance();
    const missingRequiredSetting = (
        !instance.smtpHostname.get() ||
        !instance.smtpPort.get() ||
        !instance.smtpReturnAddress.get()
        );
    return missingRequiredSetting ? "disabled" : "";
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },

  token() {
    return Iron.controller().state.get("token");
  },

  getSmtpConfig() {
    const instance = Template.instance();
    return instance.getSmtpConfig();
  },
});

Template.setupWizardPreinstalled.onCreated(function () {
  this.appIndexSubscription = this.subscribe("appIndexAdmin",
    Iron.controller().state.get("token"));
  this.packageSubscription = this.subscribe("allPackages",
    Iron.controller().state.get("token"));
});

Template.setupWizardPreinstalled.events({
  "click .setup-back-button"(ev, instance) {
    Router.go(getRouteBefore("preinstalled"));
  },

  "click .setup-next-button"(ev, instance) {
    // Actually do nothing, since apps are already pre-installed and ready
    Router.go(getRouteAfter("preinstalled"));
  },

  "click .setup-skip-button"(ev, instance) {
    Meteor.call("setPreinstalledApps", []);
    // Overwrite the default setting for "setPreinstalledApps"
    Router.go(getRouteAfter("preinstalled"));
  },
});

Template.setupWizardPreinstalled.helpers({
  allowNext() {
    return globalDb.isPreinstalledAppsReady();
  },

  allowSkip() {
    const instance = Template.instance();
    const apps = globalDb.collections.appIndex.find({ _id: {
      $in: globalDb.getProductivitySuiteAppIds().concat(
        globalDb.getSystemSuiteAppIds()), },
    }).fetch();
    const appIndexCount = globalDb.collections.appIndex.find({}).count();
    const failedAppsCount = globalDb.collections.packages.find({
      _id: {
        $in: _.pluck(apps, "packageId"),
      },
      status: "failed",
    }).count();
    return (instance.appIndexSubscription.ready() && appIndexCount === 0) ||
      failedAppsCount !== 0;
  },

  preinstallApps() {
    const allAppIds = globalDb.getProductivitySuiteAppIds().concat(
      globalDb.getSystemSuiteAppIds());
    return globalDb.collections.appIndex.find({ _id: {
      $in: allAppIds, },
    }, { sort: { name: 1 } });
  },

  isAppDownloaded() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    return pack && pack.status === "ready";
  },

  isAppDownloading() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    return pack && _.contains(["verify", "unpack", "analyze", "download"], pack.status);
  },

  isAppFailed() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    return pack && pack.status === "failed";
  },

  progressFraction() {
    const pack = globalDb.collections.packages.findOne({ _id: this.packageId });
    if (_.contains(["verify", "unpack", "analyze"], pack.status)) {
      // Downloading is done
      return 1;
    }

    return pack && pack.progress;
  },
});

Template.setupWizardLoginUser.onCreated(function () {
  this.triedRedeemingToken = false;
  this.errorMessage = new ReactiveVar(undefined);
  this.successMessage = new ReactiveVar(undefined);
});

Template.setupWizardLoginUser.helpers({
  freshAccountsUi() {
    return new AccountsUi(globalDb);
  },

  accountProfileEditorData() {
    const instance = Template.instance();
    // copied from packages/sandstorm-accounts-ui/account-settings.js
    const identityId = SandstormDb.getUserIdentityIds(Meteor.user())[0];
    const identity = Meteor.users.findOne({ _id: identityId });
    if (identity) {
      SandstormDb.fillInProfileDefaults(identity);
      SandstormDb.fillInIntrinsicName(identity);
      SandstormDb.fillInPictureUrl(identity);
    }

    return {
      identity,
      staticHost: window.location.protocol + "//" + makeWildcardHost("static"),
      db: globalDb,
      hideButtons: true,
      setActionCompleted(result) {
        if (result.success) {
          instance.successMessage.set(result.success);
        } else if (result.error) {
          instance.errorMessage.set(result.error);
        }
      },
    };
  },

  currentUserIsAdmin() {
    return isAdmin();
  },

  serverHasAdmin() {
    return HasAdmin.findOne();
  },

  currentUserFirstLogin() {
    return !Meteor.loggingIn() && Meteor.user() && !Meteor.user().hasCompletedSignup;
  },

  identityUser() {
    const user = Meteor.user();
    return user && user.profile;
  },

  redeemSessionForAdmin() {
    const instance = Template.instance();
    if (!instance.triedRedeemingToken && !isAdmin()) {
      instance.triedRedeemingToken = true;
      const token = Iron.controller().state.get("token");
      Meteor.call("signUpAsAdmin", token, (err) => {
        if (err) {
          instance.errorMessage.set(err.message);
        } else {
          // We were made into an admin.  Delete our token.
          sessionStorage.removeItem("setup-token");
          instance.successMessage.set("You are now an admin.");
        }
      });
    }

    return;
  },

  accountSettingsUi() {
    return new SandstormAccountSettingsUi(globalTopbar, globalDb,
        window.location.protocol + "//" + makeWildcardHost("static"));
  },

  errorMessage() {
    const instance = Template.instance();
    return instance.errorMessage.get();
  },

  successMessage() {
    const instance = Template.instance();
    return instance.successMessage.get();
  },

  nextHtmlDisabled() {
    const hasAdmin = HasAdmin.findOne();
    return hasAdmin ? "" : "disabled";
  },

  notLinkingNewIdentity() {
    // This apparently has to exist as a key in the parent data context.
    return undefined;
  },
});

Template.setupWizardLoginUser.events({
  "click .make-self-admin"() {
    const instance = Template.instance();
    const token = Iron.controller().state.get("token");
    Meteor.call("signUpAsAdmin", token, (err) => {
      if (err) {
        instance.errorMessage.set(err.message);
      } else {
        // We were made into an admin.  Delete our token.
        sessionStorage.removeItem("setup-token");
        instance.successMessage.set("You are now an admin.");
      }
    });
  },

  "click .setup-back-button"() {
    Router.go(getRouteBefore("user"));
  },

  "click .setup-next-button"() {
    const instance = Template.instance();
    const isFirstLogin = Meteor.user() && !Meteor.user().hasCompletedSignup;
    if (isFirstLogin) {
      // If your profile is unconfirmed, attempt to save it.
      const form = instance.find("form");
      const profileEditorInstance = Blaze.getView(form).templateInstance();
      profileEditorInstance.submitProfileForm(form, () => {
        Router.go(getRouteAfter("user"));
      });
    } else {
      Router.go(getRouteAfter("user"));
    }
  },
});

Template.setupWizardSuccess.helpers({
  someOrgMembershipEnabled() {
    return (
      globalDb.getOrganizationLdapEnabled() ||
      globalDb.getOrganizationSamlEnabled() ||
      globalDb.getOrganizationGoogleEnabled() ||
      globalDb.getOrganizationEmailEnabled()
    );
  },
});

Template.setupWizardSuccess.events({
  "click .setup-back-button"() {
    Router.go(getRouteBefore("success"));
  },
});

const setupRoute = RouteController.extend({
  waitOn() {
    const token = sessionStorage.getItem("setup-token");
    const subs = [
      Meteor.subscribe("admin", token),
      Meteor.subscribe("adminServiceConfiguration", token),
      Meteor.subscribe("credentials"),
      Meteor.subscribe("featureKey", true, token),
      Meteor.subscribe("hasUsers"),
      Meteor.subscribe("hasAdmin", token),
    ];
    if (token) {
      subs.push(Meteor.subscribe("adminToken", token));
    }

    return subs;
  },

  action() {
    const token = sessionStorage.getItem("setup-token");
    const state = this.state;
    state.set("token", token);
    let tokenStatus = undefined;
    if (token) {
      tokenStatus = AdminToken.findOne();
    }

    const isUserPermitted = isAdmin() || (tokenStatus && tokenStatus.tokenIsValid);
    if (!isUserPermitted) {
      Router.go("setupWizardTokenExpired", {}, { replaceState: true });
    }

    this.render();
  },

  onAfterAction() {
    // Scroll to the top of the page each time you navigate to a setup wizard page.
    document.getElementsByTagName("body")[0].scrollTop = 0;
  },
});

Template.setupWizardTokenExpired.helpers({
  hasUsers() {
    const hasUsersEntry = HasUsers.findOne("hasUsers");
    return hasUsersEntry && hasUsersEntry.hasUsers;
  },
});

Router.map(function () {
  this.route("setupWizardIntro", {
    path: "/setup",
    layoutTemplate: "setupWizardLayout",
    controller: setupRoute,
  });
  this.route("setupWizardFeatureKey", {
    path: "/setup/feature-key",
    layoutTemplate: "setupWizardLayout",
    controller: setupRoute,
  });
  this.route("setupWizardIdentity", {
    path: "/setup/identity",
    layoutTemplate: "setupWizardLayout",
    controller: setupRoute,
  });
  this.route("setupWizardOrganization", {
    path: "/setup/organization",
    layoutTemplate: "setupWizardLayout",
    controller: setupRoute,
  });
  this.route("setupWizardEmailConfig", {
    path: "/setup/email",
    layoutTemplate: "setupWizardLayout",
    controller: setupRoute,
  });
  this.route("setupWizardPreinstalled", {
    path: "/setup/preinstalled",
    layoutTemplate: "setupWizardLayout",
    controller: setupRoute,
  });
  this.route("setupWizardLoginUser", {
    path: "/setup/user",
    layoutTemplate: "setupWizardLayout",
    controller: setupRoute,
  });
  this.route("setupWizardSuccess", {
    path: "/setup/success",
    layoutTemplate: "setupWizardLayout",
    controller: setupRoute,
  });
  this.route("setupWizardVerifyToken", {
    path: "/setup/token/:_token",
    layoutTemplate: "setupWizardLayout",
    onBeforeAction() {
      this.state.set("redeemStatus", "in-progress");
      // For whatever reason, the RouteController is no longer available in the async callback
      // below, so we save a handle to the state object.
      const state = this.state;
      Meteor.call("redeemSetupToken", this.params._token, (err, result) => {
        if (err) {
          console.log("token was rejected");
          console.log(err);
          state.set("redeemStatus", "rejected");
        } else {
          sessionStorage.setItem("setup-token", result);
          Router.go("setupWizardIntro");
        }
      });
      this.next();
    },
  });
  this.route("setupWizardTokenExpired", {
    path: "/setup/expired",
    layoutTemplate: "setupWizardLayout",
    waitOn() {
      return [
        Meteor.subscribe("hasUsers"),
      ];
    },
  });
});
