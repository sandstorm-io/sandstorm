// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { computeTitleFromTokenOwnerUser } from "/imports/client/model-helpers.js";

// Test if localStorage is usable.
// We can't use Meteor._localStorage for this because we need to be able to enumerate the elements
// in localStorage for periodic cleanup.
let localStorageWorks = false;
const testKey = "localstorage-test-" + Random.id();
try {
  if (window.localStorage) {
    window.localStorage.setItem(testKey, testKey);
    const readBack = window.localStorage.getItem(testKey);
    window.localStorage.removeItem(testKey);
    localStorageWorks = true;
  }
} catch (e) {
  // localStorage doesn't work.  Most of this code will be disabled.
}

const ICON_FETCHING_TIMEOUT_MSEC = 2000;

const tryRenderImageToDataUri = (url) => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const image = new Image();
  image.crossOrigin = "anonymous";
  image.src = url;

  return new Promise((accept, reject) => {
    image.onload = (evt) => {
      canvas.width = image.width;
      canvas.height = image.height;
      context.clearRect(0, 0, image.width, image.height);
      context.drawImage(image, 0, 0);
      accept(canvas.toDataURL());
    };

    image.onerror = (evt) => {
      // Silently squash errors into empty URIs.
      accept("");
    };
  });
};

const tryRenderImageWithTimeout = (url, timeoutMsec) => {
  const p1 = tryRenderImageToDataUri(url);
  const p2 = new Promise((resolve, reject) => {
    setTimeout(resolve, timeoutMsec, "");
  });

  return Promise.race([p1, p2]);
};

const showActivityDesktopNotification = (notif) => {
  // Unpack.
  const timestamp = +notif.creationDate;
  const { user, grainId, path, body, actionText } = notif.appActivity;

  // Look up app icon and grain title for grain
  let appIcon = "";
  let grainTitle = "(unknown title)";
  const staticPrefix = window.location.protocol + "//" + globalDb.makeWildcardHost("static");
  const grain = globalDb.getGrain(grainId);
  if (grain) {
    // We own this grain.  We can look up the app icon directly.
    const pkg = globalDb.collections.devPackages.findOne({ appId: grain.appId }) ||
                globalDb.collections.packages.findOne({ _id: grain.packageId });
    if (pkg) {
      appIcon = Identicon.iconSrcForPackage(pkg, "notification", staticPrefix);
    }

    // We are the canonical title of this grain.
    grainTitle = grain.title;
  } else {
    // Not our grain.  Our account must have an ApiToken for this grain.
    const apiToken = globalDb.collections.apiTokens.findOne({
      grainId,
      "owner.user.accountId": Meteor.userId(),
    }, {
      sort: { created: 1 },
    });

    if (apiToken) {
      const tokenOwnerUser = apiToken.owner.user;
      const meta = tokenOwnerUser.denormalizedGrainMetadata;
      if (meta && meta.icon && meta.icon.assetId) {
        appIcon = staticPrefix + "/" + meta.icon.assetId;
      } else {
        appIcon = Identicon.identiconForApp((meta && meta.appId) || "00000000000000000000000000000000");
      }

      const titleObj = computeTitleFromTokenOwnerUser(tokenOwnerUser);
      grainTitle = titleObj.title;
    }
  }

  // TODO(i18n): localize
  const titlePrefix =
      !user ? "" :
      user.anonymous ? "Anonymous user on " :
      `${user.name} on `;

  const title = `${titlePrefix}${grainTitle}: ${actionText.defaultText}`;

  // Pick icons
  const userAvatar = user && (user.anonymous ? "/incognito.svg" : user.avatarUrl);
  const mainIconUrl = userAvatar || appIcon;
  const badgeIconUrl = (userAvatar && appIcon) || "";

  // We wait up to 2 seconds to load the icons.  If they're not done in time, we send the
  // notification with whatever we have.
  const mainIconPromise = tryRenderImageWithTimeout(mainIconUrl, ICON_FETCHING_TIMEOUT_MSEC);
  const badgeIconPromise = tryRenderImageWithTimeout(badgeIconUrl, ICON_FETCHING_TIMEOUT_MSEC);

  const bodyText = body.defaultText;

  Promise.all([mainIconPromise, badgeIconPromise]).then((dataUris) => {
    const iconData = dataUris[0];
    const badgeData = dataUris[1];
    const notificationOptions = {
      tag: notif._id, // Merge desktop notifications from other browser tabs.
      body: bodyText,
      icon: iconData,
      badge: badgeData,
      timestamp,
    };

    const showNotification = () => {
      const handle = new Notification(title, notificationOptions);

      handle.onclick = () => {
        // Request that the Sandstorm window receive focus.  This attempts to switch
        // the browser's active tab and window to the Sandstorm window that created
        // the notification.
        window.focus();

        // For a notification about a grain, open that grain URL and path.
        Router.go(`/grain/${grainId}/${path || ""}`);

        // Close this notification.
        handle.close();

        // Dismiss the associated notification, ignoring errors and without blocking.
        Meteor.call("dismissNotification", notif.notificationId, (err) => {});
      };
    };

    const currentPerm = Notification.permission;
    if (currentPerm === "granted") {
      showNotification();
    } else if (currentPerm === "default") {
      Notification.requestPermission().then((perm) => {
        if (perm === "granted") {
          showNotification();
        }
      });
    } else {
      // User explicitly denied desktop notifications.  Do nothing.
    }
  });
};

Template.desktopNotifications.onCreated(function () {
  // Don't bother with any of this if we don't have both Notification support and localStorage.
  if (!localStorageWorks) return;
  if (!window.Notification) return;
  this.enabled = true;

  // There's some tricky logic here to try to make sure notifications are preferentially handled by
  // a tab that already has the associated grain open, rather than just by the first or last tab to
  // learn about the notification.  Otherwise your odds of getting the notification in the right tab
  // are 1 in N, and then you'll open the grain in another window, which probably isn't what the
  // user wanted.
  //
  // The tabs coordinate which tab will handle notifications via localStorage and listening for
  // storage events.  If a tab already has a grain open, then it will claim a newly discovered
  // notification immediately.  If a notification goes unclaimed for 2 seconds, then any tab (TODO:
  // prefer the most recently focused/visible tab? requires more activity monitoring) may claim it
  // and display it to the user.
  //
  // Notifications are kept in localStorage slightly longer than they are preserved on the server,
  // to ensure that we avoid delivering duplicate notifications if one tab's connection is laggy or
  // otherwise gets delayed messages.

  // A random ID to identify this tab.  Not strictly needed for the current coordination algorithm,
  // but useful for debugging.
  this.tabId = Random.id();
  //console.log(`desktop notifications tab id is ${this.tabId}`);

  this.periodicCleanupTimerHandle = window.setInterval(() => {
    // Do a periodic cleanup: call removeItem() any localStorage items with key prefix
    // "notification-" and value with timestamp older than 180 seconds (longer than the sum of the
    // serverside timeout and serverside key lifetime).
    //
    // Collect items to remove.  Iterating over localStorage
    const toRemove = [];
    const expireTimestamp = Date.now() - 180000;
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key.lastIndexOf("notification-", 0) === 0) {
        const valueString = localStorage.getItem(key);
        const value = JSON.parse(valueString);
        if (value.lastWrite.timestamp < expireTimestamp) {
          toRemove.push(key);
        }
      }
    }

    // Actually remove items.
    for (let i = 0; i < toRemove.length; i++) {
      localStorage.removeItem(toRemove[i]);
    }
  }, 30000);

  this.waiters = {}; // Map from notification id to setTimeout handle

  this.maybeClaimNotification = (notif, storageValue) => {
    if (storageValue && storageValue.state === "claimed") {
      // Another tab has already claimed this notification.  Bail out.
      return;
    }

    // Set storage state for this notification to "claimed".
    const storageKey = `notification-${notif._id}`;
    const newStorageValue = {
      rawData: notif,
      state: "claimed",
      lastWrite: {
        timestamp: Date.now(),
        tabId: this.tabId,
      },
    };

    localStorage.setItem(storageKey, JSON.stringify(newStorageValue));
    // Create the actual desktop notification.
    if (notif.appActivity) {
      showActivityDesktopNotification(notif);
    }
  };

  this.shouldHandleNotificationImmediately = (notif) => {
    if (notif.action && notif.action.grain) {
      // Defer handling of grain notifications.
      const grainId = notif.action.grain.grainId;
      return !!(grainId ? globalGrains.getById(grainId) : undefined);
    } else {
      // Eagerly handle any other type of notification.
      return true;
    }
  };

  this.onWaitingPeriodExpired = (notif) => {
    // 2-second waiting period probably expired.  Try claiming the notification.
    const storageKey = `notification-${notif._id}`;
    const storageValueString = localStorage.getItem(storageKey);
    const storageValue = storageValueString ? JSON.parse(storageValueString) : undefined;
    // TODO(now): check that the waiting period has actually expired since the lastWrite timestamp;
    // if so, claim the request; if not, schedule again for later.
    this.maybeClaimNotification(notif, storageValue);
    delete this.waiters[notif._id];
  };

  this.handleDiscoveredNotification = (notif, storageValue) => {
    if (this.shouldHandleNotificationImmediately(notif)) {
      this.maybeClaimNotification(notif, storageValue);
    } else {
      if (!storageValue) {
        // write it to the database with state: "discovered"
        const storageKey = `notification-${notif._id}`;
        const newStorageValue = {
          rawData: notif,
          state: "discovered",
          lastWrite: {
            timestamp: Date.now(),
            tabId: this.tabId,
          },
        };
        // Do one last check to narrow the window for a race condition
        if (localStorage.getItem(storageKey) === null) {
          localStorage.setItem(storageKey, JSON.stringify(newStorageValue));
        }
      }

      if (this.waiters[notif._id] === undefined) {
        // Schedule claiming the request later.  Try not to wake up tabs at the same time.
        const delay = 2000 + Math.random() * 100;
        this.waiters[notif._id] = window.setTimeout(this.onWaitingPeriodExpired.bind(this, notif), delay);
      }
    }
  };

  this.storageEventHandler = (evt) => {
    if (evt.key && evt.key.lastIndexOf("notification-", 0) === 0 && evt.newValue) {
      // This is a write to a notification object.
      const notificationId = evt.key.slice("notification-".length);
      const storageValue = JSON.parse(evt.newValue);

      if (evt.oldValue === null) {
        if (storageValue && storageValue.state === "discovered") {
          this.handleDiscoveredNotification(storageValue.rawData, storageValue);
        }
      } else {
        const oldStorageValue = JSON.parse(evt.oldValue);
        const lastWrite = oldStorageValue && oldStorageValue.lastWrite;
        if (lastWrite && lastWrite.tabId === this.tabId && oldStorageValue.state === "claimed" &&
            storageValue.state !== "claimed") {
          // Someone else clobbered our write with one that should not dominate ours.
          // Reapply our claim so no other tabs will attempt to claim this notification.
          localStorage.setItem(evt.key, evt.oldValue);
          console.log("storage: observed dangerous interleaved writes");
          console.log(evt);
        }
      }
    }
  };

  window.addEventListener("storage", this.storageEventHandler);

  this.dbHandle = globalDb.collections.desktopNotifications.find().observe({
    added: (notif) => {
      // Look this notification up by ID in localStorage.
      const storageKey = `notification-${notif._id}`;
      const storageValueString = localStorage.getItem(storageKey);
      const storageValue = storageValueString ? JSON.parse(storageValueString) : undefined;

      this.handleDiscoveredNotification(notif, storageValue);
    },
  });

  this.subscribe("desktopNotifications");
});

Template.desktopNotifications.onDestroyed(function () {
  if (!this.enabled) return;
  window.removeEventListener("storage", this.storageEventHandler);

  if (this.dbHandle) {
    this.dbHandle.stop();
  }

  if (this.periodicCleanupTimerHandle) {
    window.clearInterval(this.periodicCleanupTimerHandle);
  }
});
