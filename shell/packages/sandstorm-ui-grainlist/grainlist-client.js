import {introJs} from "intro.js";

SandstormGrainListPage = function (db, quotaEnforcer) {
  this._filter = new ReactiveVar("");
  this._staticHost = db.makeWildcardHost("static");
  this._db = db;
  this._quotaEnforcer = quotaEnforcer;
};

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
    };
  });
};

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
        Identicon.identiconForApp((grainInfo && grainInfo.appId) || "00000000000000000000000000000000");
    const result = {
      _id: grainId,
      title: ownerData.title,
      appTitle: appTitle,
      lastUsed: token.lastUsed,
      iconSrc: iconSrc,
      isOwnedByMe: false,
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

const filteredSortedGrains = function () {
  const ref = Template.instance().data;
  const db = ref._db;
  const grains = db.currentUserGrains().fetch();
  const itemsFromGrains = SandstormGrainListPage.mapGrainsToTemplateObject(grains, db);
  const apiTokens = db.currentUserApiTokens().fetch();
  const itemsFromSharedGrains = SandstormGrainListPage.mapApiTokensToTemplateObject(apiTokens, ref._staticHost);
  const filter = compileMatchFilter(Template.instance().data._filter.get());
  return _.chain([itemsFromGrains, itemsFromSharedGrains])
      .flatten()
      .filter(filter)
      .sortBy("lastUsed") // TODO: allow sorting by other columns
      .reverse()
      .value();
};

Template.sandstormGrainListPage.helpers({
  setDocumentTitle: function () {
    document.title = "Grains · " + Template.instance().data._db.getServerTitle();
  },

  filteredSortedGrains: filteredSortedGrains,
  searchText: function () {
    return Template.instance().data._filter.get();
  },

  myGrainsCount: function () {
    return Template.instance().data._db.currentUserGrains().count();
  },

  hasAnyGrainsCreatedOrSharedWithMe: function () {
    const _db = Template.instance().data._db;
    return !!(_db.currentUserGrains().count() ||
               _db.currentUserApiTokens().count());
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
  "input .search-bar": function (event) {
    Template.instance().data._filter.set(event.target.value);
  },

  "keypress .search-bar": function (event) {
    if (event.keyCode === 13) {
      // Enter pressed.  If a single grain is shown, open it.
      const grains = filteredSortedGrains();
      if (grains.length === 1) {
        // Unique grain found with current filter.  Activate it!
        const grainId = grains[0]._id;
        // router.go grain/grainId?
        Router.go("grain", { grainId: grainId });
      }
    }
  },
});

Template.sandstormGrainListPage.events({
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

Template.sandstormGrainTable.events({
  "click tbody tr.action": function (event) {
    this && this.onClick();
  },

  "click tbody tr.grain": function (event) {
    const context = Template.instance().data;
    context.onGrainClicked && context.onGrainClicked(this._id);
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

  const hasGrains = !!(_db.currentUserGrains().count() ||
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
      tooltipPosition: "auto",
      positionPrecedence: ["bottom", "top", "left", "right"],
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
