// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

// This file implements the common shell components such as the top bar.
// It also covers the root page.

const getNamesFromIdentityIds = function (identityIds) {
  check(identityIds, [String]);
  if (identityIds.length === 0) {
    return [];
  }

  const identities = Meteor.users.find({
    _id: { $in: identityIds },
  });
  return identities.map(function (identity) {
    return { name: identity.profile.name };
  });
};

browseHome = function () {
  Router.go("root");
};

getOrigin = function () {
  return document.location.protocol + "//" + document.location.host;
};

if (Meteor.isClient) {
  // Subscribe to basic grain information first and foremost, since
  // without it we might e.g. redirect to the wrong place on login.
  globalSubs = [
    Meteor.subscribe("grainsMenu"),
    Meteor.subscribe("userPackages"),
    Meteor.subscribe("devPackages"),
    Meteor.subscribe("credentials"),
    Meteor.subscribe("accountIdentities"),
  ];

  Tracker.autorun(function () {
    const me = Meteor.user();
    if (me) {
      if (me.profile) {
        Meteor.subscribe("identityProfile", me._id);
      }

      if (me.loginIdentities) {
        me.loginIdentities.forEach(function (identity) {
          Meteor.subscribe("identityProfile", identity.id);
        });
      }

      if (me.nonloginIdentities) {
        me.nonloginIdentities.forEach(function (identity) {
          Meteor.subscribe("identityProfile", identity.id);
        });
      }
    }
  });
}

if (Meteor.isServer) {
  // Set up browser policy.
  //
  // Note that by default (when the browser-policy package is added), Content-Security-Policy will
  // already be set to same-origin-only for everything except XHR and WebSocket. Eval is disabled,
  // but inline script are enabled.
  //
  // TODO(security): Consider disallowing inline scripts. Currently this forces Meteor to do an
  //   extra round trip on startup to fetch server settings. That seems like something that could
  //   be fixed in Meteor (e.g. embed the settings as JSON text rather than script). Startup time
  //   is incredibly important, and Meteor's templating system (which we use to render all our
  //   HTML) already does a good job of protecting us from script injection, so right now I think
  //   we should favor avoiding the round trip.
  //
  // TODO(someday): Detect when an app tries to navigate off-site using CSP's violation reporting
  //   feature. Ask the user whether they want to open the link in a new tab. This is an annoying
  //   prompt, but if we just open the tab directly then apps can trivially leak by opening tabs
  //   with encoded URLs to an evil server. Although, this attack would be very detectable to the
  //   user, so maybe it's not a big deal...

  BrowserPolicy.framing.disallow();  // Disallow framing of the UI.
  BrowserPolicy.content.allowFrameOrigin(getWildcardOrigin());

  // Allow anything to be loaded from the static asset host.
  const Url = Npm.require("url");
  const staticAssetHost = Url.parse(process.env.ROOT_URL).protocol + "//" +
                          globalDb.makeWildcardHost("static");
  BrowserPolicy.content.allowImageOrigin(staticAssetHost);
  BrowserPolicy.content.allowScriptOrigin(staticAssetHost);
  BrowserPolicy.content.allowFontOrigin(staticAssetHost);
  BrowserPolicy.content.allowConnectOrigin(staticAssetHost);

  Meteor.publish("grainsMenu", function () {
    if (this.userId) {
      if (Meteor.settings.public.quotaEnabled) {
        // Hack: Fire off an asynchronous update to the user's storage usage whenever they open the
        //   front page.
        // TODO(someday): Implement the ability to reactively subscribe to storage usage from the
        //   back-end?
        const userId = this.userId;
        globalBackend.cap().getUserStorageUsage(userId).then(function (results) {
          inMeteor(function () {
            Meteor.users.update(userId, { $set: { storageUsage: parseInt(results.size) } });
          });
        }).catch(function (err) {
          if (err.kjType !== "unimplemented") {
            console.error(err.stack);
          }
        });
      }

      const identityIds = SandstormDb.getUserIdentityIds(globalDb.getUser(this.userId));
      return [
        UserActions.find({ userId: this.userId }),
        Grains.find({ userId: this.userId }),
        ApiTokens.find({ "owner.user.identityId": { $in: identityIds } }),
      ];
    } else {
      return [];
    }
  });

  Meteor.publish("sessions", function (sessionId) {
    // sessionId itself should be secret enough, but they are also not meant to be shared, so as
    // a backup we only publish the session to its owner. Note that `userId` can be null if the
    // user is not logged in or is using incognito mode.
    check(sessionId, String);
    return Sessions.find({ _id: sessionId, $or: [{ userId: this.userId }, { userId: null }] });
  });

  Meteor.publish("devPackages", function () {
    return DevPackages.find();
  });

  Meteor.publish("notifications", function () {
    return Notifications.find({ userId: this.userId },
      { fields: { timestamp: 1, text: 1, grainId: 1, userId: 1, isUnread: 1, appUpdates: 1,
                admin: 1, referral: 1, mailingListBonus: 1, }, });
  });

  Meteor.publish("notificationGrains", function (notificationIds) {
    // Since publishes can't be reactive, we leave it to the client to subscribe to both
    // "notifications" and "notificationGrains" reactively.
    check(notificationIds, [String]);
    const notifications =  Notifications.find({
      _id: { $in: notificationIds },
      userId: this.userId,
    }, {
      fields: { grainId: 1 },
    });

    const grainIds = notifications.map(function (row) {
      return row.grainId;
    });

    return Grains.find({ _id: { $in: grainIds } }, { fields: { title: 1 } });
  });

  Meteor.publish("hasUsers", function () {
    // Publish pseudo-collection which tells the client if there are any users at all.
    //
    // TODO(cleanup):  This seems overcomplicated.  Does Meteor have a better way?
    const cursor = Meteor.users.find();
    if (cursor.count() > 0) {
      this.added("hasUsers", "hasUsers", { hasUsers: true });
    } else {
      let handle = cursor.observeChanges({
        added: (id) => {
          this.added("hasUsers", "hasUsers", { hasUsers: true });
          handle.stop();
          handle = null;
        },
      });
      this.onStop(function () {
        if (handle) handle.stop();
      });
    }

    this.ready();
  });

  Meteor.publish("referralInfoPseudo", function () {
    // This publishes a pseudo-collection called referralInfo whose documents have the following
    // form:
    //
    // - id: (String) same as the User._id of an identity this user has referred
    // - name: (String) the profile.name from that identity
    // - completed: (Boolean) if this referral is complete

    //  If the user is not logged in, then we have no referralInfo.
    if (!this.userId) {
      return [];
    }

    // Implementation note:
    //
    // This pseudo-collection is populated very differently for (1) the completed: false case versus
    // the (2) completed: true case.

    // Case 1. Publish information about not-yet-complete referrals.
    const notCompletedReferralIdentitiesCursor = Meteor.users.find({
      referredBy: this.userId,
      "profile.name": { $exists: true },
    }, {
      fields: {
        _id: 1,
        referredBy: 1,
        "profile.name": 1,
      },
    });
    const notCompletedReferralIdentitiesHandle = notCompletedReferralIdentitiesCursor.observeChanges({
      // The added function gets called with the id of Bob when Alice refers Bob.
      added: (id, fields) => {
        this.added("referralInfo", id, { name: fields.profile.name, completed: false });
      },
      // The removed function gets called when Bob is no longer an uncompleted referral.  Note that
      // this will get more complicated once we support sending completed referrals to the client.
      removed: (id) => {
        this.removed("referralInfo", id);
      },
      // The modified function gets called when Bob's profile.name changed.
      modified: (id, fields) => {
        this.modified("referralInfo", id, { name: fields.profile.name, completed: false });
      },
    });

    // Case 2. Handle completed referrals.
    //
    // - Do a query for the current list of completed identities.
    //
    // - Every time we see a new such identity, we create a query that watches that one identity in
    //   case its profile.name changes.
    //
    // - Also watch the first query, since the list of completed identities might change.
    const handleForProfileNameByIdentityId = {};
    const stopWatchingAllIdentities = () => {
      Object.keys(handleForProfileNameByIdentityId).forEach((identityId) => {
        stopWatchingIdentity(identityId);
      });
    };

    const stopWatchingIdentity = (identityId) => {
      const handleForProfileName = handleForProfileNameByIdentityId[identityId];
      if (handleForProfileName) {
        this.removed("referralInfo", identityId);
        handleForProfileName.stop();
        // delete is safe because we iterate across `Object.keys()` which returns a copy.
        delete handleForProfileNameByIdentityId[identityId];
      }
    };

    const watchIdentityAndPublishReferralSuccess = (identityId) => {
      let handleForProfileName = handleForProfileNameByIdentityId[identityId];
      if (handleForProfileName) {
        return;
      }

      handleForProfileName = Meteor.users.find({
        _id: identityId,
      }, {
        fields: {
          "profile.name": 1,
        },
      }).observeChanges({
        added: (id, fields) => {
          this.added("referralInfo", id, { name: fields.profile.name, completed: true });
        },

        changed: (id, fields) => {
          this.changed("referralInfo", id, { name: fields.profile.name, completed: true });
        },

        removed: (id) => {
          stopWatchingIdentity(id);
        },
      });

      handleForProfileNameByIdentityId[identityId] = handleForProfileName;
    };

    const completedIdentityIdsHandle = Meteor.users.find({
      _id: this.userId,
      referredIdentityIds: { $exists: true },
    }, {
      fields: {
        referredIdentityIds: true,
      },
    }).observeChanges({
      // `added` gets called when a user gets their first completed referral.
      added: (id, fields) => {
        for (let i = 0; i < fields.referredIdentityIds.length; i++) {
          // Unconditionally mark these as successful referrals and start watching.
          watchIdentityAndPublishReferralSuccess(
            fields.referredIdentityIds[i]);
        }
      },
      // `changed` gets called when a user adds/removes referredIdentityIds, usually when a
      // referral becomes complete.
      changed: (id, fields) => {
        // Two major tasks.
        //
        // 1. Look for identityIds to unsubscribe from & send removed notices to the client.
        //
        // 2. Look for identityIds to subscribe to.

        // Task 1. Unsubscribe where needed.
        const referredIdentityIdsAsObject = {};
        fields.referredIdentityIds.forEach((i) => { referredIdentityIdsAsObject[i] = true; });

        Object.keys(handleForProfileNameByIdentityId).forEach((identityId) => {
          // If the handle doesn't show up in the new list of referredIdentityIds, then remove
          // info from the client & stop it on the server & make it null.
          const handleForProfileName = handleForProfileNameByIdentityId[identityId];
          if (referredIdentityIdsAsObject.hasOwnProperty(identityId)) {
            stopWatchingIdentity(identityId);
          }
        });

        // Task 2. Subscribe where needed.
        for (let i = 0; i < fields.referredIdentityIds.length; i++) {
          // The watch... function will avoid double-creating subscriptions, so this is safe.
          watchIdentityAndPublishReferralSuccess(fields.referredIdentityIds[i]);
        }
      },
      // `removed` gets called when a User suddenly has no referredIdentityIds.
      removed: () => {
        // Remove all data from client; stop all handles.
        stopWatchingAllIdentities();
      },
    });

    // With cases 1 and 2 handled, register a cleanup function, then declare victory.
    this.onStop(() => {
      stopWatchingAllIdentities();
      notCompletedReferralIdentitiesHandle.stop();
      completedIdentityIdsHandle.stop();
    });

    this.ready();
  });

  Meteor.publish("backers", function () {
    const backers = Assets.getText("backers.txt");
    let anonCount = 0;
    let counter = 0;

    backers.split("\n").forEach((name) => {
      name = name.trim();
      if (name === "") {
        ++anonCount;
      } else {
        this.added("backers", counter++, { name: name });
      }
    });

    // Text file ends in \n but that shouldn't count.
    --anonCount;

    this.added("backers", "anonymous", { count: anonCount - 1 });

    this.ready();
  });
}

const makeAccountSettingsUi = function () {
  return new SandstormAccountSettingsUi(globalTopbar, globalDb,
      window.location.protocol + "//" + makeWildcardHost("static"));
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const formatInCountdown = function (template, countdownDatetime) {
  const diff = countdownDatetime.getTime() - Date.now();

  const units = {
    day: 86400000,
    hour: 3600000,
    minute: 60000,
    second: 1000,
  };

  for (const unit in units) {
    // If it's more than one full unit away, then we'll print in terms of this unit. This does
    // mean that we write e.g. "1 minute" for the whole range between 2 minutes and 1 minute, but
    // whatever, this is typical of these sorts of displays.
    if (diff >= units[unit]) {
      const count = Math.floor(diff / units[unit]);
      // Update next 1ms after the point where `count` would change.
      setTopBarTimeout(template, diff - count * units[unit] + 1);
      return {
        text: "in " + count + " " + unit + (count > 1 ? "s" : ""),
        className: "countdown-" + unit,
      };
    }
  }

  // We're within a second of the countdown, or past it.
  if (diff < -3600000) {
    // Notification appears stale.
    return null;
  } else {
    setTopBarTimeout(template, diff + 3600001);
    return { text: "any moment", className: "countdown-now" };
  }
};

const formatAccountExpires = function () {
  const expires = Meteor.user().expires;
  return (expires && expires.toLocaleTimeString()) || null;
};

const formatAccountExpiresIn = function (template, currentDatetime) {
  // TODO(someday): formatInCountdown will set the interval to match account expiration time, and
  // completely overwrite the previous interval for $IN_COUNTDOWN
  const user = Meteor.user() || {};
  const expires = user.expires || null;
  if (!expires) {
    return null;
  } else {
    return formatInCountdown(template, expires, currentDatetime);
  }
};

const setTopBarTimeout = function (template, delay) {
  Meteor.clearTimeout(template.timeout);
  template.timeout = Meteor.setTimeout(function () {
    template.timer.changed();
  }, delay);

  // Make sure we re-run when the timeout triggers.
  template.timer.depend();
};

const determineAppName = function (grainId) {
  // Returns:
  //
  // - The current app title, if we can determine it, or
  //
  // - The empty string "", if we can't determine the current app title.
  let params = "";

  // Try our hardest to find the package's name, falling back on the default if needed.
  if (grainId) {
    const grain = Grains.findOne({ _id: grainId });
    if (grain && grain.packageId) {
      const thisPackage = Packages.findOne({ _id: grain.packageId });
      if (thisPackage) {
        params = SandstormDb.appNameFromPackage(thisPackage);
      }
    }
  }

  return params;
};

const billingPromptState = new ReactiveVar(null);

const showBillingPrompt = function (reason, next) {
  billingPromptState.set({
    reason: reason,
    db: globalDb,
    topbar: globalTopbar,
    accountsUi: globalAccountsUi,
    onComplete: function () {
      billingPromptState.set(null);
      if (next) next();
    },
  });
};

const ifQuotaAvailable = function (next) {
  const reason = isUserOverQuota(Meteor.user());
  if (reason) {
    if (window.BlackrockPayments) {
      showBillingPrompt(reason, function () {
        // If the user successfully raised their quota, continue the operation.
        if (!isUserOverQuota(Meteor.user())) {
          next();
        }
      });
    } else {
      alert("You are out of storage space. Please delete some things and try again.");
    }
  } else {
    next();
  }
};

const ifPlanAllowsCustomApps = function (next) {
  if (globalDb.isDemoUser() || globalDb.isUninvitedFreeUser()) {
    if (window.BlackrockPayments) {
      showBillingPrompt("customApp", function () {
        // If the user successfully chose a plan, continue the operation.
        if (!globalDb.isDemoUser() && !globalDb.isUninvitedFreeUser()) {
          next();
        }
      });
    } else {
      alert("Sorry, demo users cannot upload custom apps.");
    }
  } else {
    next();
  }
};

const isDemoExpired = function () {
  const user = Meteor.user();
  if (!user) return false;
  let expires = user.expires;
  if (!expires) return false;
  expires = expires.getTime() - Date.now();
  if (expires <= 0) return true;
  const comp = Tracker.currentComputation;
  if (expires && comp) {
    Meteor.setTimeout(comp.invalidate.bind(comp), expires);
  }

  return false;
};

// export: called by sandstorm-accounts-ui/login_buttons.js
logoutSandstorm = function () {
  Meteor.logout(function () {
    sessionStorage.removeItem("linkingIdentityLoginToken");
    Accounts._loginButtonsSession.closeDropdown();
    globalTopbar.closePopup();
    const openGrains = globalGrains.get();
    openGrains.forEach(function (grain) {
      grain.destroy();
    });

    globalGrains.set([]);
    Router.go("root");
  });
};

// export: this is also used by grain.js
makeDateString = function (date) {
  if (!date) {
    return "";
  }

  let result;

  const now = new Date();
  const diff = now.valueOf() - date.valueOf();

  if (diff < 86400000 && now.getDate() === date.getDate()) {
    result = date.toLocaleTimeString();
  } else {
    result = MONTHS[date.getMonth()] + " " + date.getDate() + " ";

    if (now.getFullYear() !== date.getFullYear()) {
      result = date.getFullYear() + " " + result;
    }
  }

  return result;
};

// export: used in sandstorm-ui-grainlist
prettySize = function (size) {
  let suffix = "B";
  if (size >= 1000000000) {
    size = size / 1000000000;
    suffix = "GB";
  } else if (size >= 1000000) {
    size = size / 1000000;
    suffix = "MB";
  } else if (size >= 1000) {
    size = size / 1000;
    suffix = "kB";
  }

  return size.toPrecision(3) + suffix;
};

// export: used in shared/demo.js
launchAndEnterGrainByPackageId = function (packageId) {
  const action = UserActions.findOne({ packageId: packageId });
  if (!action) {
    alert("Somehow, you seem to have attempted to launch a package you have not installed.");
    return;
  } else {
    launchAndEnterGrainByActionId(action._id, null, null);
  }
};

// export: used in sandstorm-ui-app-details
launchAndEnterGrainByActionId = function (actionId, devPackageId, devIndex) {
  // Note that this takes a devPackageId and a devIndex as well. If provided,
  // they override the actionId.
  let packageId;
  let command;
  let appTitle;
  let nounPhrase;
  if (devPackageId) {
    const devPackage = DevPackages.findOne(devPackageId);
    if (!devPackage) {
      console.error("no such dev package: ", devPackageId);
      return;
    }

    const devAction = devPackage.manifest.actions[devIndex];
    packageId = devPackageId;
    command = devAction.command;
    appTitle = SandstormDb.appNameFromPackage(devPackage);
    nounPhrase = SandstormDb.nounPhraseForActionAndAppTitle(devAction, appTitle);
  } else {
    const action = UserActions.findOne(actionId);
    if (!action) {
      console.error("no such action:", actionId);
      return;
    }

    packageId = action.packageId;
    const pkg = Packages.findOne(packageId);
    command = action.command;
    appTitle = SandstormDb.appNameFromPackage(pkg);
    nounPhrase = SandstormDb.nounPhraseForActionAndAppTitle(action, appTitle);
  }

  const title = "Untitled " + appTitle + " " + nounPhrase;

  const identityId = Accounts.getCurrentIdentityId();

  // We need to ask the server to start a new grain, then browse to it.
  Meteor.call("newGrain", packageId, command, title, identityId, function (error, grainId) {
    if (error) {
      console.error(error);
      alert(error.message);
    } else {
      Router.go("grain", { grainId: grainId });
    }
  });
};

// export global - used in grain.js
globalQuotaEnforcer = {
  ifQuotaAvailable: ifQuotaAvailable,
  ifPlanAllowsCustomApps: ifPlanAllowsCustomApps,
};

if (Meteor.isClient) {
  HasUsers = new Mongo.Collection("hasUsers");  // dummy collection defined above
  Backers = new Mongo.Collection("backers");  // pseudo-collection defined above
  ReferralInfo = new Meteor.Collection("referralInfo"); // pseudo-collection

  if (Meteor.settings.public.quotaEnabled) {
    window.testDisableQuotaClientSide = function () {
      Meteor.settings.public.quotaEnabled = false;
    };
  }

  Router.onRun(function () {
    // Close menus and popups any time we navigate.
    globalTopbar.reset();
    this.next();
  });

  Template.layout.events({
    "click a": function (event) {
      // Close menus if a navigation link is clicked. Usually the Router.onRun(), above, will also
      // execute, but it will not in the case where the link points to the current page, yet we'd
      // really still like for the menus to close in such cases.
      if (!event.isDefaultPrevented()) {
        globalTopbar.reset();
      }
    },
  });

  Template.about.helpers({
    setDocumentTitle: function () {
      document.title = "About · " + globalDb.getServerTitle();
    },
  });

  Template.referrals.helpers({
    setDocumentTitle: function () {
      document.title = "Referral Program · " + globalDb.getServerTitle();
    },
  });

  Template.body.onRendered(function () {
    // If we're on iOS, set a class name on <body> so we can use CSS styles to work around mobile
    // Safari's ridiculous iframe rendering behavior.
    //
    // Note that this can't be done as a template helper because the <body> tag cannot have
    // attributes determined by helpers. This appears to be a Meteor bug related to the fact that
    // the <body> tag is not inside a <template>, but rather is itself equivalent to a <template>.
    if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
      document.body.className = "ios";
    }
  });

  Template.layout.onCreated(function () {
    this.timer = new Tracker.Dependency();
    const resizeTracker = this.resizeTracker = new Tracker.Dependency();
    this.resizeFunc = function () {
      resizeTracker.changed();
    };

    window.addEventListener("resize", this.resizeFunc, false);
  });

  Template.layout.onDestroyed(function () {
    Meteor.clearTimeout(this.timeout);
    window.removeEventListener("resize", this.resizeFunc, false);
  });

  Template.referrals.helpers({
    isPaid: function () {
      return (Meteor.user() && Meteor.user().plan && Meteor.user().plan !== "free");
    },

    notYetCompleteReferralNames: function () {
      return ReferralInfo.find({ completed: false });
    },

    completeReferralNames: function () {
      return ReferralInfo.find({ completed: true });
    },
  });

  Template.layout.helpers({
    adminAlertIsTooLarge: function () {
      Template.instance().resizeTracker.depend();
      const setting = Settings.findOne({ _id: "adminAlert" });
      if (!setting || !setting.value) {
        return false;
      }
      // TODO(someday): 10 and 850 are just magic values that estimate the size of the font and the
      // number of pixels everything else in the topbar respectively. This should really be
      // calculated based on actual sizes of things in the topbar.
      return (window.innerWidth - setting.value.length * 10) < 850;
    },

    adminAlert: function () {
      const setting = Settings.findOne({ _id: "adminAlert" });
      if (!setting || !setting.value) {
        return null;
      }

      let text = setting.value;

      const alertTimeSetting = Settings.findOne({ _id: "adminAlertTime" });
      const alertTime = alertTimeSetting && alertTimeSetting.value;

      const alertUrlSetting = Settings.findOne({ _id: "adminAlertUrl" });
      let alertUrl = alertUrlSetting ? alertUrlSetting.value.trim() : null;
      if (!alertUrl) alertUrl = null;

      const template = Template.instance();
      let param;
      let className;
      if (text.indexOf("$TIME") !== -1) {
        if (!alertTime) return null;
        text = text.replace("$TIME", alertTime.toLocaleTimeString());
      }

      if (text.indexOf("$DATE") !== -1) {
        if (!alertTime) return null;
        text = text.replace("$DATE", alertTime.toLocaleDateString());
      }

      if (text.indexOf("$IN_COUNTDOWN") !== -1) {
        if (!alertTime) return null;
        param = formatInCountdown(template, alertTime);
        if (!param) return null;
        text = text.replace("$IN_COUNTDOWN", param.text);
        className = param.className;
      }

      if (text.indexOf("$ACCOUNT_EXPIRES_IN") !== -1) {
        param = formatAccountExpiresIn(template);
        if (!param) return null;
        text = text.replace("$ACCOUNT_EXPIRES_IN", param.text);
        className = param.className;
      }

      if (text.indexOf("$ACCOUNT_EXPIRES") !== -1) {
        param = formatAccountExpires();
        if (!param) return null;
        text = text.replace("$ACCOUNT_EXPIRES", param);
      }

      if (text.indexOf("$APPNAME") !== -1) {
        text = text.replace("$APPNAME", determineAppName(this.grainId));
      }

      if (alertUrl && alertUrl.indexOf("$APPNAME") !== -1) {
        alertUrl = alertUrl.replace("$APPNAME", determineAppName(this.grainId));
      }

      return {
        text,
        className,
        alertUrl,
      };
    },

    billingPromptState: function () {
      return billingPromptState.get();
    },

    demoExpired: isDemoExpired,
    canUpgradeDemo: function () {
      return Meteor.settings.public.allowUninvited;
    },

    globalAccountsUi: function () {
      return globalAccountsUi;
    },

    identityUser: function () {
      const user = Meteor.user();
      return user && user.profile;
    },

    showAccountButtons: function () {
      return Meteor.user() && !Meteor.loggingIn() && !isDemoUser();
    },

    accountButtonsData: function () {
      return { isAdmin: globalDb.isAdmin() };
    },

    firstLogin: function () {
      return credentialsSubscription.ready() && !isDemoUser() && !Meteor.loggingIn()
          && Meteor.user() && !Meteor.user().hasCompletedSignup;
    },

    accountSettingsUi: function () {
      return makeAccountSettingsUi();
    },

    firstTimeBillingPromptState: function () {
      // Should we show the first-time billing plan selector?

      // Don't show if billing is not enabled.
      if (!window.BlackrockPayments) return;

      const user = Meteor.user();

      // Don't show if not logged in.
      if (!user) return;

      // Don't show if not in the experiment.
      if (!user.experiments || user.experiments.firstTimeBillingPrompt !== "test") return;

      // Don't show if the user has selected a plan already.
      if (user.plan && !Session.get("firstTimeBillingPromptOpen")) return;

      // Only show to account users (not identities).
      if (!user.loginIdentities) return;

      // Don't show to demo users.
      if (user.expires) return;

      // Don't show when viewing another user's grain. We don't want to scare people away from
      // logging in to collaborate.
      const route = Router.current().route.getName();
      if (route === "shared") return;
      if (route === "grain") {
        if (_.some(globalGrains.get(), function (grain) {
          return grain.isActive() && !grain.isOwner();
        })) {

          return;
        }
      }

      // Don't let the plan chooser disappear instantly once user.plan is set.
      Session.set("firstTimeBillingPromptOpen", true);

      // OK, show it.
      return {
        db: globalDb,
        topbar: globalTopbar,
        accountsUi: globalAccountsUi,
        onComplete: function () {
          Session.set("firstTimeBillingPromptOpen", false);
        },
      };
    },
  });

  Template.layout.events({
    "click #demo-expired .logout": function (event) {
      logoutSandstorm();
    },
  });

  credentialsSubscription = Meteor.subscribe("credentials");

  Template.registerHelper("dateString", makeDateString);
  Template.registerHelper("hideNavbar", function () {
    // Hide navbar if user is not logged in, since they can't go anywhere with it.
    return !Meteor.userId() || isDemoExpired();
  });

  Template.registerHelper("shrinkNavbar", function () {
    // Shrink the navbar if the user clicked the button to do so.
    return Session.get("shrink-navbar");
  });

  Template.registerHelper("quotaEnabled", function () {
    return Meteor.settings.public.quotaEnabled;
  });

  Template.root.helpers({
    storageUsage: function () {
      return Meteor.userId() ? prettySize(Meteor.user().storageUsage || 0) : undefined;
    },

    storageQuota: function () {
      const plan = globalDb.getMyPlan();
      return plan ? prettySize(plan.storage) : undefined;
    },

    overQuota: function () {
      return !window.BlackrockPayments && isUserOverQuota(Meteor.user());
    },
  });

  Template.root.events({
    "click .uninstall-app-button": function (event) {
      // TODO(cleanup): This event handler is no longer used, but the new UI does not yet implement
      //   uninstall. Leave this code here for reference until it does.
      const appId = event.currentTarget.getAttribute("data-appid");
      if (window.confirm("Really uninstall this app?")) {
        UserActions.find({ appId: appId, userId: Meteor.userId() }).forEach(function (action) {
          UserActions.remove(action._id);
        });

        Meteor.call("deleteUnusedPackages", appId);
      }
    },
  });

  Template.notificationsPopup.helpers({
    notifications: function () {
      Meteor.call("readAllNotifications");
      return Notifications.find({ userId: Meteor.userId() }, { sort: { timestamp: -1 } }).map(function (row) {
        const grain = Grains.findOne({ _id: row.grainId });
        if (grain) {
          row.grainTitle = grain.title;
        }

        return row;
      });
    },
  });

  Template.notifications.helpers({
    notificationCount: function () {
      return Notifications.find({ userId: Meteor.userId(), isUnread: true }).count();
    },
  });

  Template.notificationsPopup.events({
    "click #notification-dropdown": function (event) {
      return false;
    },
  });

  Template.notificationItem.helpers({
    isAppUpdates: function () {
      return !!this.appUpdates;
    },

    notificationTitle: function () {
      if (this.admin) {
        return "Notification from System";
      } else if (this.appUpdates) {
        return "App updates are available";
      } else if (this.referral || this.mailingListBonus) {
        return false;
      }

      return this.grainTitle + " is backgrounded";
    },

    titleHelperText: function () {
      if (this.admin) {
        return "Dismiss this system notification";
      } else if (this.referral) {
        return "Dismiss this referral notification";
      } else {
        return "Stop the background app";
      }
    },

    dismissText: function () {
      if (this.admin && this.admin.type === "reportStats") {
        return false;
      } else if (this.referral) {
        return "Dismiss";
      }

      return "Cancel";
    },

    adminLink: function () {
      return this.admin && this.admin.action;
    },

    appUpdatesList: function () {
      return _.values(this.appUpdates);
    },

    paidUser: function () {
      const plan = Meteor.user().plan;
      return plan && plan !== "free";
    },
  });

  Template.notificationItem.events({
    "click .cancel-notification": function (event) {
      Meteor.call("dismissNotification", this._id);
      return false;
    },

    "click .accept-notification": function (event) {
      if (this.appUpdates) {
        Meteor.call("updateApps", this.appUpdates, (err) => {
          // TODO(someday): if (err)
          Meteor.call("dismissNotification", this._id);
        });
      }

      return false;
    },

    "click .dismiss-notification": function (event) {
      Meteor.call("dismissNotification", this._id);
    },
  });

  Meteor.startup(function () {
    // Tell app authors how to run JS in the context of the grain-frame.
    console.log(
        "%cApp authors: To understand the grain-frame in Sandstorm and how to find " +
        "logs and perform troubleshooting, see: " +
        "\n- https://docs.sandstorm.io/en/latest/developing/path/ " +
        "\n- https://docs.sandstorm.io/en/latest/using/top-bar/ " +
        "\n- https://docs.sandstorm.io/en/latest/developing/troubleshooting/ " +
        "\n" +
        "\nWhen debugging, make sure you execute Javascript " +
        "in the context of the 'grain-frame' IFRAME. References: " +
        "\n- https://stackoverflow.com/questions/3275816/debugging-iframes-with-chrome-developer-tools " +
        "\n- https://developer.mozilla.org/en-US/docs/Tools/Working_with_iframes " +
        "\n" +
        "\nWe can also provide personal assistance! Get in touch: https://sandstorm.io/community",
      "font-size: large; background-color: yellow;");

    Meteor.subscribe("notifications");

    Meteor.autorun(function () {
      Meteor.subscribe("notificationGrains",
        Notifications.find().map(function (row) {
          return row._id;
        })
      );
    });
  });

  Meteor.methods({
    dismissNotification(notificationId) {
      // Client-side simulation of dismissNotification.
      Notifications.remove({ _id: notificationId });
    },
  });
}

Router.configure({
  layoutTemplate: "layout",
  notFoundTemplate: "notFound",
  loadingTemplate: "loading",
});

if (Meteor.isClient) {
  Router.onBeforeAction("loading");
}

function getBuildInfo() {
  let build = Meteor.settings && Meteor.settings.public && Meteor.settings.public.build;
  const isNumber = typeof build === "number";
  if (!build) {
    build = "(unknown)";
  } else if (isNumber) {
    build = String(Math.floor(build / 1000)) + "." + String(build % 1000);
  }

  return {
    build: build,
    isUnofficial: !isNumber,
  };
}

const promptForFile = function (input, callback) {
  // TODO(cleanup): Share code with "upload picture" and other upload buttons.
  function listener(e) {
    input.removeEventListener("change", listener);
    callback(e.currentTarget.files[0]);
  }

  input.addEventListener("change", listener);
  input.click();
};

const startUpload = function (file, endpoint, onComplete) {
  // TODO(cleanup): Use Meteor's HTTP, although this may require sending them a PR to support
  //   progress callbacks (and officially document that binary input is accepted).

  Session.set("uploadStatus", "Uploading");

  const xhr = new XMLHttpRequest();

  xhr.onreadystatechange = function () {
    if (xhr.readyState == 4) {
      console.log(xhr.status);
      if (xhr.status == 200) {
        Session.set("uploadProgress", 0);
        onComplete(xhr.responseText);
      } else {
        Session.set("uploadError", {
          status: xhr.status,
          statusText: xhr.statusText,
          response: xhr.responseText,
        });
      }
    }
  };

  if (xhr.upload) {
    xhr.upload.addEventListener("progress", function (progressEvent) {
      Session.set("uploadProgress",
          Math.floor(progressEvent.loaded / progressEvent.total * 100));
    });
  }

  xhr.open("POST", endpoint, true);
  xhr.send(file);

  Router.go("uploadStatus");
};

restoreBackup = function (file) {
  // This function is global so tests can call it
  startUpload(file, "/uploadBackup", function (response) {
    Session.set("uploadStatus", "Unpacking");
    const identityId = Accounts.getCurrentIdentityId();
    Meteor.call("restoreGrain", response, identityId, function (err, grainId) {
      if (err) {
        console.log(err);
        Session.set("uploadStatus", undefined);
        Session.set("uploadError", {
          status: "",
          statusText: err.message,
        });
      } else {
        Router.go("grain", { grainId: grainId });
      }
    });
  });
};

promptRestoreBackup = function (input) {
  promptForFile(input, restoreBackup);
};

uploadApp = function (file) {
  // This function is global so tests can call it
  Meteor.call("newUploadToken", function (err, token) {
    if (err) {
      console.error(err);
      alert(err.message);
    } else {
      startUpload(file, "/upload/" + token, function (response) {
        Session.set("uploadStatus", undefined);
        Router.go("install", { packageId: response });
      });
    }
  });
};

promptUploadApp = function (input) {
  promptForFile(input, uploadApp);
};

Router.map(function () {
  this.route("root", {
    path: "/",
    waitOn: function () {
      return [
        Meteor.subscribe("hasUsers"),
        Meteor.subscribe("grainsMenu"),
      ];
    },

    data: function () {
      // If the user is logged-in, and can create new grains, and
      // has no grains yet, then send them to "new".
      if (this.ready() && Meteor.userId() && !Meteor.loggingIn()) {
        if (globalDb.currentUserGrains({}, {}).count() === 0 &&
            globalDb.currentUserApiTokens().count() === 0) {
          Router.go("apps", {}, { replaceState: true });
        } else {
          Router.go("grains", {}, { replaceState: true });
        }
      }

      return {
        needsAdminTokenLogin: this.ready() && !HasUsers.findOne("hasUsers") && !globalDb.allowDevAccounts(),
        build: getBuildInfo().build,
        splashUrl: (Settings.findOne("splashUrl") || {}).value,
      };
    },
  });

  this.route("linkHandler", {
    path: "/link-handler/:url",

    data: function () {
      let url = this.params.url;
      if (url.lastIndexOf("web+sandstorm:", 0) === 0) {
        url = url.slice("web+sandstorm:".length);
      }
      // TODO(cleanup):  Didn't use Router.go() because the url may contain a query term.
      document.location = "/install/" + url;
      return {};
    },
  });

  this.route("about", {
    path: "/about",
    data: function () {
      const result = getBuildInfo();

      const backers = Session.get("backers");
      if (backers) {
        result.backers = backers.names;
        result.anonCount = backers.anonCount;
      } else {
        HTTP.get("/sandstorm-backers.txt", function (err, response) {
          let names = response.content.split("\n").sort(function (a, b) {
            return a.toLowerCase().localeCompare(b.toLowerCase());
          });

          let anonCount = 0;
          while (anonCount < names.length && names[anonCount] === "") {
            ++anonCount;
          }

          names = names.slice(anonCount);

          // File ends in trailing newline, but that last blank line does not represent an
          // anonymous contributor.
          --anonCount;

          Session.set("backers", {
            names,
            anonCount,
          });
        });
      }

      result.termsUrl = globalDb.getSetting("termsUrl");
      result.privacyUrl = globalDb.getSetting("privacyUrl");

      return result;
    },
  });

  this.route("uploadStatus", {
    path: "/upload",

    waitOn: function () {
      return Meteor.subscribe("credentials");
    },

    data: function () {
      return {
        progress: Session.get("uploadProgress"),
        status: Session.get("uploadStatus"),
        error: Session.get("uploadError"),
      };
    },
  });

  this.route("referrals", {
    path: "/referrals",

    waitOn: function () {
      return Meteor.subscribe("referralInfoPseudo");
    },
  });

  this.route("account", {
    path: "/account",

    data: function () {
      // Don't allow logged-out or demo users to visit the accounts page. There should be no way
      // for them to get there except for typing the URL manually. In theory showing the accounts
      // page to a demo user could make some sense for editing their profile, but we really do not
      // want them signing up for subscription plans!
      if ((!Meteor.user() && !Meteor.loggingIn()) || globalDb.isDemoUser()) {
        Router.go("root", {}, { replaceState: true });
      } else {
        return makeAccountSettingsUi();
      }
    },
  });

  this.route("accountUsage", {
    path: "/account/usage",
  });
});
