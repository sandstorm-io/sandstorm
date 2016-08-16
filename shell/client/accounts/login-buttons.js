// forked from Meteor's accounts-ui from https://github.com/meteor/meteor/tree/ab9ef40d258bbb9b9de453600495c8337577c565/packages/accounts-ui-unstyled
//
// ========================================
// Meteor is licensed under the MIT License
// ========================================
//
// Copyright (C) 2011--2015 Meteor Development Group
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
//
//
// ====================================================================
// This license applies to all code in Meteor that is not an externally
// maintained library. Externally maintained libraries have their own
// licenses, included in the LICENSES directory.
// ====================================================================

import {
  loginWithEmailToken,
  createAndEmailTokenForUser,
} from "/imports/client/accounts/email-token/token-login-helpers.js";
import { loginWithLDAP } from "/imports/client/accounts/ldap/ldap-client.js";
import { loginWithSaml } from "/imports/client/accounts/saml/saml-client.js";

// for convenience
const loginButtonsSession = Accounts._loginButtonsSession;

const helpers = {
  isCurrentRoute: function (routeName) {
    return Router.current().route.getName() == routeName;
  },

  isDemoUser: function () {
    return this._db.isDemoUser();
  },
};

Template.loginButtons.helpers(helpers);
Template.loginButtonsPopup.helpers(helpers);
Template._loginButtonsLoggedOutDropdown.helpers(helpers);
Template._loginButtonsLoggedInDropdown.helpers(helpers);

Template.loginButtonsPopup.onRendered(function () {
  let element = this.find(".login-buttons-list :first-child");
  if (!element) {
    element = this.find(".login-suggestion button.login");
  }

  if (element) element.focus();
});

Template.accountButtonsPopup.onRendered(function () {
  const element = this.find(".account-buttons-list :first-child");
  if (element) element.focus();
});

Template.accountButtonsPopup.events({
  "click button.logout": function () {
    // TODO(cleanup): Don't rely on global var set in outermost package!
    logoutSandstorm();
  },
});

function getActiveIdentityId(grains) {
  const activeGrain = grains.getActive();
  return activeGrain ? activeGrain.identityId() : Accounts.getCurrentIdentityId();
}

Template.accountButtons.helpers({
  displayName: function () {
    if (Meteor.user() && !Meteor.user().loginIdentities && !Meteor.user().profile) {
      // Need to wait for resume token to complete login. For some reason, `Meteor.loggingIn()`
      // is still false in this case.
      return "Loading...";
    }

    const currentIdentityId = getActiveIdentityId(this.grains);
    const user = Meteor.users.findOne({ _id: currentIdentityId });
    if (currentIdentityId && !user) {
      // Need to wait for the `identityProfile` subscription to be ready.
      return "Loading...";
    }

    if (!user) return "(incognito)";

    SandstormDb.fillInProfileDefaults(user);
    return user.profile.name;
  },
});

function getServices() {
  return _.keys(Accounts.identityServices).map(function (key) {
    return _.extend(Accounts.identityServices[key], { name: key });
  }).filter(function (service) {
    return service.isEnabled() && !!service.loginTemplate;
  }).sort(function (s1, s2) { return s1.loginTemplate.priority - s2.loginTemplate.priority; });
}

Template._loginButtonsMessages.helpers({
  errorMessage: function () {
    return loginButtonsSession.get("errorMessage");
  },
});

Template._loginButtonsMessages.helpers({
  infoMessage: function () {
    return loginButtonsSession.get("infoMessage");
  },
});

const loginResultCallback = function (serviceName, err) {
  if (!err) {
    loginButtonsSession.closeDropdown();
  } else if (err instanceof Accounts.LoginCancelledError) {
    // do nothing
  } else if (err instanceof ServiceConfiguration.ConfigError) { // jscs:ignore disallowEmptyBlocks
    loginButtonsSession.errorMessage(
      "Configuration problem: " + err.message + ". Please visit the Admin Settings page within " +
      "Sandstorm, or ask your administrator to do so. You may need an admin token. Read more by " +
      "clicking Troubleshooting below.");
  } else {
    loginButtonsSession.errorMessage(err.reason || "Unknown error");
  }
};

// In the login redirect flow, we'll have the result of the login
// attempt at page load time when we're redirected back to the
// application.  Register a callback to update the UI (i.e. to close
// the dialog on a successful login or display the error on a failed
// login).
//
Accounts.onPageLoadLogin(function (attemptInfo) {
  // Ignore if we have a left over login attempt for a service that is no longer registered.
  if (_.contains(_.pluck(getServices(), "name"), attemptInfo.type))
    loginResultCallback(attemptInfo.type, attemptInfo.error);
});

Template._loginButtonsLoggedOutDropdown.onCreated(function () {
  this._topbar = Template.parentData(3);
  this._choseLogin = new ReactiveVar(false);
});

Template._loginButtonsLoggedOutDropdown.helpers({
  choseLogin: function () {
    return Template.instance()._choseLogin.get();
  },
});

Template._loginButtonsLoggedOutDropdown.events({
  "click .login-suggestion>button.login": function (evt, instance) {
    instance._choseLogin.set(true);
  },

  "click .login-suggestion>button.dismiss": function (evt, instance) {
    instance._topbar.closePopup();
  },
});

Template._loginButtonsLoggedInDropdown.onCreated(function () {
  this._identitySwitcherExpanded = new ReactiveVar(false);
});

Template._loginButtonsLoggedInDropdown.helpers({
  showIdentitySwitcher: function () {
    return SandstormDb.getUserIdentityIds(Meteor.user()).length > 1;
  },

  identitySwitcherExpanded: function () {
    return Template.instance()._identitySwitcherExpanded.get();
  },

  identitySwitcherData: function () {
    const grains = this.grains;
    const identities = SandstormDb.getUserIdentityIds(Meteor.user()).map(function (id) {
      const identity = Meteor.users.findOne({ _id: id });
      if (identity) {
        SandstormDb.fillInProfileDefaults(identity);
        SandstormDb.fillInIntrinsicName(identity);
        SandstormDb.fillInPictureUrl(identity);
        return identity;
      }
    });

    function onPicked(identityId) {
      const activeGrain = grains.getActive();
      if (activeGrain) {
        activeGrain.switchIdentity(identityId);
      } else {
        Accounts.setCurrentIdentityId(identityId);
      }
    }

    return {
      identities,
      onPicked,
      currentIdentityId: getActiveIdentityId(grains),
    };
  },

});

Template._loginButtonsLoggedInDropdown.events({
  "click button.switch-identity": function (evt, instance) {
    instance._identitySwitcherExpanded.set(!instance._identitySwitcherExpanded.get());
  },
});

const sendEmail = function (email, linkingNewIdentity) {
  loginButtonsSession.infoMessage("Sending email...");
  const loc = window.location;
  const pathToResume = loc.pathname + loc.search + loc.hash;
  createAndEmailTokenForUser(email, linkingNewIdentity, pathToResume, function (err) {
    if (err) {
      loginButtonsSession.errorMessage(err.reason || "Unknown error");
      if (err.error === 409) {
        // 409 is a special case where the user can resolve the problem on their own.
        // Specifically, we're using 409 to mean that the email wasn't sent because a rate limit
        // was hit.
        loginButtonsSession.set("inSignupFlow", email);
      }
    } else {
      loginButtonsSession.set("inSignupFlow", email);
      loginButtonsSession.resetMessages();
    }
  });
};

const loginWithToken = function (email, token) {
  loginButtonsSession.infoMessage("Logging in...");
  loginWithEmailToken(email, token, function (err, resumePath) {
    if (err) {
      loginButtonsSession.errorMessage(err.reason || "Unknown error");
    } else {
      // We ignore resumePath here on the grounds that it is probably surprising to navigate back to
      // the login-initiating path if it's not the current path already anyway.
      loginButtonsSession.set("inSignupFlow", false);
      loginButtonsSession.closeDropdown();
    }
  });
};

Template.loginButtonsDialog.helpers({
  allowUninvited: function () {
    return Meteor.settings.public.allowUninvited;
  },

  logoUrl() {
    const defaultLogoUrl = "/sandstorm-gradient-logo.svg";
    if (globalDb.isFeatureKeyValid()) {
      const assetId = globalDb.getSettingWithFallback("whitelabelCustomLogoAssetId", "");
      if (assetId) {
        return `${window.location.protocol}//${globalDb.makeWildcardHost("static")}/${assetId}`;
      }
    }

    return defaultLogoUrl;
  },
});

Template.loginButtonsList.onCreated(function () {
  if (isDemoUser()) {
    this._linkingNewIdentity = { doneCallback: function () {} };
  } else if (Template.parentData(1).linkingNewIdentity) {
    this._linkingNewIdentity = Template.parentData(1).linkingNewIdentity;
  }
});

Template.oauthLoginButton.events({
  "click button.login.oneclick": function (evt, instance) {
    if (instance.data.linkingNewIdentity) {
      sessionStorage.setItem("linkingIdentityLoginToken", Accounts._storedLoginToken());
    }

    loginButtonsSession.resetMessages();

    const loginWithService = Meteor[instance.data.data.method];

    const serviceName = instance.data.data.displayName;
    loginWithService({}, function (err) {
      loginResultCallback(serviceName, err);
    });
  },
});

Template.loginButtonsList.helpers({
  configured: function () {
    return !!ServiceConfiguration.configurations.findOne({ service: this.name }) ||
           Template.instance().data._services.get(this.name);
  },

  services: getServices,

  showTroubleshooting: function () {
    const hiddenByConfFile = (Meteor.settings && Meteor.settings.public &&
      Meteor.settings.public.hideTroubleshooting);
    const hiddenByDbSetting = (this._db.isFeatureKeyValid() &&
      this._db.getSettingWithFallback("whitelabelHideTroubleshooting", false));
    return !hiddenByConfFile && !hiddenByDbSetting;
  },

  linkingNewIdentity: function () {
    return Template.instance()._linkingNewIdentity;
  },
});

Template.emailAuthenticationForm.events({
  "submit form": function (evt, instance) {
    evt.preventDefault();
    const form = evt.currentTarget;
    const email = loginButtonsSession.get("inSignupFlow");
    if (email) {
      if (instance.data.linkingNewIdentity) {
        Meteor.call("linkEmailIdentityToAccount", email, form.token.value, function (err, result) {
          if (err) {
            loginButtonsSession.errorMessage(err.reason || "Unknown error");
          } else {
            loginButtonsSession.set("inSignupFlow", false);
            loginButtonsSession.closeDropdown();
            instance.data.linkingNewIdentity.doneCallback();
          }
        });
      } else {
        loginWithToken(email, form.token.value);
      }
    } else {
      sendEmail(form.email.value, !!instance.data.linkingNewIdentity);
    }
  },

  "click button.cancel": function (evt) {
    loginButtonsSession.set("inSignupFlow", false);
    loginButtonsSession.resetMessages();
  },
});

Template.emailAuthenticationForm.helpers({
  disabled: function () {
    return !(Accounts.identityServices.email && Accounts.identityServices.email.isEnabled());
  },

  awaitingToken: function () {
    return loginButtonsSession.get("inSignupFlow");
  },
});

Template.ldapLoginForm.helpers({
  loginProviderLabel() {
    const defaultLabel = "with LDAP";
    if (globalDb.isFeatureKeyValid()) {
      const override = globalDb.getSettingWithFallback("whitelabelCustomLoginProviderName", "");
      return override || defaultLabel;
    }

    return defaultLabel;
  },
});

Template.ldapLoginForm.events({
  "submit form": function (evt, instance) {
    evt.preventDefault();
    if (instance.data.linkingNewIdentity) {
      sessionStorage.setItem("linkingIdentityLoginToken", Accounts._storedLoginToken());
    }

    loginButtonsSession.resetMessages();

    const form = evt.currentTarget;

    const username = form.username.value;
    const password = form.password.value;

    loginWithLDAP(username, password, function (err) {
      if (err) {
        loginButtonsSession.errorMessage(err.reason || "Unknown error");
      }
    });
  },
});

Template.devLoginForm.onCreated(function () {
  this._expanded = new ReactiveVar(false);
});

Template.devLoginForm.helpers({
  expanded: function () {
    return Template.instance()._expanded.get();
  },
});

function loginDevHelper(name, isAdmin, linkingNewIdentity) {
  if (linkingNewIdentity) {
    sessionStorage.setItem("linkingIdentityLoginToken", Accounts._storedLoginToken());
  }

  loginDevAccount(name, isAdmin);
}

Template.devLoginForm.events({
  "click button.expand": function (evt, instance) {
    evt.preventDefault();
    instance._expanded.set(true);
  },

  "click button.unexpand": function (evt, instance) {
    evt.preventDefault();
    instance._expanded.set(false);
  },

  "click button.login-dev-account": function (evt, instance) {
    const displayName = evt.currentTarget.getAttribute("data-name");
    const isAdmin = !!evt.currentTarget.getAttribute("data-is-admin");
    loginDevHelper(displayName, isAdmin, instance.data.linkingNewIdentity);
  },

  "submit form": function (evt, instance) {
    evt.preventDefault();
    const form = instance.find("form");
    loginDevHelper(form.name.value, false, instance.data.linkingNewIdentity);
  },
});

Template.samlLoginForm.helpers({
  loginProviderLabel() {
    const defaultLabel = "with SAML";
    if (globalDb.isFeatureKeyValid()) {
      const override = globalDb.getSettingWithFallback("whitelabelCustomLoginProviderName", "");
      return override || defaultLabel;
    }

    return defaultLabel;
  },
});

Template.samlLoginForm.events({
  "click button": function (evt, instance) {
    if (instance.data.linkingNewIdentity) {
      sessionStorage.setItem("linkingIdentityLoginToken", Accounts._storedLoginToken());
    }

    loginButtonsSession.resetMessages();

    loginWithSaml({
      provider: "default",
    }, function (error, result) {
      if (error) {
        loginButtonsSession.errorMessage(error.reason || "Unknown error");
      }
    });
  },
});
