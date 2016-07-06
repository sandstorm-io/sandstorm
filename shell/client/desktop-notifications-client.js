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

const showDesktopNotification = (notif) => {
  const data = notif;
  const timestamp = +notif.creationDate;
  const handle = new Notification(notif.title, {
    tag: notif._id, // Merge desktop notifications from other browser tabs.
    body: notif.body,
    icon: notif.iconUrl,
    badge: notif.iconUrl,
    timestamp,
  });

  handle.onclick = () => {
    if (notif.action) {
      // Request that the Sandstorm window receive focus.  This attempts to switch
      // the browser's active tab and window to the Sandstorm window that created
      // the notification.
      window.focus();

      // Now, do something based on what type of notification this was.
      if (notif.action.grain) {
        // For a notification about a grain, open that grain URL and path.
        const grain = notif.action.grain;
        Router.go(`/grain/${grain.grainId}/${grain.path}`);
      }

      handle.close();
    }
  };
};

Template.desktopNotifications.onCreated(function () {
  if (!localStorageWorks) return;
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
    showDesktopNotification(notif);
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
  if (!localStorageWorks) return;
  window.removeEventListener("storage", this.storageEventHandler);

  if (this.dbHandle) {
    this.dbHandle.stop();
  }

  if (this.periodicCleanupTimerHandle) {
    window.clearInterval(this.periodicCleanupTimerHandle);
  }
});
