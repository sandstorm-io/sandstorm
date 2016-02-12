Accounts.emailToken = {};

Accounts.emailToken._hashToken = function (token) {
  return {
    digest: SHA256(token),
    algorithm: "sha-256",
  };
};

Router.route("/_emailLogin/:_email/:_token", function () {
  this.render("Loading");
  Meteor.loginWithEmailToken(this.params._email, this.params._token, (err) => {
    if (err) {
      this.render("_emailTokenError", {
        data: function () {
          return {
            error: err,
          };
        },
      });
    } else {
      Router.go("/");
    }
  });
});

Router.route("/_emailLinkIdentity/:_email/:_token/:_accountId", function () {
  this.render("Loading");
  if (this.state.get("error")) {
    this.render("_emailLinkIdentityError", { data: { error: this.state.get("error") } });
  } else {
    if (Meteor.userId() === this.params._accountId) {
      Meteor.call("linkEmailIdentityToAccount",
                  this.params._email, this.params._token, (err, result) => {
                    if (err) {
                      this.state.set("error", err.toString());
                    } else {
                      Router.go("/account");
                    }
                  });
    } else {
      this.render("_emailLinkIdentityError");
    }
  }
});
