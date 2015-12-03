Accounts.emailToken = {};

Accounts.emailToken._hashToken = function (token) {
  return {
    digest: SHA256(token),
    algorithm: "sha-256"
  };
};

var enabled = false;

if (Meteor.isClient) {
  var enabledReactive = new ReactiveVar(false);
}

Accounts.emailToken.enable = function (accountsUi) {
  enabled = true;
  if (Meteor.isClient) {
    accountsUi.registerService("emailToken", "an Email + Token");
    enabledReactive.set(true);
  }
};

Accounts.emailToken.disable = function (accountsUi) {
  enabled = false;
  if (Meteor.isClient) {
    accountsUi.deregisterService("emailToken");
    enabledReactive.set(false);
  }
};

Accounts.emailToken.isEnabled = function () {
  if (Meteor.isClient) {
    return enabledReactive.get();
  } else {
    return enabled;
  }
};

Router.route("/_emailLogin/:_email/:_token", function () {
  this.render("Loading");
  var that = this;
  Meteor.loginWithEmailToken(this.params._email, this.params._token, function (err) {
    if (err) {
      that.render("_emailTokenError", {
        data: function () {
          return {
            error: err
          };
        }
      });
    } else {
      Router.go("/");
    }
  });
});

Router.route("/_emailLinkIdentity/:_email/:_token/:_accountId", function () {
  this.render("Loading");
  if (this.state.get("error")) {
    this.render("_emailLinkIdentityError", {data: {error: this.state.get("error")}});
  } else {
    var self = this;
    if (Meteor.userId() === this.params._accountId) {
      Meteor.call("linkEmailIdentityToAccount",
                  this.params._email, this.params._token, function (err, result) {
        if (err) {
          self.state.set("error", err.toString());
        } else {
          Router.go("/account");
        }
      });
    } else {
      this.render("_emailLinkIdentityError");
    }
  }
});
