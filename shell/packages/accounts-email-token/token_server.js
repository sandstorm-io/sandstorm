var TOKEN_EXPIRATION_MS = 15 * 60 * 1000;

var cleanupExpiredTokens = function() {
  Meteor.users.update(
      {"services.email.tokens.createdAt": {$lt: new Date(Date.now() - TOKEN_EXPIRATION_MS)}},
      {$pull: {
        "services.email.tokens": {
          createdAt: {$lt: new Date(Date.now() - TOKEN_EXPIRATION_MS)}}}},
    { multi: true });
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

function consumeToken (user, token) {
  var hashedToken = Accounts.emailToken._hashToken(token);
  var found = checkToken(user.services.email.tokens, hashedToken);

  if (found) {
    Meteor.users.update({_id: user._id}, {$pull: {"services.email.tokens": hashedToken}});
  }

  return found;
}

// Handler to login with a token.
Accounts.registerLoginHandler("email", function (options) {
  if (!options.email)
    return undefined; // don't handle

  options = options.email;
  check(options, {
    email: String,
    token: String
  });

  var user = Meteor.users.findOne({"services.email.email": options.email},
                                  {fields: {"services.email": 1}});

  if (!user) {
    console.error("User not found:", options.email);
    return {
      error: new Meteor.Error(403, "User not found")
    };
  }

  if (!user.services.email.tokens) {
    console.error("User has no token set:", options.email);
    return {
      error: new Meteor.Error(403, "User has no token set")
    };
  }

  if (!consumeToken(user, options.token.trim())) {
    console.error("Token not found:", options.email);
    return {
      error: new Meteor.Error(403, "Invalid authentication code")
    };
  }

  return {
    userId: user._id
  };
});

var Url = Npm.require("url");

var ROOT_URL = Url.parse(process.env.ROOT_URL);
var HOSTNAME = ROOT_URL.hostname;

var makeTokenUrl = function (email, token, linkingIdentity) {
  if (linkingIdentity) {
    return process.env.ROOT_URL + "/_emailLinkIdentity/" + encodeURIComponent(email) + "/" +
        encodeURIComponent(token) + "/" + Meteor.userId();
  } else {
    return process.env.ROOT_URL + "/_emailLogin/" + encodeURIComponent(email) + "/" +
        encodeURIComponent(token);
  }
};

///
/// EMAIL VERIFICATION
///
var sendTokenEmail = function (email, token, linkingIdentity) {
  var subject;
  var text;
  if (!linkingIdentity) {
    subject = "Log in to " + HOSTNAME;
    text = "To confirm this email address on ";
  } else {
    subject = "Confirm this email address on " + HOSTNAME;
    text = "To confirm this email address on ";
  }
  text = text + HOSTNAME + ", click on the following link:\n\n" +
      makeTokenUrl(email, token, linkingIdentity) + "\n\n" +
      "Alternatively, enter the following one-time authentication code into the log-in form:\n\n" +
      token;

  var options = {
    to:  email,
    from: HOSTNAME + " <no-reply@" + HOSTNAME + ">",
    subject: subject,
    text: text,
  };

  global[EMAIL_PACKAGE].send(options);
};

///
/// CREATING USERS
///
// returns the user id
var createAndEmailTokenForUser = function (email, linkingIdentity) {
  check(email, String);
  check(linkingIdentity, Boolean);
  var atIndex = email.indexOf("@");
  if (atIndex === -1) {
    throw new Meteor.Error(400, "No @ symbol was found in your email");
  }

  var user = Meteor.users.findOne({"services.email.email": email},
                                  {fields: {"services.email": 1}});
  var userId;

  // TODO(someday): make this shorter, and handle requests that try to brute force it.
  var token = Random.id(12);
  var tokenObj = Accounts.emailToken._hashToken(token);
  tokenObj.createdAt = new Date();

  if (user) {
    if (user.services.email.tokens && user.services.email.tokens.length > 2) {
      throw new Meteor.Error(409, "It looks like we sent a log in email to this address not long " +
        "ago. Please use the one that was already sent (check your spam folder if you can't find " +
        "it), or wait a while and try again");
    }
    userId = user._id;

    Meteor.users.update({_id: user._id}, {$push: {"services.email.tokens": tokenObj}});
  } else {
    var options = {};
    user = {services: {email: {
      tokens: [tokenObj],
      email: email
    }}};

    userId = Accounts.insertUserDoc(options, user);
  }

  sendTokenEmail(email, token, linkingIdentity);

  return userId;
};

Meteor.methods({
  createAndEmailTokenForUser: function (email, linkingIdentity) {
    // method for create user. Requests come from the client.
    // This method will create a user if it doesn't exist, otherwise it will generate a token.
    // It will always send an email to the user

    check(email, String);
    check(linkingIdentity, Boolean);

    if (!Accounts.identityServices.email.isEnabled()) {
      throw new Meteor.Error(403, "Email identity service is disabled.");
    }
    // Create user. result contains id and token.
    var user = createAndEmailTokenForUser(email, linkingIdentity);
  },

  linkEmailIdentityToAccount: function (email, token) {
    // Links the email identity with address `email` and login token `token` to the current account.
    check(email, String);
    check(token, String);
    var account = Meteor.user();
    if (!account || !account.loginIdentities) {
      throw new Meteor.Error(403, "Must be logged in to an account to link an email identity.");
    }
    var identity = Meteor.users.findOne({"services.email.email": email},
                                        {fields: {"services.email": 1}});
    if (!identity) {
      throw new Meteor.Error(403, "Invalid authentication code.");
    }
    if (!consumeToken(identity, token)) {
      throw new Meteor.Error(403, "Invalid authentication code.");
    }
    Accounts.linkIdentityToAccount(this.connection.sandstormDb, this.connection.sandstormBackend,
                                   identity._id, account._id);
  }
});

Meteor.users._ensureIndex("services.email.email", {unique: 1, sparse: 1});
