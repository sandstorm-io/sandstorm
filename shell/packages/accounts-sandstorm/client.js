// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// Licensed under the MIT License. See LICENSE.

import { Meteor } from "meteor/meteor";
import { Random } from "meteor/random";
import { ReactiveVar } from "meteor/reactive-var";
import { Tracker } from "meteor/tracker";

const runtimeConfig = globalThis.__meteor_runtime_config__;

function addTestHeaders(headers) {
  const stored = globalThis.localStorage?.sandstormTestUserInfo;
  if (!stored) return;

  const info = JSON.parse(stored);
  if (info.id) headers.set("X-Sandstorm-User-Id", info.id);
  if (info.name) headers.set("X-Sandstorm-Username", encodeURIComponent(info.name));
  if (info.picture) headers.set("X-Sandstorm-User-Picture", info.picture);
  if (info.permissions) headers.set("X-Sandstorm-Permissions", info.permissions.join(","));
  if (info.preferredHandle) {
    headers.set("X-Sandstorm-Preferred-Handle", info.preferredHandle);
  }

  if (info.pronouns) headers.set("X-Sandstorm-User-Pronouns", info.pronouns);
}

export function loginWithSandstorm(connection, apiHost, apiToken) {
  if (!connection._sandstormUser) {
    connection._sandstormUser = new ReactiveVar(null);
    connection.sandstormUser = connection._sandstormUser.get.bind(connection._sandstormUser);
  }

  const token = Random.secret();
  let waiting = true;
  let reconnected = false;
  let retryTimer;

  const onResultReceived = (error) => {
    waiting = false;
    if (retryTimer) Meteor.clearTimeout(retryTimer);
    if (!error) {
      connection.onReconnect = () => {
        reconnected = true;
        loginWithSandstorm(connection, apiHost, apiToken);
      };
    }
  };

  const completed = (error, result) => {
    if (reconnected) return;
    if (error) {
      console.error("loginWithSandstorm failed:", error);
      return;
    }

    connection._sandstormUser.set(result.sandstorm);
    connection.setUserId(result.userId);
  };

  connection.apply(
    "loginWithSandstorm",
    [token],
    { wait: true, onResultReceived },
    completed,
  );

  const sendRequest = async () => {
    if (!waiting) return;

    const headers = new Headers({
      "Content-Type": "application/x-sandstorm-login-token",
    });
    addTestHeaders(headers);

    let url = "/.sandstorm-login";
    if (apiHost) {
      url = `${apiHost}${url}`;
      headers.set("Authorization", `Bearer ${apiToken}`);
    }

    try {
      const response = await fetch(url, {
        method: "POST",
        headers,
        body: token,
      });
      if (!response.ok) {
        throw new Error(`/.sandstorm-login returned HTTP ${response.status}`);
      }
    } catch (error) {
      console.error("couldn't get /.sandstorm-login:", error);
      if (waiting) retryTimer = Meteor.setTimeout(sendRequest, 1000);
    }
  };

  let stopImmediately = false;
  let handle;
  handle = Tracker.autorun(() => {
    if (!waiting) {
      if (handle) handle.stop();
      else stopImmediately = true;
    } else if (connection.status().connected) {
      if (handle) handle.stop();
      else stopImmediately = true;
      Meteor.setTimeout(sendRequest, 10);
    }
  });

  if (stopImmediately) handle.stop();
}

const sandstormAccounts = {
  setTestUserInfo(info) {
    globalThis.localStorage.sandstormTestUserInfo = JSON.stringify(info);
    loginWithSandstorm(
      Meteor.connection,
      runtimeConfig.SANDSTORM_API_HOST,
      runtimeConfig.SANDSTORM_API_TOKEN,
    );
  },
};

if (runtimeConfig.SANDSTORM) {
  loginWithSandstorm(
    Meteor.connection,
    runtimeConfig.SANDSTORM_API_HOST,
    runtimeConfig.SANDSTORM_API_TOKEN,
  );

  const accountsPackage = globalThis.Package?.["accounts-base"];
  if (accountsPackage) {
    Tracker.autorun(() => {
      accountsPackage.Accounts._setLoggingIn(!Meteor.connection.sandstormUser());
    });
  }

  Meteor.sandstormUser = () => Meteor.connection.sandstormUser();
}

globalThis.SandstormAccounts = sandstormAccounts;
export { sandstormAccounts as SandstormAccounts };
