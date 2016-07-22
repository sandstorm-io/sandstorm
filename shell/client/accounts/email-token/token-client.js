/**
 * @summary Log the user in with a one-time-use token.
 * @locus Client
 * @param {String} email The user's email.
 * @param {String} token The token received in the email.
 * @param {Function} [callback] Optional callback. Called with arguments (undefined, resumePath) on success, or with a single `Error` argument on failure.
 */
Meteor.loginWithEmailToken = function (email, token, callback) {
  check(email, String);
  check(token, String);

  // Meteor's `Accounts.callLoginMethod` doesn't provide the login result to the `userCallback` you
  // specify on successful login, so we ordinarily wouldn't be able to redirect you back to the path
  // you initiated email login from.
  //
  // However, Meteor *does* provide the login result to the `validateResult` method.  So, we stash
  // the path we want to pass back to the caller here when `validateResult` is called, and then we
  // can pass it on to the callback in `userCallback` instead.
  let resumePath = undefined;

  Accounts.callLoginMethod({
    methodArguments: [
      {
        email: {
          email: email,
          token: token,
        },
      },
    ],

    validateResult: function (result) {
      resumePath = result.resumePath;
    },

    userCallback: function (error) {
      if (error) {
        callback && callback(error);
      } else {
        callback && callback(undefined, resumePath);
      }
    },
  });
};

/**
 * @summary Create a new token for a given email.
 * @locus Anywhere
 * @param {String} email The user's email address.
 * @param {Boolean} linkingNewIdentity True if this is an attempt to link a new identity; false otherwise.
 * @param {String} resumePath If the user logs in by opening the link from the email, redirect them to this path on successful login.
 * @param {Function} [callback] Client only, optional callback. Called with no arguments on success, or with a single `Error` argument on failure.
 */
Accounts.createAndEmailTokenForUser = function (email, linkingNewIdentity, resumePath, callback) {
  check(email, String);
  check(linkingNewIdentity, Boolean);
  check(resumePath, String);

  Meteor.call("createAndEmailTokenForUser", email, linkingNewIdentity, resumePath, callback);
};

// Email token login routes.
Router.route("/_emailLogin/:_email/:_token", function () {
  this.render("Loading");
  Meteor.loginWithEmailToken(this.params._email, this.params._token, (err, resumePath) => {
    if (err) {
      this.render("_emailTokenError", {
        data: function () {
          return {
            error: err,
          };
        },
      });
    } else {
      const target = resumePath || "/";
      Router.go(target);
    }
  });
}, {
  // Specify a name in an attempt to fix bug reported here:
  //   https://twitter.com/fink_/status/709715523513270272
  //
  // The user reported an exception trace where IronRouter complained that the route "i" had been
  // registered twice, tracing back to routes in this file. Where did "i" come from? The problem
  // does not seem to be reproducible.
  //
  // It looks like IronRouter may decide to name the route based on the function name:
  //   https://github.com/iron-meteor/iron-middleware-stack/blob/master/lib/handler.js#L49
  //
  // Our function has no name, but perhaps minification can mess with that? An explicit name
  // in the options will take precedence, so do that.
  name: "_emailLogin",
});

Router.route("/_emailLinkIdentity/:_email/:_token/:_accountId", function () {
  this.render("Loading");
  if (this.state.get("error")) {
    this.render("_emailLinkIdentityError", { data: { error: this.state.get("error") } });
  } else {
    if (Meteor.userId() === this.params._accountId) {
      Meteor.call("linkEmailIdentityToAccount",
                  this.params._email, this.params._token, (err, resumePath) => {
                    if (err) {
                      this.state.set("error", err.toString());
                    } else {
                      const target = resumePath || "/account";
                      Router.go(target);
                    }
                  });
    } else {
      this.render("_emailLinkIdentityError");
    }
  }
}, {
  // See above.
  name: "_emailLinkIdentity",
});
