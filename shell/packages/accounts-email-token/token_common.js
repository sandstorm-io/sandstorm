Accounts._hashToken = function (token) {
  return {
    digest: SHA256(token),
    algorithm: "sha-256"
  };
};

var enabled = false;

Meteor.enableEmailTokenLogin = function () {
  enabled = true;
  if (Meteor.isClient) {
    Accounts.ui.registerService("emailToken", "an Email + Token");
  }
};

Meteor.disableEmailTokenLogin = function () {
  enabled = false;
  if (Meteor.isClient) {
    Accounts.ui.deregisterService("emailToken");
  }
};

Accounts.isEmailTokenLoginEnabled = function () {
  return enabled;
};

Router.route("/_emailToken/:_email/:_token", function () {
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
