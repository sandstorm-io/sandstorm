/**
 * @summary Log the user in with a password.
 * @locus Client
 * @param {String} email The user's email.
 * @param {String} password The token received in the email.
 * @param {Function} [callback] Optional callback. Called with no arguments on success, or with a single `Error` argument on failure.
 */
Meteor.loginWithEmailToken = function (email, token, callback) {
  check(email, String);
  check(token, String);

  Accounts.callLoginMethod({
    methodArguments: [
      {
        email: {
          email: email,
          token: token,
        },
      },
    ],
    userCallback: function (error, result) {
      if (error) {
        callback && callback(error);
      } else {
        callback && callback();
      }
    },
  });
};

/**
 * @summary Create a new token for a given email.
 * @locus Anywhere
 * @param {String} email The user's email address.
 * @param {Function} [callback] Client only, optional callback. Called with no arguments on success, or with a single `Error` argument on failure.
 */
Accounts.createAndEmailTokenForUser = function (email, linkingNewIdentity, callback) {
  check(email, String);
  check(linkingNewIdentity, Boolean);

  Meteor.call("createAndEmailTokenForUser", email, linkingNewIdentity, callback);
};

