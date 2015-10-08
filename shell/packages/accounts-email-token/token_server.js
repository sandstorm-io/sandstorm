var TOKEN_EXPIRATION_MS = 15 * 60 * 1000;

var cleanupExpiredTokens = function() {
  while (0 < Meteor.users.update(
      {"identities.service.emailToken.tokens.createdAt": {$lt: new Date(Date.now() - TOKEN_EXPIRATION_MS)}},
      {$pull: {
        "identities.$.service.emailToken.tokens": {
          createdAt: {$lt: new Date(Date.now() - TOKEN_EXPIRATION_MS)}}}},
    { multi: true }));
};

Meteor.startup(cleanupExpiredTokens);
// Tokens can actually last up to 2 * TOKEN_EXPIRATION_MS
SandstormDb.periodicCleanup(TOKEN_EXPIRATION_MS, cleanupExpiredTokens);

var checkToken = function (tokens, token) {
  var found = false;
  tokens.forEach(function (userToken) {
    if((userToken.algorithm === token.algorithm) &&
       (userToken.digest === token.digest)) {
      found = true;
    }
  });

  return found;
};

// The name of the email package to use. It refers to a variable named in the global scope.
var EMAIL_PACKAGE= "Email";

Accounts.emailToken.setEmailPackage = function (packageName) {
  EMAIL_PACKAGE = packageName;
};

var Crypto = Npm.require("crypto");

// Handler to login with a token.
Accounts.registerLoginHandler("emailToken", function (options) {
  if (!options.emailToken)
    return undefined; // don't handle

  options = options.emailToken;
  check(options, {
    email: String,
    token: String
  });

  var identityId = Crypto.createHash("sha256")
      .update("emailToken" + ":" + options.email).digest("hex");
  var user = Meteor.users.findOne({"identities.id": identityId},
                                  {fields: {"identities.$": 1}});

  if (!user) {
    console.error("User not found:", options.email);
    return {
      error: new Meteor.Error(403, "User not found")
    };
  }

  var identity = user.identities[0];

  if (!user.identities[0].service.emailToken.tokens) {
    console.error("User has no token set:", options.email);
    return {
      error: new Meteor.Error(403, "User has no token set")
    };
  }

  var token = Accounts.emailToken._hashToken(options.token.trim());
  var found = checkToken(user.identities[0].service.emailToken.tokens, token);

  if (!found) {
    console.error("Token not found:", user.identities[0]);
    return {
      error: new Meteor.Error(403, "Invalid authentication code")
    };
  }

  Meteor.users.update({"identities.id": identityId},
                      {$pull: {"identities.$.service.emailToken.tokens": token}});
  return {
    userId: user._id
  };
});

var Url = Npm.require("url");

var ROOT_URL = Url.parse(process.env.ROOT_URL);
var HOSTNAME = ROOT_URL.hostname;

var makeTokenUrl = function (email, token) {
  return process.env.ROOT_URL + "/_emailToken/" + encodeURIComponent(email) + "/" + encodeURIComponent(token);
};

///
/// EMAIL VERIFICATION
///
var sendTokenEmail = function (email, token) {
  var options = {
    to:  email,
    from: HOSTNAME + " <no-reply@" + HOSTNAME + ">",
    subject: "Log in to " + HOSTNAME,
    text: "To log in to " + HOSTNAME + ", click on the following link:\n\n" +
          makeTokenUrl(email, token) + "\n\n" +
          "Alternatively, enter the following one-time authentication code into the log-in form:\n\n" +
          token + "\n\n" +
          "You are receiving this because someone (hopefully you) requested to log in to " +
          HOSTNAME + " with your email address. If you did not request to log into " + HOSTNAME +
          ", you may ignore this message.\n\n" +
          "This information will expire in 15 minutes.\n"
  };

  global[EMAIL_PACKAGE].send(options);
};

///
/// CREATING USERS
///
// returns the user id
var createAndEmailTokenForUser = function (email) {
  check(email, String);
  var atIndex = email.indexOf("@");
  if (atIndex === -1) {
    throw new Meteor.Error(400, "No @ symbol was found in your email");
  }

  var identityId = Crypto.createHash("sha256")
      .update("emailToken" + ":" + email).digest("hex");
  var user = Meteor.users.findOne({"identities.id": identityId},
                                  {fields: {"identities.$": 1}});
  var userId;

  // TODO(someday): make this shorter, and handle requests that try to brute force it.
  var token = Random.id(12);
  var tokenObj = Accounts.emailToken._hashToken(token);
  tokenObj.createdAt = new Date();

  if (user) {
    var identity = user.identities[0];
    if (identity.service.emailToken.tokens && identity.service.emailToken.tokens.length > 2) {
      throw new Meteor.Error(409, "It looks like we sent a log in email to this address not long " +
        "ago. Please use the one that was already sent (check your spam folder if you can't find " +
        "it), or wait a while and try again");
    }
    userId = user._id;

    Meteor.users.update({"identities.id": identityId},
                        {$push: {"identities.$.service.emailToken.tokens": tokenObj}});
  } else {
    var options = {
      service: {emailToken: {email: email, tokens: [tokenObj]}},
    };

    userId = Accounts.insertUserDoc(options, {});
  }

  sendTokenEmail(email, token);

  return userId;
};

// method for create user. Requests come from the client.
// This method will create a user if it doesn't exist, otherwise it will generate a token.
// It will always send an email to the user
Meteor.methods({createAndEmailTokenForUser: function (email) {
  check(email, String);

  if (!Accounts.emailToken.isEnabled()) {
    throw new Meteor.Error(403, "Email Token service is disabled.");
  }
  // Create user. result contains id and token.
  var user = createAndEmailTokenForUser(email);
}});
