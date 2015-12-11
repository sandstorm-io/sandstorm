// for convenience
var loginButtonsSession = Accounts._loginButtonsSession;

var helpers = {
  isCurrentRoute: function (routeName) {
    return Router.current().route.getName() == routeName;
  },
  isDemoUser: function () {
    return this._db.isDemoUser();
  }
};

Template.loginButtons.helpers(helpers);
Template.loginButtonsPopup.helpers(helpers);
Template._loginButtonsLoggedOutDropdown.helpers(helpers);
Template._loginButtonsLoggedInDropdown.helpers(helpers);

Template.loginButtonsPopup.onRendered(function() {
  this.find("[role=menuitem]").focus();
});

Template.accountButtonsPopup.onRendered(function() {
  this.find("[role=menuitem]").focus();
});

Template.accountButtonsPopup.events({
  'click button.logout': function() {
    // TODO(cleanup): Don't rely on global var set in outermost package!
    logoutSandstorm();
  }
});

var displayName = function () {
  var currentIdentityId = Accounts.getCurrentIdentityId();
  var user = Meteor.users.findOne({_id: currentIdentityId});
  if (!user) return "(incognito)";

  SandstormDb.fillInProfileDefaults(user);
  return user.profile.name;
};

Template.accountButtons.helpers({
  displayName: displayName
});

// returns an array of the login services used by this app. each
// element of the array is an object (eg {name: 'facebook'}), since
// that makes it useful in combination with handlebars {{#each}}.
//
// don't cache the output of this function: if called during startup (before
// oauth packages load) it might not include them all.
//
// NOTE: It is very important to have this return email token last
// because of the way we render the different providers in
// login_buttons_dropdown.html
getLoginServices = function () {
  var self = this;

  // First look for OAuth services.
  var services = (Accounts.oauth && Accounts.oauth.serviceNames) ? Accounts.oauth.serviceNames() : [];

  services = _.without(services, "emailToken");
  // Be equally kind to all login services. This also preserves
  // backwards-compatibility. (But maybe order should be
  // configurable?)
  services.sort();

  // Add email token, if it's there; it must come last.
  if (hasEmailTokenService())
    services.push('emailToken');

  return _.map(services, function(name) {
    return {name: name};
  });
};

hasEmailTokenService = function () {
  return Accounts.emailToken && Accounts.emailToken.isEnabled();
};

Template._loginButtonsMessages.helpers({
  errorMessage: function () {
    return loginButtonsSession.get('errorMessage');
  }
});

Template._loginButtonsMessages.helpers({
  infoMessage: function () {
    return loginButtonsSession.get('infoMessage');
  }
});

var loginResultCallback = function (serviceName, err, topbar) {
  if (!err) {
    loginButtonsSession.closeDropdown();
    if (topbar) topbar.closePopup();
  } else if (err instanceof Accounts.LoginCancelledError) {
    // do nothing
  } else if (err instanceof ServiceConfiguration.ConfigError) {
    Router.go("adminSettings");
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
  if (_.contains(_.pluck(getLoginServices(), "name"), attemptInfo.type))
    loginResultCallback(attemptInfo.type, attemptInfo.error);
});

// XXX from http://epeli.github.com/underscore.string/lib/underscore.string.js
var capitalize = function(str){
  str = str == null ? '' : String(str);
  return str.charAt(0).toUpperCase() + str.slice(1);
};

Template._loginButtonsLoggedOutDropdown.onCreated(function() {
  this._topbar = Template.parentData(3);
  this._choseLogin = new ReactiveVar(false);
});

Template._loginButtonsLoggedOutDropdown.helpers({
  choseLogin: function () {
    return Template.instance()._choseLogin.get();
  }
});

Template._loginButtonsLoggedOutDropdown.events({
  "click .login-suggestion>button.login": function (event, instance) {
    instance._choseLogin.set(true);
  },

  "click .login-suggestion>button.dismiss": function (event, instance) {
    instance._topbar.closePopup();
  }
});

Template._loginButtonsLoggedInDropdown.onCreated(function() {
  this._identitySwitcherExpanded = new ReactiveVar(false);
});

Template._loginButtonsLoggedInDropdown.helpers({
  displayName: displayName,
  showIdentitySwitcher: function() {
    return SandstormDb.getUserIdentityIds(Meteor.user()).length > 1;
  },
  identitySwitcherExpanded: function () {
    return Template.instance()._identitySwitcherExpanded.get();
  },
  identitySwitcherData: function () {
    var identities = SandstormDb.getUserIdentityIds(Meteor.user()).map(function (id) {
      var identity = Meteor.users.findOne({_id: id});
      if (identity) {
        SandstormDb.fillInProfileDefaults(identity);
        SandstormDb.fillInIntrinsicName(identity);
        SandstormDb.fillInPictureUrl(identity);
        return identity;
      }
    });
    function onPicked(identityId) {
      Accounts.setCurrentIdentityId(identityId);
    }
    return { identities: identities, onPicked: onPicked,
             currentIdentityId: Accounts.getCurrentIdentityId() };
  },


});

Template._loginButtonsLoggedInDropdown.events({
  "click button.switch-identity" : function (event, instance) {
    instance._identitySwitcherExpanded.set(!instance._identitySwitcherExpanded.get());
  },
});

var sendEmail = function (email, linkingNewIdentity) {
  loginButtonsSession.infoMessage("Sending email...");
  Accounts.createAndEmailTokenForUser(email, linkingNewIdentity, function(err) {
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

var loginWithToken = function (email, token, topbar) {
  loginButtonsSession.infoMessage("Logging in...");
  Meteor.loginWithEmailToken(email, token, function (err) {
    if (err) {
      loginButtonsSession.errorMessage(err.reason || "Unknown error");
    } else {
      loginButtonsSession.set("inSignupFlow", false);
      loginButtonsSession.closeDropdown();
      if (topbar) topbar.closePopup();
    }
  });
};

Template.loginButtonsDialog.helpers({
  allowUninvited: function () {
    return Meteor.settings.public.allowUninvited;
  }
});

Template.loginButtonsList.onCreated(function() {
   if (this.view.parentView.name === "Template._loginButtonsLoggedOutDropdown") {
     this._topbar = Template.parentData(3);
   }

  if (isDemoUser()) {
    this._linkingNewIdentity = { doneCallback: function() {} };
  } else if (Template.parentData(1).linkingNewIdentity) {
    this._linkingNewIdentity = Template.parentData(1).linkingNewIdentity;
  }
});

Template.loginButtonsList.events({
  "click button.login.oneclick": function (event, instance) {
    if (instance._linkingNewIdentity) {
      sessionStorage.setItem("linkingIdentityLoginToken", Accounts._storedLoginToken());
    }

    var serviceName = this.name;
    loginButtonsSession.resetMessages();

    // XXX Service providers should be able to specify their
    // `Meteor.loginWithX` method name.
    var loginWithService = Meteor["loginWith" +
                                  (serviceName === 'meteor-developer' ?
                                   'MeteorDeveloperAccount' :
                                   capitalize(serviceName))];

    loginWithService({}, function (err) {
      loginResultCallback(serviceName, err, instance.topbar);
    });
  },
});

Template.loginButtonsList.helpers({
  configured: function () {
    return !!ServiceConfiguration.configurations.findOne({service: this.name}) ||
           Template.instance().data._services.get(this.name);
  },

  capitalizedName: function () {
    var text = Template.instance().data._services.get(this.name);
    if (text) return text;

    if (this.name === 'github')
      // XXX we should allow service packages to set their capitalized name
      return 'GitHub';
    else if (this.name === 'meteor-developer')
      return 'Meteor';
    else
      return capitalize(this.name);
  },

  services: getLoginServices,

  isEmailTokenService: function () {
    return this.name === 'emailToken';
  },

  hasOtherServices: function () {
    return getLoginServices().length > 1;
  },

  showTroubleshooting: function () {
    return !(Meteor.settings && Meteor.settings.public &&
      Meteor.settings.public.hideTroubleshooting);
  },

  linkingNewIdentity: function () {
    return Template.instance()._linkingNewIdentity;
  }
});

Template.emailLoginForm.events({
  "submit form": function (event, instance) {
    event.preventDefault();
    var form = event.currentTarget;
    var email = loginButtonsSession.get("inSignupFlow");
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
        loginWithToken(email, form.token.value, instance._topbar);
      }
    } else {
      sendEmail(form.email.value, !!instance.data.linkingNewIdentity);
    }
  },

  "click button.cancel": function (event) {
    loginButtonsSession.set("inSignupFlow", false);
    loginButtonsSession.resetMessages();
  },
});

Template.emailLoginForm.helpers({
  disabled: function () {
    return !hasEmailTokenService();
  },
  awaitingToken: function () {
    return loginButtonsSession.get('inSignupFlow');
  },
});
