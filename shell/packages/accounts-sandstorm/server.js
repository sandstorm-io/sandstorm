// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// Licensed under the MIT License. See LICENSE.

import { check } from "meteor/check";
import { Meteor } from "meteor/meteor";
import { WebApp } from "meteor/webapp";
import { LoginRendezvous } from "./rendezvous";

const LOGIN_TIMEOUT_MS = 10000;
const MAX_PENDING_LOGINS = 1024;
const MAX_TOKEN_BYTES = 4096;
const pendingLogins = new LoginRendezvous({
  maxPending: MAX_PENDING_LOGINS,
  timeoutMs: LOGIN_TIMEOUT_MS,
  makeError: (code, message) => new Meteor.Error(code, message),
});

if (process.env.SANDSTORM) {
  globalThis.__meteor_runtime_config__ ||= {};
  globalThis.__meteor_runtime_config__.SANDSTORM = true;
}

const accountsPackage = globalThis.Package?.["accounts-base"];
const Accounts = accountsPackage?.Accounts;

function decodeHeader(value, name) {
  if (typeof value !== "string") {
    if (name === "x-sandstorm-username") return "";
    return null;
  }

  try {
    return decodeURIComponent(value);
  } catch {
    throw new Meteor.Error(400, `Invalid encoding in ${name}.`);
  }
}

async function readToken(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > MAX_TOKEN_BYTES) {
      throw new Meteor.Error(413, "Sandstorm login token is too large.");
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf8");
}

async function handleLoginPost(request, response) {
  try {
    if (request.method !== "POST") {
      throw new Meteor.Error(405, "Sandstorm login endpoint requires POST.");
    }

    const contentType = request.headers["content-type"]?.split(";", 1)[0].trim();
    if (contentType !== "application/x-sandstorm-login-token") {
      throw new Meteor.Error(415, "Wrong Content-Type for /.sandstorm-login.");
    }

    const token = await readToken(request);
    const resolved = pendingLogins.resolve(token, {
      sandstorm: {
        id: request.headers["x-sandstorm-user-id"] || null,
        name: decodeHeader(request.headers["x-sandstorm-username"], "x-sandstorm-username"),
        permissions: (request.headers["x-sandstorm-permissions"] || "")
            .split(",").filter(Boolean),
        picture: request.headers["x-sandstorm-user-picture"] || null,
        preferredHandle: request.headers["x-sandstorm-preferred-handle"] || null,
        pronouns: request.headers["x-sandstorm-user-pronouns"] || null,
      },
      sessionId: request.headers["x-sandstorm-session-id"] || null,
      tabId: request.headers["x-sandstorm-tab-id"] || null,
    });
    if (!resolved) {
      throw new Meteor.Error(404, "No current login request matches this token.");
    }

    response.writeHead(204);
    response.end();
  } catch (error) {
    const status = error.error >= 400 && error.error < 600 ? error.error : 500;
    response.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
    response.end(error.reason || error.message);
  }
}

if (globalThis.__meteor_runtime_config__.SANDSTORM) {
  if (Accounts) {
    Accounts.validateLoginAttempt((attempt) => {
      if (!attempt.allowed) return false;
      if (attempt.type !== "sandstorm") {
        throw new Meteor.Error(403, "Non-Sandstorm login mechanisms disabled on Sandstorm.");
      }

      return true;
    });

    Accounts.validateNewUser((user) => {
      if (!user.services.sandstorm) {
        throw new Meteor.Error(403, "Non-Sandstorm login mechanisms disabled on Sandstorm.");
      }

      return true;
    });

    Meteor.startup(async () => {
      await Meteor.users.rawCollection().createIndex(
        { "services.sandstorm.id": 1 },
        { unique: true, sparse: true },
      );
    });
  }

  Meteor.onConnection((connection) => {
    connection._sandstormUser = null;
    connection._sandstormSessionId = null;
    connection._sandstormTabId = null;
    const requireLogin = (value) => {
      if (!connection._sandstormUser) {
        throw new Meteor.Error(400, "Client did not complete authentication handshake.");
      }

      return value;
    };

    connection.sandstormUser = () => requireLogin(connection._sandstormUser);
    connection.sandstormSessionId = () => requireLogin(connection._sandstormSessionId);
    connection.sandstormTabId = () => requireLogin(connection._sandstormTabId);
  });

  Meteor.methods({
    async loginWithSandstorm(token) {
      check(token, String);
      if (Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
        throw new Meteor.Error(413, "Sandstorm login token is too large.");
      }

      const info = await pendingLogins.wait(token);
      this.connection._sandstormUser = info.sandstorm;
      this.connection._sandstormSessionId = info.sessionId;
      this.connection._sandstormTabId = info.tabId;

      let userId = info.sandstorm.id;
      if (Accounts) {
        if (info.sandstorm.id) {
          const result = await Accounts.updateOrCreateUserFromExternalService(
            "sandstorm",
            info.sandstorm,
            { profile: { name: info.sandstorm.name } },
          );
          userId = result.userId;
        } else {
          userId = null;
        }
      }

      this.setUserId(userId);
      return { ...info, userId };
    },
  });

  WebApp.rawConnectHandlers.use((request, response, next) => {
    if (new URL(request.url, "http://localhost").pathname !== "/.sandstorm-login") {
      next();
      return;
    }

    void handleLoginPost(request, response);
  });
}
