
import { Meteor } from "meteor/meteor";
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { ReactiveDict } from "meteor/reactive-dict";
import { Session } from "meteor/session";
import { Router } from "meteor/iron:router";
import { _ } from "meteor/underscore";
import { TAPi18n } from "meteor/tap:i18n";

import { introJs } from "intro.js";
import { identiconForApp } from "/imports/sandstorm-identicons/helpers.js";
import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { makeAndDownloadBackup } from "/imports/client/backups.ts";

SandstormGrainListPage = {};

SandstormGrainListPage.mapGrainsToTemplateObject = function (grains, db) {
  // Do package lookup all at once, rather than doing N queries for N grains
  const packageIds = _.chain(grains)
      .pluck("packageId")
      .uniq()
      .value();
  const packages = db.collections.packages.find({ _id: { $in: packageIds } }).fetch();
  const packagesById = _.indexBy(packages, "_id");
  return grains.map(function (grain) {
    const pkg = packagesById[grain.packageId];
    const iconSrc = pkg ? db.iconSrcForPackage(pkg, "grain") : "";
    const appTitle = pkg ? SandstormDb.appNameFromPackage(pkg) : "";
    return {
      _id: grain._id,
      title: grain.title,
      appTitle: appTitle,
      lastUsed: grain.lastUsed,
      iconSrc: iconSrc,
      isOwnedByMe: true,
      trashed: grain.trashed,
      unread: !grain.ownerSeenAllActivity,
      size: grain.size,
    };
  });
};

function disabledHint(name) {
  return TAPi18n.__('grains.grainlist.sandstormGrainTable.bulkAction.disabledHints.' + name);
}

function bulkActionNoneSelected(numMineSelected, numSharedSelected) {
  if(numMineSelected == 0 && numSharedSelected == 0) {
    return disabledHint("mustSelectGrains");
  } else {
    return null;
  }
}

SandstormGrainListPage.mapApiTokensToTemplateObject = function (apiTokens, staticAssetHost) {
  const tokensForGrain = _.groupBy(apiTokens, "grainId");
  const grainIdsForApiTokens = Object.keys(tokensForGrain);
  return grainIdsForApiTokens.map(function (grainId) {
    // Pick the oldest one.
    const token = _.sortBy(tokensForGrain[grainId], "created")[0];

    const ownerData = token.owner.user;
    const grainInfo = ownerData.denormalizedGrainMetadata;
    const appTitle = (grainInfo && grainInfo.appTitle && grainInfo.appTitle.defaultText) || "";
    // TODO(someday): use source sets and the dpi2x value
    const iconSrc = (grainInfo && grainInfo.icon && grainInfo.icon.assetId) ?
        (window.location.protocol + "//" + staticAssetHost + "/" + grainInfo.icon.assetId) :
        identiconForApp((grainInfo && grainInfo.appId) || "00000000000000000000000000000000");
    const result = {
      _id: grainId,
      title: ownerData.title,
      appTitle: appTitle,
      lastUsed: token.lastUsed || token.created,
      isNewShare: !token.lastUsed,
      iconSrc: iconSrc,
      isOwnedByMe: false,
      trashed: token.trashed,
      unread: !ownerData.seenAllActivity,
    };

    if (ownerData.upstreamTitle) {
      if (ownerData.renamed) {
        result.renamedFrom = ownerData.upstreamTitle;
      } else {
        result.was = ownerData.title;
        result.title = ownerData.upstreamTitle;
      }
    }

    return result;
  });
};

const matchesAppOrGrainTitle = function (needle, grain) {
  if (grain.title && grain.title.toLowerCase().indexOf(needle) !== -1) return true;
  if (grain.was && grain.was.toLowerCase().indexOf(needle) !== -1) return true;
  if (grain.renamedFrom && grain.renamedFrom.toLowerCase().indexOf(needle) !== -1) return true;
  if (grain.appTitle && grain.appTitle.toLowerCase().indexOf(needle) !== -1) return true;
  return false;
};

const compileMatchFilter = function (searchString) {
  // split up searchString into an array of regexes, use them to match against item
  const searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter(function (k) { return k !== "";});

  return function matchFilter(item) {
    if (searchKeys.length === 0) return true;
    return _.chain(searchKeys)
        .map(function (searchKey) { return matchesAppOrGrainTitle(searchKey, item); })
        .reduce(function (a, b) { return a && b; })
        .value();
  };
};

const sortGrains = function (grains, sortRules) {
  // Overengineered sort logic.
  //
  // grains is an Array of grain row objects
  // sortRules is an Array of objects containing:
  //   key: String ("lastUsed" or "size" or "title")
  //   order: String ("ascending" or "descending")
  //
  // Sort rules are given in order from highest precedence to lowest precedence.
  const compileComparator = function (rule) {
    const { key, order } = rule;
    const multiplier = (order === "ascending" ? 1 : -1);
    if (key === "title") {
      // Compare strings case-insensitively.
      return function (a, b) {
        const aRaw = a[key];
        const bRaw = b[key];

        // Use locale-aware comparison if available.  Not all browsers support this.
        if (String.prototype.localeCompare) {
          return aRaw.localeCompare(bRaw) * multiplier;
        }

        // Otherwise, fall back to direct string comparison on lowercased strings.
        const aLower = aRaw.toLowerCase();
        const bLower = bRaw.toLowerCase();

        if (aLower < bLower) {
          return -1 * multiplier;
        } else if (aLower > bLower) {
          return multiplier;
        } else {
          return 0;
        }
      };
    } else if (key === "size") {
      // Direct comparison of values is okay.
      return function (a, b) {
        // If we don't have a size (because this is an apiToken, or we haven't backfilled the size
        // yet), fill with 0 so we don't get weird null propagation
        const aRaw = a[key] || 0;
        const bRaw = b[key] || 0;
        if (aRaw < bRaw) {
          return -1 * multiplier;
        } else if (aRaw > bRaw) {
          return multiplier;
        } else {
          return 0;
        }
      };
    } else {
      // Sorting by date.
      return function (a, b) {
        // Items with no lastUsed are new shares which we always want to show on top.
        const aRaw = a[key] || new Date();
        const bRaw = b[key] || new Date();
        if (aRaw < bRaw) {
          return -1 * multiplier;
        } else if (aRaw > bRaw) {
          return multiplier;
        } else {
          return 0;
        }
      };
    }
  };

  const compiledRules = sortRules.map(compileComparator);

  const comparator = function (a, b) {
    let i;
    for (i = 0; i < sortRules.length; i++) {
      const res = compiledRules[i](a, b);
      if (res !== 0) return res;
    }

    return 0;
  };

  // copy the list; don't mutate args in place.
  const sortableList = grains.slice();
  sortableList.sort(comparator);
  return sortableList;
};

const filteredGrains = function (showTrash) {
  const ref = Template.instance().data;
  const db = ref._db;
  const grains = db.currentUserGrains({ includeTrashOnly: !!showTrash }).fetch();
  const grainIdSet = {};
  grains.map((g) => grainIdSet[g._id] = true);

  const itemsFromGrains = SandstormGrainListPage.mapGrainsToTemplateObject(grains, db);
  const apiTokens = db.currentUserApiTokens(showTrash).fetch()
        .filter((t) => !(t.grainId in grainIdSet));

  const itemsFromSharedGrains = SandstormGrainListPage.mapApiTokensToTemplateObject(apiTokens, ref._staticHost);
  const filter = compileMatchFilter(Template.instance()._filter.get());
  return _.chain([itemsFromGrains, itemsFromSharedGrains])
      .flatten()
      .filter(filter)
      .value();
};

SandstormGrainListPage.bulkActionButtons = function (showTrash) {
  if (showTrash) {
    return [
      {
        buttonClass: "remove-permanently",

        text: function (numMineSelected, numSharedSelected) {
          if (numSharedSelected == 0) {
            return "Delete permanently";
          } else if (numMineSelected == 0) {
            return "Forget permanently";
          } else {
            return "Delete/forget permanently";
          }
        },

        disabled: function (numMineSelected, numSharedSelected) {
          return bulkActionNoneSelected(numMineSelected, numSharedSelected);
        },

        onClicked: function (ownedGrainIds, sharedGrainIds) {
          ownedGrainIds.forEach((grainId) => {
            Meteor.call("deleteGrain", grainId);
          });

          sharedGrainIds.forEach((grainId) => {
            Meteor.call("forgetGrain", grainId);
          });
        },
      },
      {
        buttonClass: "restore-to-main-list",

        text: function () {
          return "Restore to Main list";
        },

        disabled: function (numMineSelected, numSharedSelected) {
          return bulkActionNoneSelected(numMineSelected, numSharedSelected);
        },

        onClicked: function (ownedGrainIds, sharedGrainIds) {
          Meteor.call("moveGrainsOutOfTrash", ownedGrainIds.concat(sharedGrainIds));
        },
      },
    ];

  } else {
    return [
      {
        buttonClass: "move-to-trash",

        text: function () {
          return TAPi18n.__('grains.grainlist.sandstormGrainListPage.moveToTrash');
        },

        disabled: function (numMineSelected, numSharedSelected) {
          return bulkActionNoneSelected(numMineSelected, numSharedSelected);
        },

        onClicked: function (ownedGrainIds, sharedGrainIds) {
          Meteor.call("moveGrainsToTrash", ownedGrainIds.concat(sharedGrainIds));
        },
      },
      {
        buttonClass: "save-backup",

        text: function() {
          return 'Save backup';
        },

        disabled: function(numMineSelected, numSharedSelected) {
          if(numSharedSelected > 0) {
            return disabledHint("grainsOwnedByOthers");
          } else {
            return bulkActionNoneSelected(numMineSelected, numSharedSelected);
          }
        },

        onClicked: function (ownedGrainIds, _sharedGrainIds) {
          ownedGrainIds.forEach((grainId) => {
            // TODO: use the grain title, not the grain id, as the suggested
            // file name.
            makeAndDownloadBackup(grainId, grainId);
          });
        },
      },
    ];
  }
};

Template.sandstormGrainListPage.helpers({
  setDocumentTitle: function () {
    document.title = "Grains · " + Template.instance().data._db.getServerTitle();
  },

  filteredGrains: function () {
    return filteredGrains(Template.instance().data.viewTrash);
  },

  filteredTrashedGrains: function () {
    return filteredGrains(true);
  },

  searchText: function () {
    return Template.instance()._filter.get();
  },

  myGrainsCount: function () {
    return Template.instance().data._db.currentUserGrains({ includeTrash: true }).count();
  },

  trashCount: function () {
    return filteredGrains(true).length;
  },

  myGrainsSize: function () {
    // TODO(cleanup): extract prettySize and other similar helpers from globals into a package
    // TODO(cleanup): access Meteor.user() through db object
    return prettySize(Meteor.user().storageUsage);
  },

  onGrainClicked: function () {
    return function (grainId) {
      Router.go("grain", { grainId: grainId });
    };
  },

  showTrash: function () {
    return Template.instance().data.viewTrash;
  },

  bulkActionButtons: function () {
    return SandstormGrainListPage.bulkActionButtons(Template.instance().data.viewTrash);
  },

  isSignedUpOrDemo: function () {
    return this._db.isSignedUpOrDemo();
  },

  hasApps() {
    return this._db.currentUserActions().count() > 0;
  },

  quotaTotal() {
    return prettySize(this._db.getUserQuota(Meteor.user()).storage);
  },

  grainQuota() {
    const quota = this._db.getUserQuota(Meteor.user()).grains;
    if (quota === Infinity) return null;

    return quota;
  },
});

Template.sandstormGrainListPage.onCreated(function () {
  this._filter = new ReactiveVar("");
});

Template.sandstormGrainListPage.onRendered(function () {
  // Auto-focus search bar on desktop, but not mobile (on mobile it will open the software
  // keyboard which is undesirable). window.orientation is generally defined on mobile browsers
  // but not desktop browsers, but some mobile browsers don't support it, so we also check
  // clientWidth. Note that it's better to err on the side of not auto-focusing.
  if (window.orientation === undefined && window.innerWidth > 600) {
    const searchbar = this.findAll(".search-bar")[0];
    if (searchbar) searchbar.focus();
  }
});

Template.sandstormGrainListPage.events({
  "click .grain-list .question-mark": function (event) {
    const templateData = Template.instance().data;

    const exitAndRemoveOverlayNow = () => {
      // If there is no active intro, bail now.
      if (!templateData.intro) {
        return;
      }

      // Ask introjs to exit.
      templateData.intro.exit();
      // Remove our note-to-self which is how we detect the intro being around.
      templateData.intro = null;
      // Remove the overlay right now so that we can react to speedy clicking. introjs will do this
      // itself, but queues the task to be done 0.5 seconds later. This is not very Meteoric, I
      // realize.
      const overlay = document.querySelector(".introjs-overlay");
      if (overlay) {
        overlay.remove();
      }
    };

    if (templateData.intro) {
      // In this case, the intro is currently active, and the user clicked on the question mark. The
      // sensible thing to do is to dismiss the intro and stop processing the click.
      exitAndRemoveOverlayNow();
      return;
    }

    const intro = Template.instance().data.intro = introJs();
    let introOptions = {
      steps: [
        {
          element: document.querySelector(".grain-list .question-mark"),
          intro: "Each document, chat room, mail box, notebook, blog, or anything else you create is a grain. All your grains are private until you share them.",
        },
      ],
      highlightClass: "hidden-introjs-highlight",
      tooltipPosition: "auto",
      positionPrecedence: ["bottom", "top", "left", "right"],
      showStepNumbers: false,
      exitOnOverlayClick: true,
      overlayOpacity: 0,
      showBullets: false,
      doneLabel: "Got it",
    };

    // Detect if the window is skinner than 500px; if so, force the hint to appear vertically.
    if (window.innerWidth < 500) {
      introOptions.tooltipPosition = "bottom";
    }

    intro.setOptions(introOptions);

    // onexit gets triggered when user clicks on the overlay.
    intro.onexit(exitAndRemoveOverlayNow);

    // oncomplete gets triggered when user clicks "Got it".
    intro.oncomplete(exitAndRemoveOverlayNow);

    intro.start();
  },

  "input .search-bar": function (event) {
    Template.instance()._filter.set(event.target.value);
  },

  "keypress .search-bar": function (event, instance) {
    if (event.keyCode === 13) {
      // Enter pressed.  If a single grain is shown, open it.
      const grains = filteredGrains(instance.data.viewTrash);
      if (grains.length === 1) {
        // Unique grain found with current filter.  Activate it!
        const grainId = grains[0]._id;
        // router.go grain/grainId?
        Router.go("grain", { grainId: grainId });
      }
    }
  },

  "click button.empty-trash": function (event, instance) {
    const myGrainsCursor = instance.data._db.collections.grains.find({
      userId: Meteor.userId(),
      trashed: { $exists: true },
    }, { _id: 1 });

    const myGrains = _.pluck(myGrainsCursor.fetch(), "_id");

    const myTokens = instance.data._db.collections.apiTokens.find({
      "owner.user.accountId": Meteor.userId(),
      trashed: { $exists: true },
    }).fetch();

    const grainsSharedWithMe = Object.keys(_.groupBy(myTokens, "grainId"));

    let deletePhrase = "" + myGrains.length + " grain" + (myGrains.length > 1 ? "s" : "");
    let forgetPhrase = "" + grainsSharedWithMe.length + " grain" +
        (grainsSharedWithMe.length > 1 ? "s" : "");

    let message;
    if (myGrains.length == 0 && grainsSharedWithMe.length == 0) {
      return;
    } else if (grainsSharedWithMe.length == 0) {
      message = "Delete " + deletePhrase + "? This cannot be undone";
    } else if (myGrains.length == 0) {
      message = "Forget " + forgetPhrase + "? This cannot be undone";
    } else {
      message = "Delete " + deletePhrase + " and forget " + forgetPhrase + "? This cannot be undone.";
    }

    if (window.confirm(message)) {
      myGrains.forEach((grainId) => {
        Meteor.call("deleteGrain", grainId);
      });

      grainsSharedWithMe.forEach((grainId) => {
        Meteor.call("forgetGrain", grainId);
      });
    }
  },

  "click button.show-trash": function (event, instance) {
    Router.go("grains", {}, { hash: "trash" });
  },

  "click button.show-main-list": function (event, instance) {
    Router.go("grains", {}, { hash: "" });
  },

  "click .restore-button": function (event, instance) {
    const input = instance.find(".restore-button input");
    if (input == event.target) {
      // Click event generated by upload handler.
      return;
    }

    instance.data._quotaEnforcer.ifQuotaAvailable(function () {
      // N.B.: this calls into a global in shell.js.
      // TODO(cleanup): refactor into a safer dependency.
      promptRestoreBackup(input);
    });
  },
});

Template.sandstormGrainTable.onCreated(function () {
  // Grain IDs for the grains that are currently selected, whether or not they are currently
  // displayed.
  this._selectedMyGrainIds = new ReactiveDict();
  this._selectedSharedWithMeIds = new ReactiveDict();

  // These count the number of grains that are selected *and* currently displayed.
  this._numMineSelectedShown = new ReactiveVar(0);
  this._numSharedWithMeSelectedShown = new ReactiveVar(0);

  // This tracks the current sort order.
  this.sortOrder = new ReactiveVar({
    key: "lastUsed",
    order: "descending",
  });

  this.autorun(() => {
    const data = Template.currentData();
    let mineResult = 0;
    let sharedResult = 0;
    data.grains && data.grains.forEach((grain) => {
      if (this._selectedMyGrainIds.get(grain._id)) {
        mineResult += 1;
      }

      if (this._selectedSharedWithMeIds.get(grain._id)) {
        sharedResult += 1;
      }
    });
    this._numMineSelectedShown.set(mineResult);
    this._numSharedWithMeSelectedShown.set(sharedResult);
  });
});

Template.sandstormGrainTable.helpers({
  mineSelected: function () {
    return Template.instance()._numMineSelectedShown.get();
  },

  sharedSelected: function () {
    return Template.instance()._numSharedWithMeSelectedShown.get();
  },

  selectAllTitle: function () {
    const instance = Template.instance();
    if (instance._numMineSelectedShown.get() == 0 &&
        instance._numSharedWithMeSelectedShown.get() == 0) {
      return "select all";
    } else {
      return "unselect all";
    }
  },

  selectAllChecked: function () {
    const instance = Template.instance();
    return instance._numMineSelectedShown.get() > 0 ||
        instance._numSharedWithMeSelectedShown.get() > 0;
  },

  isChecked: function () {
    if (this.isOwnedByMe) {
      return Template.instance()._selectedMyGrainIds.get(this._id);
    } else {
      return Template.instance()._selectedSharedWithMeIds.get(this._id);
    }
  },

  showTableHeaders: function () {
    return !!(Template.instance().data.alwaysShowTableHeaders ||
              Template.instance().data.grains.length);
  },

  grainSize: function () {
    // TODO(cleanup): extract prettySize and other similar helpers from globals into a package
    // TODO(cleanup): access Meteor.user() through db object
    return this.size && prettySize(this.size);
  },

  sortedGrains(grains) {
    const instance = Template.instance();
    return sortGrains(grains, [instance.sortOrder.get()]);
  },

  sortOrder() {
    const instance = Template.instance();
    return instance.sortOrder.get();
  },
});

Template.sortColumnHeading.helpers({
  equal(a, b) {
    return a === b;
  },
});

Template.sandstormGrainTable.events({
  "click thead td.grain-name"(evt) {
    const instance = Template.instance();
    const currentSortOrder = instance.sortOrder.get();
    const newSortOrder = {
      key: "title",
      order: "ascending",
    };
    if (currentSortOrder.key === "title" && currentSortOrder.order === "ascending") {
      newSortOrder.order = "descending";
    }

    instance.sortOrder.set(newSortOrder);
  },

  "click thead td.grain-size"(evt) {
    const instance = Template.instance();
    const currentSortOrder = instance.sortOrder.get();
    const newSortOrder = {
      key: "size",
      order: "descending",
    };
    if (currentSortOrder.key === "size" && currentSortOrder.order === "descending") {
      newSortOrder.order = "ascending";
    }

    instance.sortOrder.set(newSortOrder);
  },

  "click thead td.last-used"(evt) {
    const instance = Template.instance();
    const currentSortOrder = instance.sortOrder.get();
    const newSortOrder = {
      key: "lastUsed",
      order: "descending",
    };
    if (currentSortOrder.key === "lastUsed" && currentSortOrder.order === "descending") {
      newSortOrder.order = "ascending";
    }

    instance.sortOrder.set(newSortOrder);
  },

  "click tbody tr.action": function (event) {
    this && this.onClick();
  },

  "click tbody tr.grain .click-to-go": function (event) {
    const context = Template.instance().data;
    context.onGrainClicked && context.onGrainClicked(this._id);
  },

  "click .select-all-grains>input": function (event, instance) {
    event.preventDefault();
    if (instance._numMineSelectedShown.get() == 0 &&
        instance._numSharedWithMeSelectedShown.get() == 0) {
      // select all
      instance.findAll(".select-grain>input").forEach((el) => {
        if (el !== event.currentTarget) {
          el.click();
        }
      });
    } else {
      // deselect all
      instance.findAll(".select-grain>input:checked").forEach((el) => {
        if (el !== event.currentTarget) {
          el.click();
        }
      });

    }
  },

  "change .select-grain.mine>input": function (event, instance) {
    event.preventDefault();
    if (event.target.checked) {
      instance._selectedMyGrainIds.set(this._id, true);
    } else {
      instance._selectedMyGrainIds.set(this._id, false);
    }
  },

  "change .select-grain.shared>input": function (event, instance) {
    if (event.target.checked) {
      instance._selectedSharedWithMeIds.set(this._id, true);
    } else {
      instance._selectedSharedWithMeIds.set(this._id, false);
    }
  },

  "click td.select-grain": function (event, instance) {
    if (event.target.tagName === "TD") {
      // Assume the user meant to click on the actual checkbox.
      const el = instance.find("td.select-grain>input[data-grainid='" + this._id + "']");
      el.click();
    }
  },

  "click .bulk-action-buttons>button": function (event, instance) {
    // Only perform the action for grains that are both selected and displayed.

    const ownedGrainIds = [];
    instance.findAll(".select-grain.mine>input:checked").forEach((x) => {
      const id = x.getAttribute("data-grainid");
      instance._selectedMyGrainIds.set(id, false);
      ownedGrainIds.push(id);
    });

    const sharedGrainIds = [];
    instance.findAll(".select-grain.shared>input:checked").forEach((x) => {
      const id = x.getAttribute("data-grainid");
      instance._selectedSharedWithMeIds.set(id, false);
      sharedGrainIds.push(id);
    });

    this.onClicked && this.onClicked(ownedGrainIds, sharedGrainIds);
  },
});

Template.sandstormGrainTable.onRendered(function () {
  // Set up the guided tour box, via introJs, if desired.
  if (!Template.instance().data.showHintIfEmpty) {
    return;
  }

  const _db = Template.instance().data._db;
  if (!_db) {
    return;
  }

  if (Session.get("dismissedGrainTableGuidedTour")) {
    return;
  }

  // We could abort this function if (! globalSubs['grainsMenu'].ready()). However, at the moment,
  // we already waitOn the globalSubs, so that would be a no-op.

  const hasGrains = !!(_db.currentUserGrains({ includeTrash: true }).count() ||
                       _db.currentUserApiTokens().count());
  if (!hasGrains) {
    const intro = Template.instance().intro = introJs();
    intro.setOptions({
      steps: [
        {
          element: document.querySelector(".grain-list-table"),
          intro: "You can click here to create a new grain and start the app. Make as many as you want.",
          position: "bottom",
        },
      ],
      tooltipPosition: "bottom",
      positionPrecedence: ["bottom"],
      showStepNumbers: false,
      exitOnOverlayClick: true,
      overlayOpacity: 0.7,
      showBullets: false,
      doneLabel: "Got it",
    });
    intro.oncomplete(function () {
      Session.set("dismissedGrainTableGuidedTour", true);
    });

    intro.start();

    // HACK: After 2 seconds, trigger window resize. This is a workaround for a problem where
    // sometimes introJs calculates the wrong location of the table, because the table loaded before
    // the text. We trigger the resize event because introJs hooks resize to look for the location
    // of the table.
    //
    // MutationObserver doesn't seem to notice the resizing.
    //
    // We could use a ResizeSensor that plays games with CSS, but that seems like more work than is
    // sensible.
    Meteor.setTimeout(function () {
      window.dispatchEvent(new Event("resize"));
    }, 2000);
  }
});

Template.sandstormGrainTable.onDestroyed(function () {
  if (Template.instance().intro) {
    Template.instance().intro.exit();
    Template.instance().intro = undefined;
  }
});
