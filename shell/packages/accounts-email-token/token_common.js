Accounts.emailToken = {};

Accounts.emailToken._hashToken = function (token) {
  return {
    digest: SHA256(token),
    algorithm: "sha-256"
  };
};

var enabled = false;

Accounts.emailToken.enable = function (accountsUi) {
  enabled = true;
  if (Meteor.isClient) {
    accountsUi.registerService("emailToken", "an Email + Token");
  }
};

Accounts.emailToken.disable = function (accountsUi) {
  enabled = false;
  if (Meteor.isClient) {
    accountsUi.deregisterService("emailToken");
  }
};

Accounts.emailToken.isEnabled = function () {
  return enabled;
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
  var self = this;
  if (Meteor.userId() === this.params._accountId) {
    Meteor.call("linkEmailIdentityToAccount",
                this.params._email, this.params._token, function (err, result) {
      if (err) {
        self.render("_emailLinkIdentityError", {data: function () {return {error: err};}});
      } else {
        Router.go("/account");
      }
    });
  } else {
    this.render("_emailLinkIdentityError");
  }
});
