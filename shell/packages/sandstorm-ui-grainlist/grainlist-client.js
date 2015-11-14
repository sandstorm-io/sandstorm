SandstormGrainListPage = function (db, quotaEnforcer) {
  this._filter = new ReactiveVar("");
  this._staticHost = db.makeWildcardHost('static');
  this._db = db;
  this._quotaEnforcer = quotaEnforcer;
};

SandstormGrainListPage.mapGrainsToTemplateObject = function (grains, db) {
  // Do package lookup all at once, rather than doing N queries for N grains
  var packageIds = _.chain(grains)
      .pluck('packageId')
      .uniq()
      .value();
  var packages = db.collections.packages.find({ _id: { $in: packageIds } }).fetch();
  var packagesById = _.indexBy(packages, '_id');
  return grains.map(function(grain) {
    var pkg = packagesById[grain.packageId];
    var iconSrc = pkg ? db.iconSrcForPackage(pkg, 'grain') : "";
    var appTitle = pkg ? SandstormDb.appNameFromPackage(pkg) : "";
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
  var tokensForGrain = _.groupBy(apiTokens, 'grainId');
  var grainIdsForApiTokens = Object.keys(tokensForGrain);
  return grainIdsForApiTokens.map(function(grainId) {
    // Pick the most recently used one.
    var token = _.sortBy(tokensForGrain[grainId], function (t) {
      if (t.owner && t.owner.user && t.owner.user.lastUsed) { return -t.owner.user.lastUsed }
      else {return 0; } })[0];
    var ownerData = token.owner.user;
    var grainInfo = ownerData.denormalizedGrainMetadata;
    var appTitle = (grainInfo && grainInfo.appTitle && grainInfo.appTitle.defaultText) || "";
    // TODO(someday): use source sets and the dpi2x value
    var iconSrc = (grainInfo && grainInfo.icon && grainInfo.icon.assetId) ?
        (window.location.protocol + "//" + staticAssetHost + "/" + grainInfo.icon.assetId) :
        Identicon.identiconForApp((grainInfo && grainInfo.appId) || "00000000000000000000000000000000");
    return {
      _id: grainId,
      title: ownerData.title,
      appTitle: appTitle,
      lastUsed: ownerData.lastUsed,
      iconSrc: iconSrc,
      isOwnedByMe: false,
    };
  });
};

var matchesAppOrGrainTitle = function (needle, grain) {
  if (grain.title && grain.title.toLowerCase().indexOf(needle) !== -1) return true;
  if (grain.appTitle && grain.appTitle.toLowerCase().indexOf(needle) !== -1) return true;
  return false;
};
var compileMatchFilter = function (searchString) {
  // split up searchString into an array of regexes, use them to match against item
  var searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter(function(k) { return k !== "";});
  return function matchFilter(item) {
    if (searchKeys.length === 0) return true;
    return _.chain(searchKeys)
        .map(function (searchKey) { return matchesAppOrGrainTitle(searchKey, item); })
        .reduce(function (a, b) { return a && b; })
        .value();
  };
};
var filteredSortedGrains = function() {
  var ref = Template.instance().data;
  var db = ref._db;
  var grains = db.currentUserGrains().fetch();
  var itemsFromGrains = SandstormGrainListPage.mapGrainsToTemplateObject(grains, db);
  var apiTokens = db.currentUserApiTokens().fetch();
  var itemsFromSharedGrains = SandstormGrainListPage.mapApiTokensToTemplateObject(apiTokens, ref._staticHost);
  var filter = compileMatchFilter(Template.instance().data._filter.get());
  return _.chain([itemsFromGrains, itemsFromSharedGrains])
      .flatten()
      .filter(filter)
      .sortBy('lastUsed') // TODO: allow sorting by other columns
      .reverse()
      .value();
};
Template.sandstormGrainListPage.helpers({
  setDocumentTitle: function() {
    document.title = "Grains · Sandstorm";
  },
  filteredSortedGrains: filteredSortedGrains,
  searchText: function() {
    return Template.instance().data._filter.get();
  },
  myGrainsCount: function () {
    return Template.instance().data._db.currentUserGrains().count();
  },
  hasAnyGrainsCreatedOrSharedWithMe: function() {
    var _db = Template.instance().data._db;
    return !! (_db.currentUserGrains().count() ||
               _db.currentUserApiTokens().count());
  },
  myGrainsSize: function () {
    // TODO(cleanup): extract prettySize and other similar helpers from globals into a package
    // TODO(cleanup): access Meteor.user() through db object
    return prettySize(Meteor.user().storageUsage);
  },
  onGrainClicked: function () {
    return function (grainId) {
      Router.go("grain", {grainId: grainId});
    };
  },
});
Template.sandstormGrainListPage.onRendered(function () {
  // Auto-focus search bar on desktop, but not mobile (on mobile it will open the software
  // keyboard which is undesirable). window.orientation is generally defined on mobile browsers
  // but not desktop browsers, but some mobile browsers don't support it, so we also check
  // clientWidth. Note that it's better to err on the side of not auto-focusing.
  if (window.orientation === undefined && window.innerWidth > 600) {
    var searchbar = this.findAll(".search-bar")[0];
    if (searchbar) searchbar.focus();
  }
});

Template.sandstormGrainListPage.events({
  "input .search-bar": function(event) {
    Template.instance().data._filter.set(event.target.value);
  },
  "keypress .search-bar": function(event) {
    if (event.keyCode === 13) {
      // Enter pressed.  If a single grain is shown, open it.
      var grains = filteredSortedGrains();
      if (grains.length === 1) {
        // Unique grain found with current filter.  Activate it!
        var grainId = grains[0]._id;
        // router.go grain/grainId?
        Router.go("grain", {grainId: grainId});
      }
    }
  }
});

Template.sandstormGrainTable.events({
  "click tbody tr.action": function(event) {
    this && this.onClick();
  },
  "click tbody tr.grain": function(event) {
    var context = Template.instance().data;
    context.onGrainClicked && context.onGrainClicked(this._id);
  },
});
