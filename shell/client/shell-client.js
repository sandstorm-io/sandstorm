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

import getBuildInfo from "/imports/client/build-info.js";
import SandstormAccountSettingsUi from "/imports/client/accounts/account-settings-ui.js";
import { isStandalone } from "/imports/client/standalone.js";

// Subscribe to basic grain information first and foremost, since
// without it we might e.g. redirect to the wrong place on login.
globalSubs = [
  Meteor.subscribe("grainsMenu"),
  Meteor.subscribe("userPackages"),
  Meteor.subscribe("devPackages"),
  Meteor.subscribe("credentials"),
  Meteor.subscribe("accountCredentials"),
];

getUserLanguage = function () {
  return navigator.language;
};

if (Meteor.isClient) {
  Meteor.startup(function () {
    Session.set("showLoadingIndicator", true);
    TAPi18n.setLanguage(getUserLanguage())
      .done(function () {
        Session.set("showLoadingIndicator", false);
      })
      .fail(function (errorMessage) {
        // Handle the situation
        console.log(errorMessage);
      });
  });
}

Tracker.autorun(function () {
  const me = Meteor.user();
  if (me) {
    if (me.type === "credential") {
      Meteor.subscribe("credentialDetails", me._id);
    }

    if (me.loginCredentials) {
      me.loginCredentials.forEach(function (credential) {
        Meteor.subscribe("credentialDetails", credential.id);
      });
    }

    if (me.nonloginCredentials) {
      me.nonloginCredentials.forEach(function (credential) {
        Meteor.subscribe("credentialDetails", credential.id);
      });
    }
  }
});

// export: called by sandstorm-accounts-ui/login_buttons.js
//               and grain-client.js
logoutSandstorm = function () {
  const logoutHelper = function () {
    sessionStorage.removeItem("linkingIdentityLoginToken");
    Accounts._loginButtonsSession.closeDropdown();
    globalTopbar.closePopup();
    if (!isStandalone()) {
      globalGrains.clear();
    }
  };

  if (globalDb.userHasSamlLoginCredential()) {
    Meteor.call("generateSamlLogout", function (err, url) {
      Meteor.logout(function () {
        logoutHelper();
        if (err) {
          console.error(err);
        } else {
          window.location = url;
        }
      });
    });
  } else {
    Meteor.logout(function () {
      logoutHelper();
      if (!isStandalone()) {
        Router.go("root");
      }
    });
  }
};

const makeAccountSettingsUi = function () {
  return new SandstormAccountSettingsUi(globalTopbar, globalDb,
      window.location.protocol + "//" + makeWildcardHost("static"));
};

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
    billingPromptTemplate: window.BlackrockPayments ? "billingPrompt" : "billingPromptLocal",
    onComplete: function () {
      billingPromptState.set(null);
      if (!window.BlackrockPayments) {
        Meteor.call("updateQuota", function (err) {
          if (err) {
            console.error(err);
            alert(err);
          }

          if (next) next();
        });
      } else if (next) {
        next();
      }
    },
  });
};

const ifQuotaAvailable = function (next) {
  const reason = isUserOverQuota(Meteor.user());
  if (reason) {
    showBillingPrompt(reason, function () {
      // If the user successfully raised their quota, continue the operation.
      if (!isUserOverQuota(Meteor.user())) {
        next();
      }
    });
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
  if (!size) return "";

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
launchAndEnterGrainByPackageId = function (packageId, options) {
  const action = UserActions.findOne({ packageId: packageId });
  if (!action) {
    alert("Somehow, you seem to have attempted to launch a package you have not installed.");
    return;
  } else {
    launchAndEnterGrainByActionId(action._id, null, null, options);
  }
};

// export: used in sandstorm-ui-app-details
launchAndEnterGrainByActionId = function (actionId, devPackageId, devIndex, options) {
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

  // We need to ask the server to start a new grain, then browse to it.
  Meteor.call("newGrain", packageId, command, title, null, function (error, grainId) {
    if (error) {
      if (error.error === 402) {
        // Sadly this can occur under LDAP quota management when the backend updates its quota
        // while creating the grain.
        showBillingPrompt("outOfStorage", function () {
          // TODO(someday): figure out the actual reason, instead of hard-coding outOfStorage
          Meteor.call("newGrain", packageId, command, title, null,
          function (error, grainId) {
            if (error) {
              console.error(error);
              alert(error.message);
            } else {
              Router.go("grain", { grainId: grainId }, options);
            }
          });
        });
      } else {
        console.error(error);
        alert(error.message);
      }
    } else {
      Router.go("grain", { grainId: grainId }, options);
    }
  });
};

// export global - used in grain.js
globalQuotaEnforcer = {
  ifQuotaAvailable: ifQuotaAvailable,
  ifPlanAllowsCustomApps: ifPlanAllowsCustomApps,
};

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
  effectiveServerTitle() {
    const useServerTitle =
        globalDb.getSettingWithFallback("whitelabelUseServerTitleForHomeText", false);
    return useServerTitle ? globalDb.getSettingWithFallback("serverTitle", "Sandstorm") :
        "Sandstorm";
  },

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

  globalGrains: function () {
    return globalGrains;
  },

  credentialUser: function () {
    const user = Meteor.user();
    return user && user.type === "credential";
  },

  showAccountButtons: function () {
    return Meteor.user() && !Meteor.loggingIn() && !isDemoUser();
  },

  accountButtonsData: function () {
    const showSendFeedback = !globalDb.getSettingWithFallback("whitelabelHideSendFeedback", false);
    return {
      isAdmin: globalDb.isAdmin(),
      grains: globalGrains,
      showSendFeedback,
    };
  },

  firstLogin: function () {
    return credentialsSubscription.ready() && !isDemoUser() && !Meteor.loggingIn()
        && Meteor.user() && !Meteor.user().hasCompletedSignup &&
        !isStandalone();
  },

  accountSettingsUi: function () {
    return makeAccountSettingsUi();
  },

  isAccountSuspended: function () {
    const user = Meteor.user();
    return user && user.suspended;
  },

  isStandalone: function () {
    return isStandalone();
  },

  demoModal: function () {
    return Session.get("globalDemoModal");
  },

  dismissDemoModal: function () {
    return function () {
      Session.set("globalDemoModal", null);
    };
  },
});

Template.layout.events({
  "click #demo-expired button[name=logout]"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
    logoutSandstorm();
  },

  "click .demo-startup-modal .start"(evt) {
    Session.set("globalDemoModal", null);
  },
});

credentialsSubscription = Meteor.subscribe("credentials");

Template.registerHelper("dateString", makeDateString);
Template.registerHelper("hideNavbar", function () {
  // Hide navbar if user is not logged in, since they can't go anywhere with it.
  return (!Meteor.userId() && globalGrains.getAll().length <= 1) || isDemoExpired();
});

Template.registerHelper("shrinkNavbar", function () {
  // Shrink the navbar if the user clicked the button to do so.
  return Session.get("shrink-navbar");
});

Template.registerHelper("quotaEnabled", function () {
  return globalDb.isQuotaEnabled();
});

Template.registerHelper("referralsEnabled", function () {
  return globalDb.isReferralEnabled();
});

Template.registerHelper("con", function () {
  return Array.prototype.slice.call(arguments, 0, -1).join('.')
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

Meteor.startup(function () {
  // Tell app authors how to run JS in the context of the grain-frame.
  if (!Meteor._localStorage.getItem("muteDevNote")) {
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
  }
});

Router.configure({
  layoutTemplate: "layout",
  notFoundTemplate: "notFound",
  loadingTemplate: "loading",
});

if (Meteor.isClient) {
  Router.onBeforeAction("loading");
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

  if (endpoint.startsWith("/") && !endpoint.startsWith("//")) {
    // Endpoint is relative to the current host. Use the DDP host instead, if one is defined,
    // so that we don't do file transfers over the main host, which may be a CDN.
    const origin = __meteor_runtime_config__.DDP_DEFAULT_CONNECTION_URL || "";  // jscs:ignore requireCamelCaseOrUpperCaseIdentifiers
    endpoint = origin + endpoint;
  }

  Session.set("uploadStatus", "Uploading");
  Session.set("uploadError", undefined);

  const xhr = new XMLHttpRequest();

  xhr.onreadystatechange = function () {
    if (xhr.readyState == 4) {
      if (xhr.status >= 200 && xhr.status < 300) {
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
  Meteor.call("newRestoreToken", function (err, token) {
    if (err) {
      console.error(err);
      alert(err.message);
    } else {
      startUpload(file, "/uploadBackup/" + token, function (response) {
        Session.set("uploadStatus", "Unpacking");
        Meteor.call("restoreGrain", token, null, function (err, grainId) {
          if (err) {
            console.log(err);
            Session.set("uploadStatus", undefined);
            Session.set("uploadError", {
              status: "",
              statusText: err.message,
            });
          } else {
            Router.go("grain", { grainId: grainId }, { replaceState: true });
          }
        });
      });
    }
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
        Router.go("install", { packageId: response }, { replaceState: true });
      });
    }
  });
};

promptUploadApp = function (input) {
  promptForFile(input, uploadApp);
};

Template.uploadTest.events({
  "change #upload-app": function (event, tmpl) {
    uploadApp(event.currentTarget.files[0]);
  },

  "change #upload-backup": function (event, tmpl) {
    restoreBackup(event.currentTarget.files[0]);
  },
});

Router.map(function () {
  this.route("root", {
    path: "/",
    subscriptions: function () {
      this.subscribe("hasUsers").wait();
      if (!Meteor.loggingIn() && Meteor.user() && Meteor.user().loginCredentials) {
        this.subscribe("grainsMenu").wait();
      }
    },

    data: function () {
      if (isStandalone()) {
        return; // TODO(soon): move the route logic here?
      }
      // If the user is logged-in, and can create new grains, and
      // has no grains yet, then send them to "new".
      if (this.ready() && Meteor.userId() && !Meteor.loggingIn() && Meteor.user().loginCredentials) {
        if (globalDb.currentUserGrains().count() === 0 &&
            globalDb.currentUserApiTokens().count() === 0) {
          Router.go("apps", {}, { replaceState: true });
        } else {
          Router.go("grains", {}, { replaceState: true });
        }
      }

      if (this.ready() && !HasUsers.findOne("hasUsers") && !globalDb.allowDevAccounts()) {
        // This server has no users and hasn't been setup yet.
        this.redirect("setupWizardIntro");
      }

      return {
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

  this.route("uploadTest", {
    path: "/upload-test",

    waitOn: function () {
      return Meteor.subscribe("credentials");
    },

    data: function () {},
  });

  this.route("referrals", {
    path: "/referrals",

    waitOn: function () {
      return Meteor.subscribe("referralInfoPseudo");
    },
  });

  this.route("account", {
    path: "/account",

    waitOn() {
      return globalSubs;
    },

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
});
