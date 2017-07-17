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

// This file implements /grain, i.e. the main view into an app.

import { introJs } from "intro.js";

import downloadFile from "/imports/client/download-file.js";
import { ContactProfiles } from "/imports/client/contacts.js";
import { isStandalone } from "/imports/client/standalone.js";
import { GrainView } from "/imports/client/grain/grainview.js";

// Pseudo-collections.
TokenInfo = new Mongo.Collection("tokenInfo");
// TokenInfo is used by grainview.js
GrantedAccessRequests = new Mongo.Collection("grantedAccessRequests");
// Pseudo-collection about access requests
GrainLog = new Mongo.Collection("grainLog");
// Pseudo-collection created by subscribing to "grainLog", implemented in proxy.js.

const promptNewTitle = function () {
  const grain = globalGrains.getActive();
  if (grain) {
    let prompt = "Set new title:";
    if (!grain.isOwner()) {
      prompt = "Set a new personal title: (does not change the owner's title for this grain)";
    }

    const title = window.prompt(prompt, grain.title());
    if (title) {
      grain.setTitle(title);
    }
  }
};

const showConnectionGraph = function () {
  const closer = globalTopbar.addItem({
    name: "who-has-access",
    template: Template.whoHasAccess,
    popupTemplate: Template.whoHasAccessPopup,
    startOpen: true,
    onDismiss: function () {
      return "remove";
    },
  });
};

const mapGrainStateToTemplateData = function (grainState) {
  const error = grainState.error();
  const templateData = {
    grainId: grainState.grainId(),
    active: grainState.isActive(),
    title: grainState.title(),
    error: error && error.message,
    unauthorized: error && (error.error == 403),
    notFound: error && (error.error == 404),
    inMyTrash: grainState.isInMyTrash(),
    inOwnersTrash: error && (error.error === "grain-is-in-trash"),
    grainOwnerSuspended: error && (error.error === "grain-owner-suspended"),
    appOrigin: grainState.origin(),
    hasNotLoaded: !(grainState.hasLoaded()),
    sessionId: grainState.sessionId(),
    originalPath: grainState._originalPath,
    interstitial: !isStandalone() && grainState.shouldShowInterstitial(),
    token: grainState.token(),
    viewInfo: grainState.viewInfo(),
    signinOverlay: grainState.signinOverlay(),
    grainView: grainState,
    isPowerbox: grainState.isPowerboxRequest(),
  };
  return templateData;
};

Tracker.autorun(function () {
  // We need to keep track of certain data about each grain we can view.
  // TODO(cleanup): Do these in GrainView to avoid spurious resubscribes.
  const grains = globalGrains.getAll();
  grains.forEach(function (grain) {
    grain.depend();
    const grainId = grain.grainId();
    if (grainId) {
      Meteor.subscribe("grainTopBar", grainId);
      if (grain.isOwner()) {
        Meteor.subscribe("packageByGrainId", grainId);
      }

      const token = grain.token();
      if (token) {
        Meteor.subscribe("tokenInfo", token, false);
      }
    }
  });
});

Tracker.autorun(function () {
  // While the tab is visible, keep the active grain marked read.

  if (!browserTabHidden.get()) {
    const activeGrain = globalGrains.getActive();
    if (activeGrain && activeGrain.isUnread()) {
      Tracker.nonreactive(() => {
        activeGrain.markRead();
      });
    }
  }
});

Template.grainTitle.events({
  click: function (event) {
    promptNewTitle();
  },

  keydown: function (event) {
    if ((event.keyCode === 13) || (event.keyCode === 32)) {
      // Allow space or enter to trigger renaming the grain - Firefox doesn't treat enter on the
      // focused element as click().
      promptNewTitle();
      event.preventDefault();
    }
  },
});

Template.grainDeleteButton.events({
  "click button": function (event) {
    const activeGrain = globalGrains.getActive();
    const grainId = activeGrain.grainId();
    let confirmationMessage = "Really move this grain to your trash?";
    if (window.confirm(confirmationMessage)) {
      Meteor.call("moveGrainsToTrash", [grainId]);
      globalGrains.remove(grainId, true);
    }
  },
});

Template.grainDebugLogButton.events({
  "click button": function (event) {
    this.reset();
    const activeGrain = globalGrains.getActive();
    window.open("/grainlog/" + activeGrain.grainId(), "_blank",
        "menubar=no,status=no,toolbar=no,width=700,height=700");
  },
});

Template.grainBackupPopup.onCreated(function () {
  const activeGrain = globalGrains.getActive();
  this._grainId = activeGrain.grainId();
  this._title = activeGrain.title();
  this._state = new ReactiveVar({ loading: true });

  const _this = this;
  this._doBackup = function () {
    _this._state.set({ processing: true });
    Meteor.call("backupGrain", _this._grainId, function (err, id) {
      if (err) {
        _this._state.set({ error: "Backup failed: " + err });
      } else if (!_this._state.get().canceled) {
        const origin = __meteor_runtime_config__.DDP_DEFAULT_CONNECTION_URL || "";  // jscs:ignore requireCamelCaseOrUpperCaseIdentifiers
        const url = origin + "/downloadBackup/" + id;
        const suggestedFilename = activeGrain.title() + ".zip";
        downloadFile(url, suggestedFilename);

        // Close the topbar popup.
        _this.data.reset();
      }
    });
  };

  const grain = Grains.findOne({ _id: this._grainId });

  if (grain.appId === "s3u2xgmqwznz2n3apf30sm3gw1d85y029enw5pymx734cnk5n78h") {
    // HACK: Display a warning if this is a Collections grain.
    //
    // TODO(soon): Figure out how to avoid special-casing here. Ideally, we would have some
    // kind of machinery for rewiring the capabilities of restored backups, so that backup/restore
    // would not result in a completely broken collection. Alternatively, we could add a field
    // `Manifest.backupWarning` that we would display here if present.
    this._state.set({
      showWarning:
        "Backing up a collection does not back up any of its linked grains, " +
        "and restoring a collection does not automatically restore its links to grains. " +
        "Unless your goal is to debug a problem with this collection, downloading " +
        "a backup will not be very useful.",
    });
  } else {
    this._doBackup();
  }
});

Template.grainBackupPopup.helpers({
  state() {
    return Template.instance()._state.get();
  },
});

Template.grainBackupPopup.events({
  "click button[name=confirm]": function (event, instance) {
    instance._doBackup();
  },

  "click button[name=cancel]": function (event, instance) {
    // TODO(someday): Wire up some way to cancel the zip process on the server.
    instance._state.set({ canceled: true });

    // Close the popup.
    instance.data.reset();
  },
});

Template.grainRestartButton.events({
  "click button": function (event) {
    this.reset();
    const activeGrain = globalGrains.getActive();
    const grainId = activeGrain.grainId();

    Meteor.call("shutdownGrain", grainId, function (err) {
      if (err) {
        alert("Restart failed: " + err); // TODO(someday): make this better UI
      } else {
        const frames = document.getElementsByClassName("grain-frame");
        for (let i = 0; i < frames.length; i++) {
          const frame = frames[i];
          if (frame.dataset.grainid == grainId) {
            frame.src = frame.src;
          }
        }
      }
    });
  },
});

function selectElementContents(element) {
  if (document.body.createTextRange) {
    const range = document.body.createTextRange();
    range.moveToElementText(element);
    range.select();
  } else if (window.getSelection) {
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

function selectTargetContents(event) {
  event.preventDefault();
  selectElementContents(event.currentTarget);
}

Template.grainApiTokenPopup.events({
  "click .copy-me": selectTargetContents,
  "focus .copy-me": selectTargetContents,
  "submit .newApiToken": function (event) {
    event.preventDefault();
    const activeGrain = globalGrains.getActive();
    const grainId = activeGrain.grainId();
    activeGrain.setGeneratedApiToken("pending");
    const roleList = document.getElementById("api-token-role");
    // TODO(cleanup): avoid using global ids; select a child of the current template instead
    let assignment = { allAccess: null };
    if (roleList && roleList.selectedIndex > 0) {
      assignment = { roleId: roleList.selectedIndex - 1 };
    }

    Meteor.call("newApiToken", { accountId: Meteor.userId() }, grainId,
                document.getElementById("api-token-petname").value,
                assignment, { webkey: { forSharing: false } },
                function (error, result) {
      if (error) {
        activeGrain.setGeneratedApiToken(undefined);
        window.alert("Failed to create token.\n" + error);
        console.error(error.stack);
      } else {
        activeGrain.setGeneratedApiToken(
            window.location.protocol + "//" +
            globalDb.makeApiHost(result.token) + "#" + result.token);
      }
    });
  },

  "click #resetApiToken": function (event) {
    const activeGrain = globalGrains.getActive();
    activeGrain.setGeneratedApiToken(undefined);
  },

  "click button.revoke-token": function (event) {
    Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                { revoked: true });
  },

  "click .token-petname": function (event) {
    // TODO(soon): Find a less-annoying way to get this input, perhaps by allowing the user
    //   to edit the petname in place.
    const petname = window.prompt("Set new label:", this.petname);
    if (petname) {
      Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                  { petname: petname });
    }
  },
});

Template.grainSharePopup.events({
  "click .copy-me": selectTargetContents,
  "focus .copy-me": selectTargetContents,
  "click #share-grain-popup-closer": function (event) {
    Session.set("show-share-grain", false);
  },

  "click button.who-has-access": function (event, instance) {
    event.preventDefault();
    showConnectionGraph();
  },

  "click #privatize-grain": function (event) {
    Meteor.call("privatizeGrain", globalGrains.getActive().grainId());
  },

  "click a.open-non-anonymously": function (event) {
    event.preventDefault();
    globalTopbar.closePopup();
    globalGrains.getActive().reset();
    globalGrains.getActive().openSession();
  },
});

Template.shareWithOthers.onRendered(function () {
  if (globalDb.isDemoUser()) {
    activateElementTab(this.find("#shareable-link-tab-header"), this);
  }

  this.find("[role=tab][aria-selected=true]").focus();
});

const activateTargetTab = function (event, instance) {
  activateElementTab(event.currentTarget, instance);
};

const activateElementTab = function (elementToActivate, instance) {
  // Deactivate all tabs and all tab panels.
  instance.findAll("ul[role=tablist]>li[role=tab]").forEach(function (element) {
    element.setAttribute("aria-selected", false);
  });

  instance.findAll(".tabpanel").forEach(function (element) {
    element.setAttribute("aria-hidden", true);
  });

  // Activate the tab header the user selected.
  elementToActivate.setAttribute("aria-selected", true);
  // Show the corresponding tab panel.
  const idToShow = elementToActivate.getAttribute("aria-controls");
  const tabPanelToShow = instance.find("#" + idToShow);
  tabPanelToShow.setAttribute("aria-hidden", false);
};

Template.shareWithOthers.events({
  "click #send-invite-tab-header": activateTargetTab,
  "click #shareable-link-tab-header": activateTargetTab,
  "keydown [role=tab]": function (event, template) {
    if (event.keyCode == 38 || event.keyCode == 40) { // up and down arrows
      event.preventDefault();
    }

    const $focus = $(template.find(":focus"));
    const $items = template.$("[role=tab]:visible");
    const focusIndex = $items.index($focus);
    let newFocusIndex;
    if (event.keyCode == 37) { // left arrow
      event.preventDefault();
      newFocusIndex = focusIndex - 1;
      if (newFocusIndex == -1) {
        newFocusIndex = $items.length - 1;
      }
    } else if (event.keyCode == 39) { // right arrow
      event.preventDefault();
      newFocusIndex = focusIndex + 1;
      if (newFocusIndex >= $items.length) {
        newFocusIndex = 0;
      }
    } else if (event.keyCode == 13) { // Enter key
      event.preventDefault();
      activateTargetTab(event, template);
    }

    if (newFocusIndex != null) {
      $items.attr("tabindex", "-1");
      const $newFocus = $($items[newFocusIndex]);
      $newFocus.attr("tabindex", "0");
      $newFocus.focus();
    }
  },
});

Template.shareableLinkTab.events({
  "change .share-token-role": function (event, instance) {
    const success = instance.completionState.get().success;
    if (success) {
      const roleList = event.target;
      let assignment;
      if (roleList) {
        assignment = { roleId: roleList.selectedIndex };
      } else {
        assignment = { none: null };
      }

      Meteor.call("updateApiToken", success.id, { roleAssignment: assignment }, function (error) {
        if (error) {
          console.error(error.stack);
        }
      });
    }
  },

  "change .label": function (event, instance) {
    const success = instance.completionState.get().success;
    if (success) {
      const label = event.target.value;
      Meteor.call("updateApiToken", success.id, { petname: label }, function (error) {
        if (error) {
          console.error(error.stack);
        }
      });
    }
  },

  "submit form.new-share-token": function (event, instance) {
    event.preventDefault();
    if (!instance.completionState.get().clear) {
      return;
    }

    const currentGrain = globalGrains.getActive();
    const grainId = currentGrain.grainId();
    const roleList = event.target.getElementsByClassName("share-token-role")[0];
    let assignment;
    if (roleList) {
      assignment = { roleId: roleList.selectedIndex };
    } else {
      assignment = { none: null };
    }

    instance.completionState.set({ pending: true });
    Meteor.call("newApiToken", { accountId: Meteor.userId() }, grainId,
                event.target.getElementsByClassName("label")[0].value,
                assignment, { webkey: { forSharing: true } },
                function (error, result) {
      if (error) {
        console.error(error.stack);
      } else {
        result.url = getOrigin() + "/shared/" + result.token;
        instance.completionState.set({ success: result });
        // On the next render, .copy-me will exist, and we should focus it then.
        Meteor.defer(function () {
          const element = instance.find(".copy-me");
          element.focus();
          selectElementContents(element);
        });
      }
    });
  },

  "click .reset-share-token": function (event, instance) {
    instance.completionState.set({ clear: true });
    instance.find("form").reset();
    instance.find("form option[data-default-selected=true]").selected = true;
  },
});

Template.grainShareButton.onRendered(() => {
  if (!Meteor._localStorage.getItem("userNeedsShareAccessHint")) {
    return;
  }

  // Don't show hint on $mobile because the top bar isn't really a top bar in that case.
  if (window.innerWidth <= 900) {
    return;
  }

  let templateData = Template.instance();
  const activeGrain = globalGrains.getActive();
  let unsafeCurrentAppTitle = (activeGrain && activeGrain.appTitle()) || "";

  const currentPkgId = Grains.findOne({ _id: activeGrain.grainId() }).packageId;
  const possibleUserActions = UserActions.find({ packageId: currentPkgId }).fetch();
  let unsafeCurrentNounPhrase = "grain";
  // Frequently there is only 1 UserAction per package. If there is more than 1, then we go with
  // the default of "grain".
  if (possibleUserActions.length === 1) {
    const currentUserAction = possibleUserActions[0];
    unsafeCurrentNounPhrase = SandstormDb.nounPhraseForActionAndAppTitle(currentUserAction, unsafeCurrentAppTitle);
  }

  // Use DOM to escape HTML, so it is safe to pass to intro.js.
  let div = document.createElement("div");
  div.appendChild(document.createTextNode(unsafeCurrentAppTitle));
  let escapedCurrentAppTitle = div.innerHTML;

  div = document.createElement("div");
  div.appendChild(document.createTextNode(unsafeCurrentNounPhrase));
  let escapedCurrentNounPhrase = div.innerHTML;

  const intro = templateData.intro = introJs();
  let introOptions = {
    steps: [
      {
        element: document.querySelector(".share"),
        intro: "You've created your first " + escapedCurrentAppTitle + " " +
          escapedCurrentNounPhrase + ". When you're ready, you can share it with others. Enjoy!",
      },
    ],
    highlightClass: "introjs-black-helperLayer",
    tooltipPosition: "bottom",
    positionPrecedence: ["bottom", "top", "left", "right"],
    showStepNumbers: false,
    exitOnOverlayClick: true,
    overlayOpacity: 0.7,
    showBullets: false,
    disableInteraction: false,
    doneLabel: "Got it",
  };

  intro.setOptions(introOptions);
  const dismissHint = () => {
    Meteor._localStorage.removeItem("userNeedsShareAccessHint");
  };

  intro.oncomplete(dismissHint);
  intro.onexit(dismissHint);

  intro.start();

  // HACK: Resize after 2 seconds, in case the grain size arrived late and caused the UI to reflow.
  Meteor.setTimeout(() => window.dispatchEvent(new Event("resize")), 2000);
});

Template.grainPowerboxOfferPopup.events({
  "click button.dismiss": function (event) {
    const data = Template.instance().data;
    data.onDismiss();
  },

  "click .copy-me": selectTargetContents,
  "focus .copy-me": selectTargetContents,
});

Template.grainSharePopup.helpers({
  incognito: function () {
    return globalGrains.getActive().isIncognito();
  },

  currentTokenUrl: function () {
    let token = globalGrains.getActive().token();
    if (token) {
      return getOrigin() + "/shared/" + token;
    }
  },

  currentGrain: function () {
    return globalGrains.getActive();
  },
});

Template.grainInMyTrash.events({
  "click button.restore-from-trash": function (event, instance) {
    const grain = globalGrains.getActive();
    const data = Template.currentData();
    Meteor.call("moveGrainsOutOfTrash", [data.grainId], function (err, result) {
      if (err) {
        console.error(err.stack);
      } else {
        grain.reset(!grain.isIncognito());
        grain.openSession();
      }
    });
  },
});

Template.wrongUser.helpers({
  unclickedMessage: function () {
    if (Meteor.userId()) {
      return "Click to sign out of your current session and sign in as the above user.";
    } else {
      return "Click to sign in.";
    }
  },
});

Template.requestAccess.onCreated(function () {
  this._status = new ReactiveVar({ showButton: true });
  this._grain = this.data.grainView;

  this.autorun(() => {
    Meteor.userId(); // Read this value so that we resubscribe on login.
    const grainId = this._grain.grainId();
    this.subscribe("requestingAccess", grainId);
    const granted = GrantedAccessRequests.findOne({ grainId: grainId });
    if (granted && !this._grain.token()) {
      this._grain.reset(false);
      this._grain.openSession();
    }
  });
});

Template.requestAccess.events({
  "click button.request-access": function (event, instance) {
    let grainId = instance._grain.grainId();
    Meteor.call("requestAccess", getOrigin(), grainId, function (error, result) {
      if (error) {
        instance._status.set({ error: error });
      } else {
        instance._status.set({ success: true });
      }
    });

    instance._status.set({ waiting: true });
  },
});

Template.requestAccess.helpers({
  status: function () {
    return Template.instance()._status.get();
  },
});

Template.grainView.helpers({
  unpackedGrainState: function () {
    return mapGrainStateToTemplateData(this);
  },

  closeSignInOverlay() {
    return () => {
      const grain = globalGrains.getActive();
      grain.disableSigninOverlay();
    };
  },

  idPrefix: function () {
    // Prefix to add to the iframe id, for testing purposes.
    return this.isPowerbox ? "powerbox-" : "";
  },
});

Template.grainView.events({
  "click .reveal-identity-button": function (event, instance) {
    this.grainView.revealIdentity();
  },

  "click .incognito-button": function (event, instance) {
    this.grainView.doNotRevealIdentity();
  },
});

Template.grain.helpers({
  currentGrain: function () {
    return globalGrains.getActive();
  },

  hasAccess: function () {
    const grain = globalGrains.getActive();
    return grain && !!Sessions.findOne(grain.sessionId());
  },

  isOwner: function () {
    const current = globalGrains.getActive();
    return current && current.isOwner();
  },

  grainSize: function () {
    const current = globalGrains.getActive();
    const sizeBytes = current && current.size();
    if (sizeBytes !== undefined) {
      return "(" + prettySize(sizeBytes) + ")";
    } else {
      return "";
    }
  },

  setGrainWindowTitle:  function () {
    const current = globalGrains.getActive();
    if (current) {
      current.updateDocumentTitle();
    }
  },

  displayWebkeyButton: function () {
    const grain = globalGrains.getActive();
    return Meteor.userId() || (grain && !grain.isOldSharingModel());
  },

  displayTrashButton: function () {
    if (!Meteor.userId()) return false;

    const grainview = globalGrains.getActive();
    if (!grainview) return false;
    const grainId = grainview.grainId();
    const grain = Grains.findOne({
      _id: grainId,
      userId: Meteor.userId(),
      trashed: { $exists: false },
    });

    if (grain) return true;

    return !!ApiTokens.findOne({
      grainId: grainId,
      "owner.user.accountId": Meteor.userId(),
      trashed: { $exists: false },
    });
  },

  showPowerboxOffer: function () {
    const current = globalGrains.getActive();
    return current && current.showPowerboxOffer();
  },

  powerboxOfferData: function () {
    const current = globalGrains.getActive();
    return current && current.powerboxOfferData();
  },

  showPowerboxRequest: function () {
    const current = globalGrains.getActive();
    return current && current.showPowerboxRequest();
  },

  powerboxRequestData: function () {
    const current = globalGrains.getActive();
    return current && current.powerboxRequestData();
  },

  cancelPowerboxRequest: function () {
    return () => {
      const current = globalGrains.getActive();
      current.setPowerboxRequest(undefined);
      return "remove";
    };
  },
});

Template.grainTitle.helpers({
  fullTitle: function () {
    const grain = globalGrains.getActive();
    return (grain && grain.fullTitle()) || { title: "(unknown grain)" };
  },

  hasSubtitle: function () {
    return !!(this.was || this.renamedFrom);
  },
});

Template.grainApiTokenPopup.helpers({
  displayToken: function () {
    return !this.revoked && !this.expiresIfUnused && !this.parentToken;
  },

  existingTokens: function () {
    if (!Meteor.userId()) return null;

    const current = globalGrains.getActive();
    return current && ApiTokens.find({
      grainId: current.grainId(),
      accountId: Meteor.userId(),
      forSharing: { $ne: true },
      $or: [
        { owner: { webkey: null } },
        { owner: { $exists: false } },
      ],
      expiresIfUnused: null,
    });
  },

  generatedApiToken: function () {
    const current = globalGrains.getActive();
    return current && current.generatedApiToken();
  },

  generatedApiTokenPending: function () {
    const current = globalGrains.getActive();
    return (current && current.generatedApiToken()) == "pending";
  },

  viewInfo: function () {
    const current = globalGrains.getActive();
    return current && current.viewInfo();
  },
});

const getGrainTitle = function (grainId) {
  let title = "(Unknown grain)";
  const grain = Grains.findOne({ _id: grainId });
  if (grain && grain.title) {
    title = grain.title;
  }

  if (!grain || grain.userId !== Meteor.userId()) {
    const sharerToken = ApiTokens.findOne(
      { grainId: grainId, },
      { sort: { lastUsed: -1 } }
    );

    if (sharerToken) {
      const ownerData = sharerToken.owner.user;
      if (ownerData.title) {
        title = ownerData.title;
      } else if (ownerData.upstreamTitle) {
        title = ownerData.upstreamTitle;
      }
    }
  }

  return title;
};

Template.whoHasAccessPopup.onCreated(function () {
  const _this = this;
  this.subscribe("contactProfiles", true);
  const currentGrain = globalGrains.getActive();
  _this.grainId = currentGrain.grainId();
  _this.transitiveShares = new ReactiveVar(null);
  _this.downstreamTokensById = new ReactiveVar({});
  _this.isReady = new ReactiveVar(false);
  this.resetTransitiveShares = function () {
    Meteor.call("transitiveShares", null, _this.grainId,
                function (error, downstream) {
      if (error) {
        console.error(error.stack);
        _this.isReady.set(true);
      } else {
        const downstreamTokensById = {};
        const sharesByAccountRecipient = {};
        const sharesByGrainRecipient = {};
        downstream.forEach(function (token) {
          downstreamTokensById[token._id] = token;
          let mapToUpdate;
          let recipient;
          if (Match.test(token.owner, { user: Match.ObjectIncluding({ accountId: String }) })) {
            mapToUpdate = sharesByAccountRecipient;
            recipient = token.owner.user.accountId;
          } else if (Match.test(token.owner,
                                { grain: Match.ObjectIncluding({ grainId: String }) })) {
            mapToUpdate = sharesByGrainRecipient;
            recipient = token.owner.grain.grainId;
          }

          if (mapToUpdate) {
            if (!mapToUpdate[recipient]) {
              mapToUpdate[recipient] = {
                recipient: recipient,
                dedupedShares: [],
                allShares: [],
              };
            }

            mapToUpdate[recipient].allShares.push(token);
            const dedupedShares = mapToUpdate[recipient].dedupedShares;
            if (!dedupedShares.some((share) => share.accountId === token.accountId)) {
              dedupedShares.push(token);
            }
          }
        });

        let accountOwnedShares = _.values(sharesByAccountRecipient);
        if (accountOwnedShares.length == 0) {
          accountOwnedShares = { empty: true };
        }

        let grainOwnedShares = _.values(sharesByGrainRecipient);
        if (grainOwnedShares.length == 0) {
          grainOwnedShares = { empty: true };
        }

        _this.transitiveShares.set({ accountOwnedShares, grainOwnedShares, });
        _this.downstreamTokensById.set(downstreamTokensById);

        _this.isReady.set(true);
      }
    });
  };

  this.resetTransitiveShares();
});

Template.whoHasAccessPopup.events({
  "change .share-token-role": function (event, instance) {
    const roleList = event.target;
    let assignment;
    if (roleList) {
      assignment = { roleId: roleList.selectedIndex };
    } else {
      assignment = { none: null };
    }

    Meteor.call("updateApiToken", roleList.getAttribute("data-token-id"),
                { roleAssignment: assignment }, function (error) {
      if (error) {
        console.error(error.stack);
      }
    });
  },

  "click button.revoke-token": function (event, instance) {
    Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                { revoked: true });
    instance.resetTransitiveShares();
  },

  "click table.people button.revoke-access": function (event, instance) {
    const recipient = event.currentTarget.getAttribute("data-recipient");
    const transitiveShares = instance.transitiveShares.get();
    const accountOwnedShares = transitiveShares.accountOwnedShares;
    const tokensById = instance.downstreamTokensById.get();
    const recipientShares = _.findWhere(accountOwnedShares, { recipient: recipient });
    const recipientTokens = _.where(recipientShares.allShares, { accountId: Meteor.userId() });

    // Two cases:
    // 1. All of the tokens are direct shares. Easy. Just revoke them.
    // 2. Some of the links are child tokens. For each, we walk up the chain of parents to the
    //    root. Then we walk downwards to see whether any other accounts would be immediately
    //    affected by revoking those roots. We then collect that data and display it in a
    //    confirmation dialog.

    let directTokens = [];
    // Direct shares from the current account to the recipient.

    let rootTokens = [];
    // Roots of chains of child tokens starting at the current account and leading to the
    // recipient.

    recipientTokens.forEach((token) => {
      if (token.parentToken) {
        let currentToken = token;
        do {
          currentToken = tokensById[token.parentToken];
        } while (currentToken.parentToken);

        rootTokens.push(currentToken);
      } else {
        directTokens.push(token);
      }
    });

    if (rootTokens.length > 0) {
      // Some of the shares are not direct.

      let tokensByParent = {};
      for (let id in tokensById) {
        let token = tokensById[id];
        if (token.parentToken) {
          if (!tokensByParent[token.parentToken]) {
            tokensByParent[token.parentToken] = [];
          }

          tokensByParent[token.parentToken].push(token);
        }
      }

      const otherAffectedAccounts = {};
      const affectedGrains = {};
      const tokenStack = rootTokens.slice(0);
      while (tokenStack.length > 0) {
        let current = tokenStack.pop();
        if (Match.test(current.owner,
                       { user: Match.ObjectIncluding({ accountId: String }) })) {
          if (current.owner.user.accountId != recipient) {
            otherAffectedAccounts[current.owner.user.accountId] = true;
          }
        } else {
          if (Match.test(current.owner,
                         { grain: Match.ObjectIncluding({ grainId: String }) })) {
            affectedGrains[current.owner.grain.grainId] = true;
          }

          if (tokensByParent[current._id]) {
            let children = tokensByParent[current._id];
            children.forEach(child => {
              tokenStack.push(child);
            });
          }
        }
      }

      const recipientAccount = ContactProfiles.findOne({ _id: recipient });
      const recipientName = (recipientAccount && recipientAccount.profile.name) ||
          "Unknown User";
      const singular = rootTokens.length == 1;

      const tokenLabels = _.pluck(rootTokens, "petname")
          .map(petname => petname || "Unlabeled Link")
          .map(petname => "\"" + petname + "\"")
          .join(", ");

      let confirmText = "This will revoke the following sharing link" + (singular ? "" : "s") +
          ":\n\n    " + tokenLabels + "\n\n";

      let othersNote = "(No signed-in user other than " + recipientName + " has opened " +
          (singular ? "this link" : "these links") + " yet.)";
      if (Object.keys(otherAffectedAccounts).length > 0) {
        const othersNames = Object.keys(otherAffectedAccounts)
            .map(accountId => ContactProfiles.findOne({ _id: accountId }))
            .map(account => (account && account.profile.name) || "Unknown User")
            .join(", ");
        othersNote = (singular ? "This link has" : "These links have") +
          " also been opened by:\n\n    " + othersNames;
      }

      if (Object.keys(affectedGrains).length > 0) {
        const grainNames = Object.keys(affectedGrains)
            .map(grainId => getGrainTitle(grainId))
            .join(", ");
        othersNote = othersNote + "\n\n" + (singular ? "This link is" : "These links are") +
          " used by the following grains:\n\n" + grainNames;
      }

      if (window.confirm(confirmText + othersNote)) {
        rootTokens.forEach((token) => {
          Meteor.call("updateApiToken", token._id, { revoked: true });
        });
      } else {
        // Cancel.
        return;
      }
    }

    directTokens.forEach((token) => {
      Meteor.call("updateApiToken", token._id, { revoked: true });
    });

    instance.resetTransitiveShares();
  },

  "click table.grains button.revoke-access": function (event, instance) {
    const recipient = event.currentTarget.getAttribute("data-recipient");
    const transitiveShares = instance.transitiveShares.get();
    const grainOwnedShares = transitiveShares.grainOwnedShares;
    const tokensById = instance.downstreamTokensById.get();
    const recipientShares = _.findWhere(grainOwnedShares, { recipient: recipient });
    const recipientTokens = _.where(recipientShares.allShares, { accountId: Meteor.userId() });

    recipientTokens.forEach((token) => {
      Meteor.call("updateApiToken", token._id, { revoked: true });
    });

    instance.resetTransitiveShares();
  },

  "click .token-petname": function (event, instance) {
    // TODO(soon): Find a less-annoying way to get this input, perhaps by allowing the user
    //   to edit the petname in place.
    const petname = window.prompt("Set new label:", this.petname);
    if (petname) {
      Meteor.call("updateApiToken", event.currentTarget.getAttribute("data-token-id"),
                  { petname: petname });
    }

    instance.resetTransitiveShares();
  },
});

function isEmptyPermissionSet(permissionSet) {
  if (!permissionSet) {
    return true;
  }

  for (let ii = 0; ii < permissionSet.length; ++ii) {
    if (permissionSet[ii]) {
      return false;
    }
  }

  return true;
}

Template.whoHasAccessPopup.helpers({
  existingShareTokens: function () {
    if (Meteor.userId()) {
      return ApiTokens.find({
        grainId: Template.instance().grainId,
        accountId: Meteor.userId(),
        forSharing: true,
        $or: [
          { owner: { webkey: null } },
          { owner: { $exists: false } },
        ],
      }).fetch();
    }
  },

  isCurrentAccount: function (accountId) {
    return accountId === Meteor.userId();
  },

  getPetname: function () {
    if (this.petname) {
      return this.petname;
    } else {
      return "Unlabeled Link";
    }
  },

  displayName: function (accountId) {
    let account = ContactProfiles.findOne({ _id: accountId });
    if (!account) {
      account = Meteor.users.findOne({ _id: accountId });
    }

    if (account) {
      return account.profile.name;
    } else {
      return "Unknown User (" + accountId + ")";
    }
  },

  grainTitle: function (grainId) {
    return getGrainTitle(grainId);
  },

  transitiveShares: function () {
    return Template.instance().transitiveShares.get();
  },

  indexedRoles: function () {
    const result = [];
    const instance = Template.instance();
    const currentGrain = globalGrains.getActive();
    const roles = currentGrain.viewInfo().roles;
    for (let ii = 0; ii < roles.length; ++ii) {
      result.push({ idx: ii, title: roles[ii].title, verbPhrase: roles[ii].verbPhrase });
    }

    return result;
  },

  roleText: function () {
    if (this.verbPhrase) {
      return this.verbPhrase.defaultText;
    } else {
      return "is " + this.title.defaultText;
    }
  },

  hasCustomRole: function (token) {
    const role = token.roleAssignment;
    if ("roleId" in role &&
        isEmptyPermissionSet(role.addPermissions) &&
        isEmptyPermissionSet(role.removePermissions)) {
      return false;
    }

    return true;
  },

  hasCurrentRole: function (token) {
    const role = token.roleAssignment;
    if ("roleId" in role && role.roleId == this.idx &&
        isEmptyPermissionSet(role.addPermissions) &&
        isEmptyPermissionSet(role.removePermissions)) {
      return true;
    }

    return false;
  },

  displayToken: function () {
    return !this.revoked && !this.expiresIfUnused && !this.parentToken;
  },

  viewInfo: function () {
    const activeGrain = globalGrains.getActive();
    return activeGrain && activeGrain.viewInfo();
  },

  isReady: function () {
    return Template.instance().isReady.get();
  },
});

Template.selectRole.helpers({
  roleText: function () {
    if (this.verbPhrase) {
      return this.verbPhrase.defaultText;
    } else {
      return "is " + this.title.defaultText;
    }
  },
});

Template.shareableLinkTab.onCreated(function () {
  this.completionState = new ReactiveVar({ clear: true });
});

Template.emailInviteTab.onCreated(function () {
  this.completionState = new ReactiveVar({ clear: true });
  this.contacts = new ReactiveVar([]);
  this.grain = globalGrains.getActive();
});

Template.emailInviteTab.onDestroyed(function () {
  Session.set("share-grain-" + Template.instance().grain.grainId(), undefined);
});

Template.shareableLinkTab.helpers({
  completionState: function () {
    const instance = Template.instance();
    return instance.completionState.get();
  },
});
Template.emailInviteTab.helpers({
  isDemoUser: function () {
    return globalDb.isDemoUser();
  },

  completionState: function () {
    const instance = Template.instance();
    return instance.completionState.get();
  },

  contacts: function () {
    return Template.instance().contacts;
  },

  preselectedAccountId: function () {
    return Session.get("share-grain-" + Template.instance().grain.grainId());
  },

  invitationExplanation: function () {
    const primaryEmail = globalDb.getPrimaryEmail(Meteor.userId());
    if (primaryEmail) {
      return "Invitation will be from " + primaryEmail;
    } else {
      return null;
    }
  },
});

Template.emailInviteTab.events({
  "submit form.email-invite": function (event, instance) {
    event.preventDefault();
    return false;
  },

  "click form.email-invite button": function (event, instance) {
    event.preventDefault();
    if (!instance.completionState.get().clear) {
      return;
    }

    const grainId = instance.data.grainId;
    const title = instance.data.title;

    const roleList = instance.find(".share-token-role");
    let assignment;
    if (roleList) {
      assignment = { roleId: roleList.selectedIndex };
    } else {
      assignment = { none: null };
    }

    const message = instance.find(".personal-message").value;
    instance.completionState.set({ pending: true });

    const currentGrain = globalGrains.getActive();

    const contacts = instance.contacts.get();
    const emails = instance.find("input.emails");
    const emailsValue = emails.value;
    if (emailsValue) {
      if (emailsValue.match(/.+\@.+\..+/)) {
        contacts.push({
          _id: emailsValue,
          profile: {
            service: "email",
            name: emailsValue,
            intrinsicName: emailsValue,
            pictureUrl: "/email.svg",
          },
          isDefault: true,
        });
        instance.contacts.set(contacts);
        emails.value = "";
      } else {
        instance.completionState.set(
          { error: "Unknown user \"" + emailsValue + "\". Try entering an e-mail address." });
        return;
      }
    }

    Meteor.call("inviteUsersToGrain", getOrigin(), null,
                grainId, title, assignment, contacts, message, function (error, result) {
      if (error) {
        instance.completionState.set({ error: error.toString() });
      } else {
        if (result.failures.length > 0) {
          let message = "Failed to send to: ";
          for (let ii = 0; ii < result.failures.length; ++ii) {
            console.error(result.failures[ii].error);
            if (ii != 0) {
              message += ", ";
            }

            message += result.failures[ii].contact.profile.name;
            const warning = result.failures[ii].warning;
            if (warning) {
              message += ". " + warning;
            }
          }

          instance.completionState.set({ error: message });
        } else {
          instance.completionState.set({ success: "success" });
        }
      }
    });
  },

  "click .reset-invite": function (event, instance) {
    instance.contacts.set([]);
    instance.completionState.set({ clear: true });
    instance.find("form").reset();
    instance.find("form option[data-default-selected=true]").selected = true;
  },

  "click .start-over-invite": function (event, instance) {
    instance.completionState.set({ clear: true });
  },
});

Template.grainPowerboxOfferPopup.onCreated(function () {
  let sessionToken = null;
  if (Router.current().route.getName() === "shared") {
    sessionToken = Router.current().params.token;
  }

  this._state = new ReactiveVar({ waiting: true });
  const offer = this.data.offer;
  const sessionId = this.data.sessionId;

  if (offer && offer.uiView && offer.uiView.tokenId) {
    // If this is an offer of a UiView, immediately dismiss the popup and open the grain.
    const apiToken = ApiTokens.findOne(offer.uiView.tokenId);
    if (apiToken && apiToken.grainId) {
      Meteor.call("finishPowerboxOffer", sessionId, (err) => {
        if (err) {
          this._state.set({ error: err });
        }
      });

      Router.go("grain", { grainId: apiToken.grainId });
    }
  } else if (offer && offer.uiView && offer.uiView.token) {
    Meteor.call("acceptPowerboxOffer", sessionId, offer.uiView.token, sessionToken,
                (err, result) => {
      if (err) {
        this._state.set({ error: err });
      } else {
        Meteor.call("finishPowerboxOffer", sessionId, (err) => {
          if (err) {
            this._state.set({ error: err });
          }
        });

        Router.go("shared", { token: result });
      }
    });
  } else if (offer && offer.token) {
    Meteor.call("acceptPowerboxOffer", sessionId, offer.token, sessionToken, (err, result) => {
      if (err) {
        this._state.set({ error: err });
      } else {
        this._state.set({
          webkey: window.location.protocol + "//" + globalDb.makeApiHost(result) + "#" + result,
        });
      }
    });
  }
});

Template.grainPowerboxOfferPopup.helpers({
  state: function () {
    return Template.instance()._state.get();
  },
});

// Send a keep-alive for each grain every now and then.
Meteor.setInterval(function () {
  const grains = globalGrains.getAll();
  if (!grains) return;

  // Meteor has an exponential backoff of up to 5 minutes for reconnect. This is unnacceptable
  // for us, since we rely on Sessions being re-established in under 60s.
  if (Meteor.status().status === "waiting") {
    console.log("Sandstorm is trying to reconnect...");
    Meteor.reconnect();
  }

  grains.forEach(function (grain) {
    if (grain.sessionId()) {
      // TODO(soon):  Investigate what happens in background tabs.  Maybe arrange to re-open the
      //   app if it dies while in the background.
      Meteor.call("keepSessionAlive", grain.sessionId(), function (error, result) {
        // Sessions will automatically resume if possible, otherwise they will refresh.
      });
    }
  });
}, 60000);

const memoizedNewApiToken = {};
// Maps sha256(JSON.stringify(parameters)) -> {timestamp, promise}
//
// This memoizes calls to the Meteor method "newApiToken", so that multiple calls in rapid
// succession will not create multiple tokens. `parameters` above is an array containing the
// calls parameters in order (excluding the method name and callback), and `promise` is a promise
// for the result of the call.

// Message handler for Sandstorm's client-side postMessage API.
Meteor.startup(function () {
  const messageListener = function (event) {
    if (event.origin === getOrigin()) {
      // Meteor likes to postMessage() to itself sometimes, so we ignore these messages.
      return;
    }

    // Look up the grain that this postmessage came from, so we can map behavior into that
    // particular grain's state
    const senderGrain = globalGrains.getByOrigin(event.origin);
    if (!senderGrain) {
      // We got a postMessage from an origin that is not a grain we currently believe is open.
      // Ignore it. (It may be aimed at some other message listener registered elsewhere...)
      return;
    }

    if (event.data.setPath || event.data.setPath === "") {
      const path = event.data.setPath || "/";
      check(path, String);
      check(path.charAt(0), "/");
      // TODO(security): More sanitization of this path. E.g. reject "/../../".
      senderGrain.setPath(path);
      currentPathChanged();
    } else if (event.data.startSharing) {
      // Allow the current grain to request that the "Share Access" menu be shown.
      // Only show this popup if no other popup is currently active.
      // TODO(security): defend against malicious apps spamming this call, blocking all other UI.
      const currentGrain = globalGrains.getActive();
      if (senderGrain === currentGrain && !globalTopbar.isPopupOpen()) {
        globalTopbar.openPopup("share", true);
      }
    } else if (event.data.overlaySignin) {
      if (event.data.overlaySignin.disable) {
        senderGrain.disableSigninOverlay();
      } else {
        const creatingAccount = !!event.data.overlaySignin.creatingAccount;
        senderGrain.showSigninOverlay(creatingAccount);
      }
    } else if (event.data.requestLogout) {
      if (isStandalone()) {
        // Only standalone grains get to ask the shell to log them out, and then, only because their
        // login state is tracked separately.  In the fullness of time, maybe we should unify the
        // login state, in which case we'll probably want to disable this option lest a malicious
        // grain be able to DoS a user.
        logoutSandstorm();
      }
    } else if (event.data.showConnectionGraph) {
      // Allow the current grain to request that the "Who has access" dialog be shown.
      // Only show this popup if no other popup is currently active.
      // TODO(security): defend against malicious apps spamming this call, blocking all other UI.
      const currentGrain = globalGrains.getActive();
      if (senderGrain === currentGrain && !globalTopbar.isPopupOpen()) {
        showConnectionGraph();
      }
    } else if (event.data.setTitle || event.data.setTitle === "") {
      senderGrain.setFrameTitle(event.data.setTitle);
    } else if (event.data.renderTemplate) {
      // Request creation of a single-use template with a privileged API token.
      // Why?  Apps should not be able to obtain capabilities-as-keys to
      // themselves directly, because those can be leaked through an
      // arbitrary bit stream or covert channel.  However, apps often need a
      // way to provide instructions to users to copy/paste with some
      // privileged token contained within.  By providing this templating in
      // the platform, we can ensure that the token is only visible to the
      // shell's origin.
      const call = event.data.renderTemplate;
      check(call, Object);
      const rpcId = call.rpcId;

      try {
        check(call, {
          rpcId: String,
          template: String,
          petname: Match.Optional(String),
          roleAssignment: Match.Optional(roleAssignmentPattern),
          forSharing: Match.Optional(Boolean),
          clipboardButton: Match.Optional(Match.OneOf(undefined, null, "left", "right")),
          unauthenticated: Match.Optional(Object),
          // Note: `unauthenticated` will be validated on the server. We just pass it through
          //   here.
          clientapp: Match.Optional(Match.Where(function (clientapp) {
            check(clientapp, String);
            // rfc3986 specifies schemes as:
            // scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )
            return clientapp.search(/[^a-zA-Z0-9+-.]/) === -1;
          })),
        });
      } catch (error) {
        event.source.postMessage({ rpcId: rpcId, error: error.toString() }, event.origin);
        return;
      }

      const template = call.template;
      let petname = "connected external app";
      if (call.petname) {
        petname = call.petname;
      }

      let assignment = { allAccess: null };
      const clipboardButton = call.clipboardButton;
      if (call.roleAssignment) {
        assignment = call.roleAssignment;
      }

      const forSharing = call.forSharing ? call.forSharing : false;
      // Tokens expire by default in 5 minutes from generation date
      const selfDestructDuration = 5 * 60 * 1000;

      let clientapp = call.clientapp;
      if (clientapp) {
        clientapp = clientapp.toLowerCase();
      }

      let provider;
      if (Router.current().route.getName() === "shared") {
        provider = { rawParentToken: Router.current().params.token };
      } else {
        provider = { accountId: Meteor.userId() };
      }

      const owner = {
        webkey: {
          forSharing: forSharing,
          expiresIfUnusedDuration: selfDestructDuration,
        },
      };

      const params = [
        provider, senderGrain.grainId(), petname, assignment, owner, call.unauthenticated,
      ];

      const memoizeKey = SHA256(JSON.stringify(params));
      let memoizeResult = memoizedNewApiToken[memoizeKey];
      if (memoizeResult && (Date.now() - memoizeResult.timestamp > selfDestructDuration / 2)) {
        // Memoized result is too old. Discard.
        memoizeResult = undefined;
      }

      if (!memoizeResult) {
        memoizedNewApiToken[memoizeKey] = memoizeResult = {
          timestamp: Date.now(),
          promise: new Promise(function (resolve, reject) {
            const callback = (err, result) => {
              if (err) {
                reject(err);
              } else {
                resolve(result);
              }
            };

            Meteor.call.apply(Meteor, ["newApiToken"].concat(params, callback));
          }),
        };
      }

      memoizeResult.promise.then((result) => {
        const tokenId = result.token;
        // Generate random key id2.
        const id2 = Random.secret();
        // Store apitoken id1 and template in session storage in the offer
        // template namespace under key id2.
        const key = "offerTemplate" + id2;
        const host = globalDb.makeApiHost(tokenId);
        const grain = senderGrain;
        const grainTitle = grain.title();
        // grainTitleSlug is the grain title with url-unsafe characters replaced
        let grainTitleSlug = grainTitle.toLowerCase().trim();
        grainTitleSlug = grainTitleSlug.replace(/\s+/g, "-")
                                       .replace(/[^\w\-]+/g, "")
                                       .replace(/\-\-+/g, "-")
                                       .replace(/^-+/, "")
                                       .replace(/-+$/, "");
        const renderedTemplate = template.replace(/\$API_TOKEN/g, tokenId)
                                         .replace(/\$API_HOST/g, host)
                                         .replace(/\$GRAIN_TITLE_SLUG/g, grainTitleSlug);
        let link = undefined;
        if (clientapp) {
          link = `clientapp-${clientapp}:${window.location.protocol}//${host}#${tokenId}`;
        }

        sessionStorage.setItem(key, JSON.stringify({
            token: tokenId,
            renderedTemplate: renderedTemplate,
            clipboardButton: clipboardButton,
            expires: Date.now() + selfDestructDuration,
            host,
            link,
          })
        );

        // Send message to event.source with URL containing id2
        // TODO(someday): Send back the tabId that requests to this token will use? Could be
        //   useful.
        templateLink = window.location.origin + "/offer-template.html#" + id2;
        event.source.postMessage({ rpcId: rpcId, uri: templateLink }, event.origin);
      }, (error) => {
        event.source.postMessage({ rpcId: rpcId, error: error.toString() }, event.origin);
      });
    } else if (event.data.powerboxRequest) {
      const powerboxRequest = event.data.powerboxRequest;
      check(powerboxRequest, {
        // TODO: be more strict, and check more fields, once the test apps are more conformant
        rpcId: Match.Any,
        query: Match.Optional([String]),
        saveLabel: Match.Optional(Match.ObjectIncluding({ defaultText: String })),
      });

      const powerboxRequestInfo = {
        source: event.source,
        origin: event.origin,
        // We'll need these to post a reply message

        rpcId: powerboxRequest.rpcId,
        query: powerboxRequest.query,
        saveLabel: powerboxRequest.saveLabel,
        // These data come from the grain

        sessionId: senderGrain.sessionId(),
        grainId: senderGrain.grainId(),
        // Attach grain context to the request.

        onCompleted: function () { globalTopbar.closePopup(); },
        // Allow the grain to close the popup when we've completed the request.
      };
      const requestContext = new SandstormPowerboxRequest(globalDb, powerboxRequestInfo, GrainView);
      senderGrain.setPowerboxRequest(requestContext);
      // Note that we don't do openPopup() here because the template will be redrawn to create the
      // powerbox popup with startOpen=true.
    } else {
      console.log("postMessage from app not understood: ", event.data);
      console.log(event);
    }
  };

  window.addEventListener("message", messageListener, false);
});

Template.grainLogContents.onRendered(function () {
  this.autorun(() => {
    // Rerun onRenderedHook whenever the data changes
    Template.currentData();
    this.data.onRenderedHook && this.data.onRenderedHook();
  });
});

Template.grainLog.onCreated(function () {
  this.shouldScroll = true;
  this.renderedYet = false;

  this.forceScrollBottom = () => {
    this.lastNode.scrollTop = this.lastNode.scrollHeight;
    this.shouldScroll = true;
  };

  this.maybeScrollToBottom = () => {
    if (this.shouldScroll && this.renderedYet) {
      this.forceScrollBottom();
    }
  };

  this.saveShouldScroll = () => {
    const messagePane = this.lastNode;
    this.shouldScroll = (messagePane.clientHeight + messagePane.scrollTop + 5 >= messagePane.scrollHeight);
  };

  this.resizeHandler = (evt) => {
    this.maybeScrollToBottom();
  };

  window.addEventListener("resize", this.resizeHandler);
});

Template.grainLog.onRendered(function () {
  if (!this.renderedYet) {
    this.renderedYet = true;
    this.maybeScrollToBottom();
  }
});

Template.grainLog.onDestroyed(function () {
  window.removeEventListener("resize", this.resizeHandler);
});

Template.grainLog.events({
  "scroll .grainlog-contents"(evt) {
    const instance = Template.instance();
    instance.saveShouldScroll();
  },
});

Template.grainLog.helpers({
  maybeScrollToBottom() {
    const instance = Template.instance();
    return () => {
      instance.maybeScrollToBottom();
    };
  },
});

Router.map(function () {
  this.route("apps", {
    path: "/apps",
    waitOn: function () { return globalSubs; },

    data: function () {
      if (!this.ready()) return;
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        Router.go("root", {}, { replaceState: true });
      }

      return new SandstormAppList(globalDb, globalQuotaEnforcer);
    },
  });
  this.route("newGrainRedirect", {
    // The path /grain/new used to be where you would go to create new grains.
    // Its functionality has been superceded by the apps route, so redirect in
    // case anyone has the old link saved somewhere.
    path: "/grain/new",
    onBeforeAction: function () {
      Router.go("apps", {}, { replaceState: true });
    },
  });
  this.route("grains", {
    path: "/grain",
    waitOn: function () { return globalSubs; },

    data: function () {
      if (!this.ready()) return;
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        Router.go("root", {}, { replaceState: true });
      }

      return {
        _db: globalDb,
        _quotaEnforcer: globalQuotaEnforcer,
        _staticHost: globalDb.makeWildcardHost("static"),
        viewTrash: this.getParams().hash === "trash",
      };
    },
  });
  this.route("grain", {
    path: "/grain/:grainId/:path(.*)?",
    loadingTemplate: "loadingNoMessage",

    waitOn: function () {
      return globalSubs;
    },

    onBeforeAction: function () {
      // Don't do anything for non-account users.
      if (Meteor.userId() && !Meteor.user().loginCredentials) return;

      // Only run the hook once.
      if (this.state.get("beforeActionHookRan")) return this.next();

      Tracker.nonreactive(() => {
        this.state.set("beforeActionHookRan", true);
        const grainId = this.params.grainId;

        let initialPopup = null;
        let shareGrain = Session.get("share-grain-" + grainId);
        if (shareGrain) {
          initialPopup = "share";
        }

        const path = "/" + (this.params.path || "") + (this.originalUrl.match(/[#?].*$/) || "");

        // The element we need to attach our Blaze view to may not exist yet.
        // In that case, defer creating the GrainView until we're sure it's
        // had a chance to render.
        const openView = function openView() {
          // If the grain is already open in a tab, switch to that tab. We have to re-check this
          // every time we defer to avoid race conditions (especially at startup, with the
          // restore-last-opened code).
          let grain = globalGrains.getById(grainId);
          if (grain) {
            globalGrains.setActive(grainId);
            return;
          }

          const mainContentElement = document.querySelector("body>.main-content");
          if (mainContentElement) {
            const grainToOpen = globalGrains.addNewGrainView(grainId, path, undefined,
                                                             mainContentElement);
            grainToOpen.openSession();
            globalGrains.setActive(grainId);

            if (initialPopup) {
              globalTopbar.openPopup(initialPopup);
            }
          } else {
            Meteor.defer(openView);
          }
        };

        openView();
      });

      this.next();
    },

    onStop: function () {
      this.state.set("beforeActionHookRan", false);
      globalGrains.setAllInactive();
    },
  });

  this.route("/shared/:token/:path(.*)?", {
    name: "shared",
    template: "grain",
    loadingTemplate: "loadingNoMessage",

    waitOn: function () {
      return [
        Meteor.subscribe("devPackages"),
        Meteor.subscribe("tokenInfo", this.params.token, false),

        Meteor.subscribe("grainsMenu"),
        // This subscription gives us the data we need for deciding whether to automatically reveal
        // our identity.
        // TODO(soon): Subscribe to contacts instead.
      ];
    },

    onBeforeAction: function () {
      // Don't do anything for non-account users.
      if (Meteor.userId() && !Meteor.user().loginCredentials) return;

      // Only run the hook once.
      if (this.state.get("beforeActionHookRan")) return this.next();
      this.state.set("beforeActionHookRan", true);

      Tracker.nonreactive(() => {
        const token = this.params.token;
        const path = "/" + (this.params.path || "") + (this.originalUrl.match(/[#?].*$/) || "");
        const hash = this.params.hash;

        const tokenInfo = TokenInfo.findOne({ _id: token });
        if (!tokenInfo) {
          return this.next();
        } else if (tokenInfo.invalidToken) {
          this.state.set("invalidToken", true);
        } else if (tokenInfo.revoked) {
          this.state.set("revoked", true);
        } else if (tokenInfo.accountOwner) {
          if (tokenInfo.grainId && Meteor.userId() &&
              Meteor.userId() == tokenInfo.accountOwner._id) {
            Router.go("/grain/" + tokenInfo.grainId + path, {}, { replaceState: true });
          } else {
            SandstormDb.fillInPictureUrl(tokenInfo.accountOwner);
            this.state.set("accountOwner", tokenInfo);
          }
        } else if (tokenInfo.alreadyRedeemed) {
          Router.go("/grain/" + tokenInfo.grainId + path, {}, { replaceState: true });
        } else if (tokenInfo.grainId) {
          const grainId = tokenInfo.grainId;

          // TODO(cleanup): We actually don't care which credential was chosen. This is just a hack
          //   to avoid showing the incognito prompt if the user just logged in for the explicit
          //   purpose of opening this grain.
          const credentialChosenByLogin = this.state.get("credential-chosen-by-login");
          this.state.set("credential-chosen-by-login", undefined);

          const openView = function openView() {
            // If the grain is already open in a tab, switch to that tab. We have to re-check this
            // every time we defer to avoid race conditions (especially at startup, with the
            // restore-last-opened code).
            const grain = globalGrains.getById(grainId);
            if (grain) {
              globalGrains.setActive(grainId);
              return;
            }

            const mainContentElement = document.querySelector("body>.main-content");
            if (mainContentElement) {
              const grainToOpen = globalGrains.addNewGrainView(grainId, path, tokenInfo,
                                                               mainContentElement);
              grainToOpen.openSession();
              globalGrains.setActive(grainId);

              if (credentialChosenByLogin) {
                grainToOpen.revealIdentity();
              }

              if (!Meteor.userId() && globalGrains.getAll().length <= 1) {
                // Suggest to the user that they log in by opening the login menu.
                globalTopbar.openPopup("login");
              }
            } else {
              Meteor.defer(openView);
            }
          };

          openView();
        }
      });

      this.next();
    },

    action: function () {
      if (this.state.get("invalidToken")) {
        this.render("invalidToken", { data: { token: this.params.token } });
      } else if (this.state.get("revoked")) {
        this.render("revokedShareLink");
      } else if (this.state.get("accountOwner")) {
        const tokenInfo = this.state.get("accountOwner");
        this.render("wrongUser",
                    { data: {
                      recipient: tokenInfo.accountOwner,
                      login: tokenInfo.login,
                    }, });
      } else {
        this.render();
      }
    },

    onStop: function () {
      this.state.set("beforeActionHookRan", false);
      this.state.set("invalidToken", undefined);
      this.state.set("accountOwner", undefined);
      globalGrains.setAllInactive();
    },
  });

  this.route("grainLog", {
    path: "/grainlog/:grainId",
    layoutTemplate: "noLayout",

    waitOn: function () {
      return [
        Meteor.subscribe("grainTopBar", this.params.grainId),
        Meteor.subscribe("grainLog", this.params.grainId),
      ];
    },

    data: function () {
      if (this.ready()) {
        const grain = Grains.findOne(this.params.grainId);
        return {
          title: grain ? grain.title : "(deleted grain)",
          // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
          html: AnsiUp.ansi_to_html(GrainLog.find({}, { $sort: { _id: 1 } })
              .map(function (entry) { return entry.text; })
              .join(""), { use_classes: true }),
          // jscs:enable requireCamelCaseOrUpperCaseIdentifiers
        };
      }
    },
  });

  this.route("appDetails", {
    path: "/apps/:appId",
    template: "appDetails",
    waitOn: function () {
      return globalSubs.concat(
        Meteor.subscribe("appIndex", this.params.appId));
    },

    data: function () {
      const params = this.getParams();
      return {
        _db: globalDb,
        _quotaEnforcer: globalQuotaEnforcer,
        _appId: params.appId,
        viewingTrash: params.hash === "trash",
        _staticHost: globalDb.makeWildcardHost("static"),
      };
    },
  });

  this.route("share", {
    path: "/share/:grainId/:accountId",
    template: "share",
    waitOn: function () {
      return Meteor.subscribe("grainTopBar", this.params.grainId);
    },

    data: function () {
      let userId = Meteor.userId();
      let grainId = this.params.grainId;
      let accountId = this.params.accountId;
      let grain = Grains.findOne({ _id: grainId });
      if (!grain) {
        return { grainNotFound: grainId };
      } else {
        Session.set("share-grain-" + grainId, accountId);
        Router.go("/grain/" + grainId);
      }
    },
  });
});

Meteor.startup(function () {
  if (isStandalone()) {
    // TODO(soon): delete all other routes (maybe change how they're created?)
    const route = Router.routes.root;
    _.extend(route.options, {
      template: "grain",
      loadingTemplate: "loadingNoMessage",

      waitOn: function () {
        const standalone = globalDb.collections.standaloneDomains.findOne({
          _id: window.location.hostname, });

        const subs = [
          Meteor.subscribe("devPackages"),
          Meteor.subscribe("standaloneDomain", window.location.hostname),
          Meteor.subscribe("grainsMenu"),
          // This subscription gives us the data we need for deciding whether to automatically reveal
          // our identity.
          // TODO(soon): Subscribe to contacts instead.
        ];
        if (standalone) {
          subs.push(Meteor.subscribe("tokenInfo", standalone.token, true));
        }

        return subs;
      },

      onBeforeAction: function () {
        // Don't do anything for non-account users.
        if (Meteor.userId() && !Meteor.user().loginCredentials) return;

        // Only run the hook once.
        if (this.state.get("beforeActionHookRan")) return this.next();
        this.state.set("beforeActionHookRan", true);

        Tracker.nonreactive(() => {
          const token = globalDb.collections.standaloneDomains.findOne({
            _id: window.location.hostname, }).token;
          const path = "/" + (this.params.path || "") + (this.originalUrl.match(/[#?].*$/) || "");
          const hash = this.params.hash;

          const tokenInfo = TokenInfo.findOne({ _id: token });
          if (!tokenInfo) {
            return this.next();
          } else if (tokenInfo.invalidToken) {
            this.state.set("invalidToken", true);
          } else if (tokenInfo.revoked) {
            this.state.set("revoked", true);
          } else if (tokenInfo.accountOwner) {
            this.state.set("invalidToken", true);
          } else if (tokenInfo.alreadyRedeemed) {
            console.error("token was already redeemed, but that shouldn't be possible.");
            this.state.set("invalidToken", true);
          } else if (tokenInfo.grainId) {
            const grainId = tokenInfo.grainId;

            const openView = function openView() {
              // If the grain is already open in a tab, switch to that tab. We have to re-check this
              // every time we defer to avoid race conditions (especially at startup, with the
              // restore-last-opened code).
              const grain = globalGrains.getById(grainId);
              if (grain) {
                globalGrains.setActive(grainId);
                return;
              }

              const mainContentElement = document.querySelector("body>.main-content");
              if (mainContentElement) {
                const grainToOpen = globalGrains.addNewGrainView(grainId, path, tokenInfo,
                                                                 mainContentElement);
                if (Meteor.user()) {
                  // For standalone hosts, if the user logged in at all, they must necessarily have
                  // logged into this grain, since there is only one grain. So we can always reveal
                  // identity -- if the user doesn't want to reveal identity, they shouldn't log
                  // into the host.
                  grainToOpen.revealIdentity();
                }

                grainToOpen.openSession();
                globalGrains.setActive(grainId);
              } else {
                Meteor.defer(openView);
              }
            };

            openView();
          }
        });

        this.next();
      },

      action: function () {
        if (this.state.get("invalidToken")) {
          this.render("invalidToken", { data: { token: this.params.token } });
        } else if (this.state.get("revoked")) {
          this.render("revokedShareLink");
        } else if (this.state.get("accountOwner")) {
          const tokenInfo = this.state.get("accountOwner");
          this.render("wrongUser",
                      { data: {
                        recipient: tokenInfo.accountOwner,
                        login: tokenInfo.login,
                      }, });
        } else {
          this.render();
        }
      },

      onStop: function () {
        this.state.set("beforeActionHookRan", false);
        this.state.set("invalidToken", undefined);
        this.state.set("accountOwner", undefined);
        globalGrains.setAllInactive();
      },
    });
  }
});
