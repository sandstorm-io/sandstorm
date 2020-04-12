import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { _ } from "meteor/underscore";

import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { globalDb } from "/imports/db-deprecated.js";

function deriveIntroducer(cap) {
  // For a given ApiToken, determine the account ID of the user who should be attributed for
  // creating the token.

  if (cap && cap.requirements) {
    for (let idx = 0; idx < cap.requirements.length; ++idx) {
      const req = cap.requirements[idx];
      if (req.permissionsHeld && req.permissionsHeld.accountId) {
        return req.permissionsHeld.accountId;
      } else if (req.userIsAdmin) {
        return req.userIsAdmin;
      }
    }
  }

  return null;
}

const capDetails = function (cap) {
  let ownerInfo = {};

  const introducerAccountId = deriveIntroducer(cap);
  const introducerAccount = introducerAccountId && Meteor.users.findOne({ _id: introducerAccountId });
  SandstormDb.fillInPictureUrl(introducerAccount);
  introducerAccount.intrinsicNames = globalDb.getAccountIntrinsicNames(introducerAccount);
  const introducer = {
    account: introducerAccount,
  };

  if (cap.owner.grain !== undefined) {
    const grainId = cap.owner.grain.grainId;
    const grain = globalDb.collections.grains.findOne(grainId);
    if (!grain) {
      // Grain was deleted.  Don't show anything.
      return undefined;
    }

    const grainTitle = grain && grain.title;
    const packageId = grain && grain.packageId;
    const pkg = packageId && globalDb.collections.packages.findOne(packageId);
    const appIcon = pkg && globalDb.iconSrcForPackage(pkg, "grain", globalDb.makeWildcardHost("static"));

    const grainOwnerAccount = (introducerAccountId === grain.userId) ? undefined
        : Meteor.users.findOne({ _id: grain.userId });

    ownerInfo.grain = {
      _id: grainId,
      ownerAccount: grainOwnerAccount,
      title: grainTitle,
      pkg,
      appIcon,
    };
  } else if (cap.owner.webkey !== undefined) {
    ownerInfo.webkey = {};
  }

  return {
    _id: cap._id,
    revoked: cap.revoked,
    created: cap.created,
    introducer,
    ownerInfo,
  };
};

Template.newAdminNetworkCapabilities.onCreated(function () {
  this.adminApiTokensSub = this.subscribe("adminApiTokens", undefined);

  this.autorun(() => {
    const apiTokens = globalDb.collections.apiTokens.find({
      $and: [
        {
          $or: [
            { "frontendRef.ipNetwork": { $exists: true } },
            { "frontendRef.ipInterface": { $exists: true } },
          ],
        },
        {
          "owner.grain": { $exists: true },
        },
      ],
    });
    const grainIds = apiTokens.map(token => token.owner.grain.grainId);
    this.subscribe("adminGrains", grainIds);

    const packageIds = globalDb.collections.grains.find({
      _id: {
        $in: grainIds,
      },
    }).map(grain => grain.packageId);

    this.subscribe("adminPackages", packageIds);

    const accountIds = [];
    apiTokens.forEach((token) => {
      const introducer = deriveIntroducer(token);
      if (introducer) accountIds.push(introducer);
    });

    this.subscribe("adminProfiles", accountIds);
  });
});

Template.newAdminNetworkCapabilities.helpers({
  ipNetworkCaps() {
    return globalDb.collections.apiTokens.find({
      "frontendRef.ipNetwork": { $exists: true },
      $or: [
        { "frontendRef.ipNetwork.encryption": { $exists: false } },
        { "frontendRef.ipNetwork.encryption.none": { $exists: true } },
      ],
      "owner.clientPowerboxRequest": { $exists: false },
    }).map(capDetails)
      .filter((item) => !!item);
  },

  ipNetworkCapsTls() {
    return globalDb.collections.apiTokens.find({
      "frontendRef.ipNetwork.encryption.tls": { $exists: true },
      "owner.clientPowerboxRequest": { $exists: false },
    }).map(capDetails)
      .filter((item) => !!item);
  },

  ipInterfaceCaps() {
    return globalDb.collections.apiTokens.find({
      "frontendRef.ipInterface": { $exists: true },
    }).map(capDetails)
      .filter((item) => !!item);
  },
});

const accountMatchesNeedle = function (needle, account) {
  const profile = account && account.profile;
  if (profile) {
    if (profile.handle.toLowerCase().indexOf(needle) !== -1) return true;
    if (profile.name.toLowerCase().indexOf(needle) !== -1) return true;
  }

  const intrinsicNames = (account && account.intrinsicNames) || [];
  for (let i = 0; i < intrinsicNames.length; i++) {
    if (intrinsicNames[i].service.toLowerCase().indexOf(needle) !== -1) return true;
    if (intrinsicNames[i].name.toLowerCase().indexOf(needle) !== -1) return true;
  }

  return false;
};

const packageMatchesNeedle = function (needle, pkg) {
  const title = pkg && pkg.manifest && pkg.manifest.appTitle && pkg.manifest.appTitle.defaultText;
  return title && title.toLowerCase().indexOf(needle) !== -1;
};

const matchesCap = function (needle, cap) {
  // Check for matching name in the grain owner or the token creator's profile.
  // Check for matches in cap token ID, grain ID, or app ID, but only as a prefix.

  if (cap.introducer.account) {
    if (accountMatchesNeedle(needle, cap.introducer.account)) return true;
  }

  if (cap._id.toLowerCase().lastIndexOf(needle, 0) !== -1) return true;

  if (cap.ownerInfo.grain) {
    const grain = cap.ownerInfo.grain;
    if (grain.title.toLowerCase().indexOf(needle) !== -1) return true;
    if (accountMatchesNeedle(needle, grain.ownerAccount)) return true;
    if (packageMatchesNeedle(needle, grain.pkg)) return true;
    if (grain._id.toLowerCase().lastIndexOf(needle, 0) !== -1) return true;
    if (grain.pkg && grain.pkg.appId.toLowerCase().lastIndexOf(needle, 0) !== -1) return true;
  }

  if (cap.introducer.account) {
    if (cap.introducer.account._id.toLowerCase().indexOf(needle) !== -1) return true;
  }

  return false;
};

Template.newAdminNetworkCapabilitiesSection.onCreated(function () {
  this.searchString = new ReactiveVar("");
  this.activeChecked = new ReactiveVar(true);
  this.revokedChecked = new ReactiveVar(false);

  this.formState = new ReactiveVar("default");
  this.message = new ReactiveVar("");

  this.compileMatchFilter = () => {
    const searchString = this.searchString.get();
    const searchKeys = searchString.toLowerCase()
        .split(" ")
        .filter((k) => { return k !== ""; });

    return function matchFilter(item) {
      if (searchKeys.length === 0) return true;
      return _.chain(searchKeys)
          .map((searchKey) => { return matchesCap(searchKey, item); })
          .reduce((a, b) => a && b)
          .value();
    };
  };

  this.currentFilter = () => {
    // Returns a function which maps an object as returned from capDetails into a Boolean value
    // (whether or not it should be displayed).
    const searchStringMatchFilter = this.compileMatchFilter();
    return (cap) => {
      if (cap.revoked) {
        if (!this.revokedChecked.get()) return false;
      } else {
        if (!this.activeChecked.get()) return false;
      }

      return searchStringMatchFilter(cap);
    };
  };
});

Template.newAdminNetworkCapabilitiesSection.helpers({
  filterString() {
    const instance = Template.instance();
    return instance.searchString.get();
  },

  filterCaps(caps) {
    const instance = Template.instance();
    const filteredCaps = caps.filter(instance.currentFilter());
    return filteredCaps;
  },

  callbacks() {
    const instance = Template.instance();
    // Passing this down through another template?  Better wrap it in another closure. :/
    return {
      onRevokeCap(capId) {
        instance.formState.set("submitting");
        Meteor.call("adminToggleDisableCap", undefined, capId, true, (err) => {
          if (err) {
            instance.formState.set("error");
            instance.message.set(err.message);
          } else {
            instance.formState.set("success");
            instance.message.set("Revoked capability.");
          }
        });
      },
    };
  },

  activeChecked() {
    const instance = Template.instance();
    return instance.activeChecked.get();
  },

  revokedChecked() {
    const instance = Template.instance();
    return instance.revokedChecked.get();
  },

  activeCount(caps) {
    return caps.filter((cap) => {
      return !cap.revoked && !cap.trashed;
    }).length;
  },

  revokedCount(caps) {
    return caps.filter((cap) => {
      return cap.revoked || cap.trashed;
    }).length;
  },

  hasSuccess() {
    const instance = Template.instance();
    return instance.formState.get() === "success";
  },

  hasError() {
    const instance = Template.instance();
    return instance.formState.get() === "error";
  },

  message() {
    const instance = Template.instance();
    return instance.message.get();
  },
});

Template.newAdminNetworkCapabilitiesSection.events({
  "input input[name=search-string]"(evt) {
    const instance = Template.instance();
    instance.searchString.set(evt.currentTarget.value);
  },

  "click input[name=active]"(evt) {
    const instance = Template.instance();
    instance.activeChecked.set(!instance.activeChecked.get());
  },

  "click input[name=revoked]"(evt) {
    const instance = Template.instance();
    instance.revokedChecked.set(!instance.revokedChecked.get());
  },
});

Template.newAdminNetworkCapabilitiesTableCapabilityRow.events({
  "click .actions button"(evt) {
    const instance = Template.instance();
    instance.data.callbacks.onRevokeCap && instance.data.callbacks.onRevokeCap(instance.data.capInfo._id);
  },
});
