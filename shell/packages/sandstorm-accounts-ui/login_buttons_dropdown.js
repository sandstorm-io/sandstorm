// for convenience
var loginButtonsSession = Accounts._loginButtonsSession;

// events shared between loginButtonsLoggedOutDropdown and
// loginButtonsLoggedInDropdown
Template.loginButtons.events({
  'click #login-name-link, click #login-sign-in-link': function () {
    loginButtonsSession.set('dropdownVisible', true);
    Tracker.flush();
    correctDropdownZIndexes();
  },
  'click .login-close-text': function () {
    loginButtonsSession.closeDropdown();
  }
});

Template._loginButtonsLoggedInDropdown.helpers({
  displayName: displayName,

  dropdownVisible: function () {
    return loginButtonsSession.get('dropdownVisible');
  }
});

Template._loginButtonsLoggedInDropdownActions.helpers({
  allowChangingPassword: function () {
    // it would be more correct to check whether the user has a password set,
    // but in order to do that we'd have to send more data down to the client,
    // and it'd be preferable not to send down the entire service.password document.
    //
    // instead we use the heuristic: if the user has a username or email set.
    var user = Meteor.user();
    return user.username || (user.emails && user.emails[0] && user.emails[0].address);
  }
});


//
// loginButtonsLoggedOutDropdown template and related
//

var sendEmail = function (ev) {
  loginButtonsSession.infoMessage("Sending email...");
  var email = document.getElementById("login-email").value;
  loginButtonsSession.set("email", email);
  Accounts.createAndEmailTokenForUser(email, function(err) {
    if (err) {
      loginButtonsSession.errorMessage(err.reason || "Unknown error");
    } else {
      document.getElementById("login-email").value = "";
      loginButtonsSession.set("inSignupFlow", true);
      loginButtonsSession.infoMessage("Email sent");
    }
  });
};

var loginWithToken = function (ev) {
  loginButtonsSession.infoMessage("Logging in...");
  Meteor.loginWithEmailToken(loginButtonsSession.get("email"),
                             document.getElementById("login-token").value,
                             function (err) {
    if (err) {
      loginButtonsSession.errorMessage(err.reason || "Unknown error");
    } else {
      loginButtonsSession.closeDropdown();
      Router.go("/");
    }
  });
};

Template._loginButtonsLoggedOutDropdown.events({
  "click #login-buttons-email": sendEmail,
  "click #login-buttons-token": loginWithToken,

  "keypress #login-email": function (ev) {
    if (event.keyCode === 13) {
      sendEmail(ev);
    }
  },

  "keypress #login-token": function (ev) {
    if (event.keyCode === 13) {
      loginWithToken(ev);
    }
  }
});

Template._loginButtonsLoggedOutDropdown.helpers({
  // additional classes that can be helpful in styling the dropdown
  additionalClasses: function () {
    if (!hasPasswordService()) {
      return false;
    } else {
      if (loginButtonsSession.get('inSignupFlow')) {
        return 'login-form-create-account';
      } else if (loginButtonsSession.get('inForgotPasswordFlow')) {
        return 'login-form-forgot-password';
      } else {
        return 'login-form-sign-in';
      }
    }
  },

  dropdownVisible: function () {
    return loginButtonsSession.get('dropdownVisible');
  },

  hasPasswordService: hasPasswordService
});

// return all login services, with password last
Template._loginButtonsLoggedOutAllServices.helpers({
  services: getLoginServices,

  isPasswordService: function () {
    return this.name === 'emailToken';
  },

  hasOtherServices: function () {
    return getLoginServices().length > 1;
  },

  hasPasswordService: hasPasswordService
});

Template._loginButtonsLoggedOutPasswordService.helpers({
  fields: function () {
    var loginFields = [
      {fieldName: 'email', fieldLabel: 'Email', inputType: 'email',
       visible: function () {
         return true;
       }}
    ];

    var signupFields = [
      {fieldName: 'token', fieldLabel: 'Token', inputType: 'email',
       visible: function () {
         return true;
       }}
    ];

    return loginButtonsSession.get('inSignupFlow') ? signupFields : loginFields;
  },

  inForgotPasswordFlow: function () {
    return loginButtonsSession.get('inForgotPasswordFlow');
  },

  inLoginFlow: function () {
    return !loginButtonsSession.get('inSignupFlow') && !loginButtonsSession.get('inForgotPasswordFlow');
  },

  inSignupFlow: function () {
    return loginButtonsSession.get('inSignupFlow');
  },

  showCreateAccountLink: function () {
    return !Accounts._options.forbidClientAccountCreation;
  },

  showForgotPasswordLink: function () {
    return _.contains(
      ["USERNAME_AND_EMAIL", "USERNAME_AND_OPTIONAL_EMAIL", "EMAIL_ONLY"],
      passwordSignupFields());
  }
});

Template._loginButtonsFormField.helpers({
  inputType: function () {
    return this.inputType || "text";
  }
});

var correctDropdownZIndexes = function () {
  // IE <= 7 has a z-index bug that means we can't just give the
  // dropdown a z-index and expect it to stack above the rest of
  // the page even if nothing else has a z-index.  The nature of
  // the bug is that all positioned elements are considered to
  // have z-index:0 (not auto) and therefore start new stacking
  // contexts, with ties broken by page order.
  //
  // The fix, then is to give z-index:1 to all ancestors
  // of the dropdown having z-index:0.
  for(var n = document.getElementById('login-dropdown-list').parentNode;
      n.nodeName !== 'BODY';
      n = n.parentNode)
    if (n.style.zIndex === 0)
      n.style.zIndex = 1;
};
