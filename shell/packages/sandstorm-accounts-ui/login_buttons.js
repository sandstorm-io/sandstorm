// for convenience
var loginButtonsSession = Accounts._loginButtonsSession;

var helpers = {
  isDemoUser: function () {
    return this._db.isDemoUser();
  },
  demoTimeLeft: function () {
    var ms = Meteor.user().expires.getTime() - Date.now();
    var sec = Math.floor(ms / 1000) % 60;
    if (sec < 10) sec = "0" + sec;
    var min = Math.floor(ms / 60000);
    var comp = Tracker.currentComputation;
    if (comp) {
      Meteor.setTimeout(comp.invalidate.bind(comp), 1000);
    }
    return min + ":" + sec;
  },
  expiringSoon: function () {
    var timeToExpiring = Meteor.user().expires.getTime() - Date.now() - 600000;
    if (timeToExpiring <= 0) return true;
    var comp = Tracker.currentComputation;
    if (comp) {
      Meteor.setTimeout(comp.invalidate.bind(comp), timeToExpiring);
    }
    return false;
  }
};

Template.loginButtons.helpers(helpers);
Template.loginButtonsPopup.helpers(helpers);
Template._loginButtonsLoggedOutDropdown.helpers(helpers);

Template.loginButtonsPopup.events({
  'click button.login.logout': function() {
    var topbar = Template.parentData(3);
    Meteor.logout(function () {
      loginButtonsSession.closeDropdown();
      topbar.closePopup();
    });
  }
});

var displayName = function () {
  var user = Meteor.user();
  if (!user)
    return '';

  if (user.profile && user.profile.name)
    return user.profile.name;
  if (user.username)
    return user.username;
  if (user.emails && user.emails[0] && user.emails[0].address)
    return user.emails[0].address;

  return '';
};

Template.loginButtons.helpers({
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

Template._loginButtonsLoggedInDropdown.helpers({
  displayName: displayName,
});

var sendEmail = function (email) {
  loginButtonsSession.infoMessage("Sending email...");
  Accounts.createAndEmailTokenForUser(email, function(err) {
    if (err) {
      loginButtonsSession.errorMessage(err.reason || "Unknown error");
      if (err.error === 409) {
        // 409 is a special case where the user can resolve the problem on their own.
        // Specifically, we're using 409 to mean that the email wasn't sent because a rate limit
        // was hit.
        loginButtonsSession.set("inSignupFlow", true);
      }
    } else {
      loginButtonsSession.set("inSignupFlow", true);
      loginButtonsSession.infoMessage("Email sent");
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
      topbar.closePopup();
    }
  });
};

Template.loginButtonsList.events({
  "click button.login.oneclick": function () {
    var topbar = Template.parentData(3);

    var serviceName = this.name;
    loginButtonsSession.resetMessages();

    // XXX Service providers should be able to specify their
    // `Meteor.loginWithX` method name.
    var loginWithService = Meteor["loginWith" +
                                  (serviceName === 'meteor-developer' ?
                                   'MeteorDeveloperAccount' :
                                   capitalize(serviceName))];

    loginWithService({}, function (err) {
      loginResultCallback(serviceName, err, topbar);
    });
  },

  "submit form": function (event) {
    event.preventDefault();
    var form = event.currentTarget;
    if (loginButtonsSession.get("inSignupFlow")) {
      loginWithToken(form.email.value, form.token.value, Template.parentData(3));
    } else {
      sendEmail(form.email.value);
    }
  }
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

  awaitingToken: function () {
    return loginButtonsSession.get('inSignupFlow');
  },
});
