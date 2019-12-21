// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2019 Sandstorm Development Group, Inc. and contributors
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

function isValidServerUrl(str) {
  let url;
  try {
    url = new URL(str);
  } catch (err) {
    return false;
  }
  if (url.protocol != "http:" && url.protocol != "https:") {
    return false;
  }
  return str == url.protocol + "//" + url.host;
}

Router.map(function () {
  this.route("transfers", {
    path: "/transfers",
    waitOn: function () {
      return globalSubs.concat([
        Meteor.subscribe("transfers")
      ]);
    },

    data: function () {
      if (!this.ready()) return;
      if (!Meteor.userId() && !Meteor.loggingIn()) {
        return { showLogin: true };
      }

      let result = {
        incoming: !!globalDb.collections.incomingTransfers.findOne({userId: Meteor.userId()}),
        outgoing: globalDb.collections.outgoingTransfers.findOne({userId: Meteor.userId()})
      };

      let fragment = this.getParams().hash;
      if (fragment && fragment.startsWith("initiate:")) {
        fragment = fragment.slice("initiate:".length);
        let colon = fragment.indexOf(":");
        if (colon >= 0) {
          let token = fragment.slice(0, colon);
          let source = fragment.slice(colon + 1);
          if (isValidServerUrl(source) && token.match(/^[0-9a-f]{64}$/)) {
            result.initiate = { token, source }
          }
        }
      }

      return result;
    },
  });
});

Template.transfers.helpers({
  blockedInitiate() {
    if (this.incoming || this.outgoing) {
      return this.initiate;
    } else {
      return null;
    }
  },

  isInsecure(url) {
    return url.startsWith("http:");
  },

  // ---------------------------------------------------------------------------
  // Incoming grain list

  selectAllChecked() {
    return !globalDb.collections.incomingTransfers.findOne({selected: false});
  },

  grains() {
    return globalDb.collections.incomingTransfers.find({}, {sort: {lastUsed: -1}});
  },

  isAnyDownloading() {
    return !!globalDb.collections.incomingTransfers.findOne({downloading: true});
  },

  isAnyStarted() {
    return !!globalDb.collections.incomingTransfers.findOne({$or: [
        {downloading: true}, {localGrainId: {$exists: true}}, {error: {$exists: true}}]});
  },

  isAnyReady() {
    return !!globalDb.collections.incomingTransfers.findOne({
      selected: true,
      downloading: {$exists: false},
      localGrainId: {$exists: false},
      error: {$exists: false}
    });
  },

  isAllDone() {
    return !globalDb.collections.incomingTransfers.findOne({localGrainId: {$exists: false}});
  },

  isAnyDone() {
    return !!globalDb.collections.incomingTransfers.findOne({localGrainId: {$exists: true}});
  },

  isAnyErrored() {
    return !!globalDb.collections.incomingTransfers.findOne({error: {$exists: true}});
  },

  grainSourceUrl() {
    return this.source + "/grain/" + this.grainId;
  },

  appInfo() {
    let pkg = globalDb.collections.packages.findOne({appId: this.appId});
    if (pkg) {
      return {
        appTitle: SandstormDb.appNameFromPackage(pkg),
        iconSrc: globalDb.iconSrcForPackage(pkg, "grain")
      }
    } else {
      return null;
    }
  },

  grainSize() {
    return this.size && prettySize(this.size);
  },

  lastUsed() {
    return this.lastUsed && new Date(this.lastUsed);
  },
});

Template.transfers.events({
  "submit .initiate"(evt, instance) {
    evt.preventDefault();

    let destination = evt.currentTarget.elements.destination.value;

    if (!destination.startsWith("http:") && !destination.startsWith("https:")) {
      destination = "https://" + destination;
    }

    while (destination.endsWith("/")) {
      destination = destination.slice(0, -1);
    }

    if (!isValidServerUrl(destination)) {
      alert("Invalid destination URL: " + destination);
      return;
    }

    if (!confirm(
      TAPi18n.__("grains.grainlist.sandstormGrainListPage.warningGiving") + " " +
      destination + TAPi18n.__("grains.grainlist.sandstormGrainListPage.warningGiving"))) {
      return;
    }

    Meteor.call("newTransfer", destination, (err, token) => {
      if (err) {
        alert("Error initiating transfer: " + err.message);
        return;
      }

      let url = new URL(destination);
      url.pathname = "/transfers";
      url.hash = "#initiate:" + token + ":" +
          document.location.protocol + "//" + document.location.host;

      window.open(url.toString(), "_blank");
    });
  },

  "click .cancel"(evt, instance) {
    evt.preventDefault();
    Meteor.call("cancelTransfers");
  },

  "click .finish"(evt, instance) {
    evt.preventDefault();
    Meteor.call("cancelTransfers");
  },

  "click .deny"(evt, instance) {
    evt.preventDefault();
    Router.go("transfers");
  },

  "click .continue"(evt, instance) {
    evt.preventDefault();
    Meteor.call("acceptTransfer", this.source, this.token, (err) => {
      if (err) {
        alert(TAPi18n.__("grains.grainlist.sandstormGrainListPage.errorAcceptingTransfer") + err.message);
        return;
      }
      Router.go("transfers");
    });
  },

  "click .select-grain"(evt, instance) {
    evt.preventDefault();
    Meteor.call("setTransferSelected", this._id, !this.selected);
  },

  "click .select-all-grains"(evt, instance) {
    evt.preventDefault();
    let newValue = !!globalDb.collections.incomingTransfers.findOne({selected: false});
    Meteor.call("setTransferSelected", null, newValue);
  },

  "click .start"(evt, instance) {
    evt.preventDefault();
    Meteor.call("setTransferRunning", true);
  },

  "click .pause"(evt, instance) {
    evt.preventDefault();
    Meteor.call("setTransferRunning", false);
  },

  "click .clear-errors"(evt, instance) {
    evt.preventDefault();
    Meteor.call("clearTransferErrors");
  },
});

Meteor.methods({
  cancelTransfers() {
    // simulation
    globalDb.collections.outgoingTransfers.remove({userId: this.userId});
    globalDb.collections.incomingTransfers.remove({userId: this.userId});
  },

  setTransferSelected(transferId, selected) {
    // simulation
    if (transferId) {
      globalDb.collections.incomingTransfers.update({_id: transferId}, {$set: {selected}});
    } else {
      globalDb.collections.incomingTransfers.update(
          {userId: this.userId}, {$set: {selected}}, {multi: true});
    }
  },

  setTransferRunning(running) {
    // simulation
    if (running) {
      let next = globalDb.collections.incomingTransfers.findOne({
        userId: this.userId,
        selected: true,
        downloading: {$exists: false},
        localGrainId: {$exists: false},
        error: {$exists: false}
      }, {sort: {lastUsed: -1}});

      if (next) {
        globalDb.collections.incomingTransfers.update({_id: next._id}, {$set: {downloading: true}});
      }
    } else {
      globalDb.collections.incomingTransfers.update(
          {userId: this.userId, downloading: true}, {$unset: {downloading: 1}}, {multi: true});
    }
  },

  clearTransferErrors() {
    // simulation
    globalDb.collections.incomingTransfers.update(
        {userId: this.userId, error: {$exists: true}}, {$unset: {error: 1}}, {multi: true});
  },
});
