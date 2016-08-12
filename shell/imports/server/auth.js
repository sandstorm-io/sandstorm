import { Meteor } from "meteor/meteor";
import { Match, check } from "meteor/check";
import Crypto from "crypto";
import Fs from "fs";
import { SANDSTORM_VARDIR } from "/imports/server/constants.js";
// TODO(cleanup): globalDb is still an unbound global, but extracting it is Hard.

const ADMIN_TOKEN_EXPIRATION_TIME = 15 * 60 * 1000;
const SANDSTORM_ADMIN_TOKEN = SANDSTORM_VARDIR + "/adminToken";

function clearAdminToken(token) {
  if (tokenIsSetupSession(token)) {
    const hash = Crypto.createHash("sha256").update(token).digest("base64");
    globalDb.collections.setupSession.remove({
      _id: "current-session",
      hashedSessionId: hash,
    });
  }

  if (tokenIsValid(token)) {
    Fs.unlinkSync(SANDSTORM_ADMIN_TOKEN);
    console.log("Admin token deleted.");
  }
}

function tokenIsValid(token) {
  if (token && Fs.existsSync(SANDSTORM_ADMIN_TOKEN)) {
    const stats = Fs.statSync(SANDSTORM_ADMIN_TOKEN);
    const expireTime = new Date(Date.now() - ADMIN_TOKEN_EXPIRATION_TIME);
    if (stats.mtime < expireTime) {
      return false;
    } else {
      return Fs.readFileSync(SANDSTORM_ADMIN_TOKEN, { encoding: "utf8" }) === token;
    }
  } else {
    return false;
  }
}

function tokenIsSetupSession(token) {
  if (token) {
    const setupSession = globalDb.collections.setupSession.findOne({ _id: "current-session" });
    if (setupSession) {
      const hash = Crypto.createHash("sha256").update(token).digest("base64");
      const now = new Date();
      const sessionLifetime = 24 * 60 * 60 * 1000; // length of setup session validity, in milliseconds: 1 day
      if (setupSession.hashedSessionId === hash && ((now - setupSession.creationDate) < sessionLifetime)) {
        return true;
      }
    }
  }

  return false;
}

function checkAuth(token) {
  check(token, Match.OneOf(undefined, null, String));
  if (!isAdmin() && !tokenIsValid(token) && !tokenIsSetupSession(token)) {
    throw new Meteor.Error(403, "User must be admin or provide a valid token");
  }
}

export { checkAuth, clearAdminToken, tokenIsValid, tokenIsSetupSession };
