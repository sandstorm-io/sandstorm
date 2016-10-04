import crypto from "crypto";

import { send as sendEmail } from "/imports/server/email.js";

const V1_ROUNDS = 4096; // Selected to take ~5msec at creation time (2016) on a developer's laptop.
const V1_KEYSIZE = 32; // 256 bits / 8 bits/byte = 32 bytes
const V1_HASHFUNC = "sha512";
// ^ hash function used with pbkdf2.  Chosen to be different from the function which maps the token
// to the value stored in the database.  Note that the first thing that pbkdf2 does is
// HMAC(HASHFUNC, key, salt), and the first thing that HMAC does is either pad or hash the key to
// make it the appropriate width.  The result is that knowing sha256(key) and the salt is possibly
// sufficient to reconstruct the output of pbkdf2().
const V1_CIPHER = "AES-256-CTR"; // cipher used

const TOKEN_EXPIRATION_MS = 15 * 60 * 1000;

const cleanupExpiredTokens = function () {
  Meteor.users.update({
    "services.email.tokens.createdAt": {
      $lt: new Date(Date.now() - TOKEN_EXPIRATION_MS),
    },
  }, {
    $pull: {
      "services.email.tokens": {
        createdAt: { $lt: new Date(Date.now() - TOKEN_EXPIRATION_MS) },
      },
    },
  }, {
    multi: true,
  });
};

Meteor.startup(cleanupExpiredTokens);
// Tokens can actually last up to 2 * TOKEN_EXPIRATION_MS
SandstormDb.periodicCleanup(TOKEN_EXPIRATION_MS, cleanupExpiredTokens);

const hashToken = (token) => {
  return {
    digest: SHA256(token),
    algorithm: "sha-256",
  };
};

const checkToken = function (tokens, token) {
  // Looks for an object in `tokens` with `algorithm` and `digest` fields matching those in `token`.
  // Returns the matching object, if one is found, or undefined if none match.
  let foundToken = undefined;
  tokens.forEach(function (userToken) {
    if ((userToken.algorithm === token.algorithm) &&
       (userToken.digest === token.digest)) {
      foundToken = userToken;
    }
  });

  return foundToken;
};

const consumeToken = function (user, token) {
  const hashedToken = hashToken(token);
  const foundToken = checkToken(user.services.email.tokens, hashedToken);

  if (foundToken !== undefined) {
    Meteor.users.update({ _id: user._id }, { $pull: { "services.email.tokens": hashedToken } });
  }

  return foundToken;
};

const makeBox = function (token, plaintext) {
  // Encrypt plaintext symmetrically with a key derived from token.  Returns an object with
  // ciphertext and associated data needed to decrypt later.

  // Produce a symmetric key.  Note that the token itself does not have sufficient entropy to
  // be used as a key directly, so we need to use a KDF with a strong random salt.
  // In the fullness of time, it might be nice to move away from using a KDF (which blocks the whole
  // node process) in favor of the token itself having enough entropy to serve as the key itself.
  // This would require lengthening the token, which would make the manual-code-entry workflow
  // worse, so I'm punting on that for now.
  const salt = Random.secret(16);
  const key = crypto.pbkdf2Sync(token, salt, V1_ROUNDS, V1_KEYSIZE, V1_HASHFUNC);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(V1_CIPHER, key, iv);
  let ciphertext = cipher.update(new Buffer(plaintext, "binary"));
  return {
    version: 1,
    salt: salt,
    iv: iv.toString("base64"),
    boxedValue: ciphertext.toString("base64"),
  };
};

const tryUnbox = function (box, secret) {
  if (box) {
    if (box.version === 1) {
      const key = crypto.pbkdf2Sync(secret, box.salt, V1_ROUNDS, V1_KEYSIZE, V1_HASHFUNC);
      const iv = new Buffer(box.iv, "base64");
      const cipher = crypto.createDecipheriv(V1_CIPHER, key, iv);
      const cipherText = new Buffer(box.boxedValue, "base64");
      const plaintext = cipher.update(cipherText);
      return plaintext.toString("binary");
    }
  }

  // If no box was provided, or it was of an unknown version, return no data.
  return;
};

// Handler to login with a token.
Accounts.registerLoginHandler("email", function (options) {
  if (!options.email) {
    return undefined; // don't handle
  }

  if (!Accounts.identityServices.email.isEnabled()) {
    throw new Meteor.Error(403, "Email identity service is disabled.");
  }

  options = options.email;
  check(options, {
    email: String,
    token: String,
  });

  const user = Meteor.users.findOne({
    "services.email.email": options.email,
  }, {
    fields: {
      "services.email": 1,
    },
  });

  if (!user) {
    console.error("User not found:", options.email);
    return {
      error: new Meteor.Error(403, "User not found"),
    };
  }

  if (!user.services.email.tokens) {
    console.error("User has no token set:", options.email);
    return {
      error: new Meteor.Error(403, "User has no token set"),
    };
  }

  const tokenString = options.token.trim();
  const maybeToken = consumeToken(user, tokenString);
  if (!maybeToken) {
    console.error("Token not found:", options.email);
    return {
      error: new Meteor.Error(403, "Invalid authentication code"),
    };
  }

  // Attempt to decrypt the resumePath, if provided.
  const resumePath = tryUnbox(maybeToken.secureBox, tokenString);

  return {
    userId: user._id,
    options: {
      resumePath,
    },
  };
});

const Url = Npm.require("url");

const ROOT_URL = Url.parse(process.env.ROOT_URL);
const HOSTNAME = ROOT_URL.hostname;

const makeTokenUrl = function (email, token, options) {
  if (options.linking) {
    return process.env.ROOT_URL + "/_emailLinkIdentity/" + encodeURIComponent(email) + "/" +
      encodeURIComponent(token) + "/" + Meteor.userId() +
      "?allowLogin=" + options.linking.allowLogin;
  } else {
    return process.env.ROOT_URL + "/_emailLogin/" + encodeURIComponent(email) + "/" +
        encodeURIComponent(token);
  }
};

///
/// EMAIL VERIFICATION
///
const sendTokenEmail = function (db, email, token, options) {
  let subject;
  let text;
  if (!options.linking) {
    subject = "Log in to " + HOSTNAME;
    text = "To confirm this email address on ";
  } else {
    subject = "Confirm this email address on " + HOSTNAME;
    text = "To confirm this email address on ";
  }

  text = text + HOSTNAME + ", click on the following link:\n\n" +
      makeTokenUrl(email, token, options) + "\n\n" +
      "Alternatively, enter the following one-time authentication code into the log-in form:\n\n" +
      token;

  const sendOptions = {
    to:  email,
    from: db.getServerTitle() + " <" + db.getReturnAddress() + ">",
    subject: subject,
    text: text,
  };

  sendEmail(sendOptions);
};

///
/// CREATING USERS
///
// returns the user id
const createAndEmailTokenForUser = function (db, email, options) {
  check(email, String);
  check(options, { resumePath: String, linking: Match.Optional({ allowLogin: Boolean }), });

  const atIndex = email.indexOf("@");
  if (atIndex === -1) {
    throw new Meteor.Error(400, "No @ symbol was found in your email");
  }

  let user = Meteor.users.findOne({ "services.email.email": email },
                                  { fields: { "services.email": 1 } });
  let userId;

  // TODO(someday): make this shorter, and handle requests that try to brute force it.
  // Alternately, require using the link over copy/pasting the code, and crank up the entropy.
  const token = Random.id(12);
  const tokenObj = hashToken(token);
  tokenObj.createdAt = new Date();
  tokenObj.secureBox = makeBox(token, options.resumePath);

  if (user) {
    if (user.services.email.tokens && user.services.email.tokens.length > 2) {
      throw new Meteor.Error(
        "alreadySentEmailToken",
        "It looks like we sent a log in email to this address not long " +
        "ago. Please use the one that was already sent (check your spam folder if you can't find " +
        "it), or wait a while and try again");
    }

    userId = user._id;

    Meteor.users.update({ _id: user._id }, { $push: { "services.email.tokens": tokenObj } });
  } else {
    const options = {};
    user = {
      services: {
        email: {
          tokens: [tokenObj],
          email: email,
        },
      },
    };

    userId = Accounts.insertUserDoc(options, user);
  }

  sendTokenEmail(db, email, token, options);

  return userId;
};

Meteor.methods({
  createAndEmailTokenForUser: function (email, options) {
    // method for create user. Requests come from the client.
    // This method will create a user if it doesn't exist, otherwise it will generate a token.
    // It will always send an email to the user

    check(email, String);
    check(options, { resumePath: String, linking: Match.Optional({ allowLogin: Boolean }), });

    if (!Accounts.identityServices.email.isEnabled()) {
      throw new Meteor.Error(403, "Email identity service is disabled.");
    }
    // Create user. result contains id and token.
    const user = createAndEmailTokenForUser(this.connection.sandstormDb, email, options);
  },

  linkEmailIdentityToAccount: function (email, token, allowLogin) {
    // Links the email identity with address `email` and login token `token` to the current account.
    check(email, String);
    check(token, String);
    check(allowLogin, Boolean);
    const account = Meteor.user();
    if (!account || !account.loginIdentities) {
      throw new Meteor.Error(403, "Must be logged in to an account to link an email identity.");
    }

    const identity = Meteor.users.findOne({ "services.email.email": email },
                                          { fields: { "services.email": 1 } });
    if (!identity) {
      throw new Meteor.Error(403, "Invalid authentication code.");
    }

    const maybeToken = consumeToken(identity, token.trim());
    if (!maybeToken) {
      throw new Meteor.Error(403, "Invalid authentication code.");
    }

    Accounts.linkIdentityToAccount(this.connection.sandstormDb, this.connection.sandstormBackend,
                                   identity._id, account._id, allowLogin);

    // Return the resume path, if we have one.
    const resumePath = tryUnbox(maybeToken.secureBox, token);
    return resumePath;
  },
});
