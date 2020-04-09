import { Meteor } from "meteor/meteor";
import { Accounts } from "meteor/accounts-base";
import { Match, check } from "meteor/check";

/**
 * @summary Log the user in with a one-time-use token.
 * @locus Client
 * @param {String} email The user's email.
 * @param {String} token The token received in the email.
 * @param {Function} [callback] Optional callback. Called with arguments (undefined, resumePath) on success, or with a single `Error` argument on failure.
 */
const loginWithEmailToken = function (email, token, callback) {
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
 * @locus Client
 * @param {String} email The user's email address.
 * @param {Boolean} linkingNewCredential True if this is an attempt to link a new identity; false otherwise.
 * @param {String} resumePath If the user logs in by opening the link from the email, redirect them to this path on successful login.
 * @param {Function} [callback] Client only, optional callback. Called with no arguments on success, or with a single `Error` argument on failure.
 */
const createAndEmailTokenForUser = function (email, options, callback) {
  check(email, String);
  check(options, { resumePath: String, linking: Match.Optional({ allowLogin: Boolean }), });

  options.rootUrl = window.location.protocol + "//" + window.location.host;

  Meteor.call("createAndEmailTokenForUser", email, options, callback);
};

export { loginWithEmailToken, createAndEmailTokenForUser };
