var compileMatchFilter = function (searchString) {
  // split up searchString into an array of regexes, use them to match against item
  var searchKeys = searchString.toLowerCase()
      .split(" ")
      .filter(function(k) { return k !== "";});
  return function matchFilter(item) {
    // Keep any item that matches all substrings
    var haystack = item.title.toLowerCase();
    for (var i = 0 ; i < searchKeys.length ; i++) {
      if (haystack.indexOf(searchKeys[i]) === -1) {
        return false;
      }
    }
    return true;
  };
};
var mapGrainsToTemplateObject = function (grains) {
  // Do package lookup all at once, rather than doing N queries for N grains
  var db = Template.instance().data._db;
  var packageIds = _.chain(grains)
      .pluck('packageId')
      .uniq()
      .value();
  var packages = db.collections.packages.find({ _id: { $in: packageIds } }).fetch();
  var packagesById = _.indexBy(packages, '_id');
  return grains.map(function(grain) {
    var pkg = packagesById[grain.packageId];
    var iconSrc = pkg ? Identicon.iconSrcForPackage(pkg, 'grain', Template.instance().data._staticHost) : "";
    var appTitle = (pkg && pkg.manifest && pkg.manifest.appTitle &&
                    pkg.manifest.appTitle.defaultText) || "";
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
var mapApiTokensToTemplateObject = function (apiTokens) {
  var ref = Template.instance().data;
  var tokensForGrain = _.groupBy(apiTokens, 'grainId');
  var grainIdsForApiTokens = Object.keys(tokensForGrain);
  var sharedGrains = ref._db.collections.grains.find({_id: {$in: grainIdsForApiTokens}}).fetch();
  return grainIdsForApiTokens.map(function(grainId) {
    // It's theoretically possible to have multiple API tokens for the same grain.
    // Pick one arbitrarily to assign the grain petname from.
    var token = tokensForGrain[grainId][0];
    var ownerData = token.owner.user;
    var grainInfo = ownerData.denormalizedGrainMetadata;
    var appTitle = (grainInfo && grainInfo.appTitle && grainInfo.appTitle.defaultText) || "";
    // TODO(someday): use source sets and the dpi2x value
    var iconSrc = (grainInfo && grainInfo.icon && grainInfo.icon.assetId) ?
        (window.location.protocol + "//" + ref._staticHost + "/" + grainInfo.icon.assetId) :
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
var filteredSortedGrains = function() {
  var db = Template.instance().data._db;
  var grains = db.currentUserGrains({}, {}).fetch();
  var itemsFromGrains = mapGrainsToTemplateObject(grains);
  var apiTokens = db.currentUserApiTokens().fetch();
  var itemsFromSharedGrains = mapApiTokensToTemplateObject(apiTokens);
  var filter = compileMatchFilter(Template.instance().data._filter.get());
  return _.chain([itemsFromGrains, itemsFromSharedGrains])
      .flatten()
      .filter(filter)
      .sortBy('lastUsed') // TODO: allow sorting by other columns
      .reverse()
      .value();
};
Template.sandstormGrainList.helpers({
  filteredSortedGrains: filteredSortedGrains,
  searchText: function() {
    return Template.instance().data._filter.get();
  },
  myGrainsCount: function () {
    return Template.instance().data._db.currentUserGrains({}, {}).count();
  },
  hasAnyGrainsCreatedOrSharedWithMe: function() {
    var _db = Template.instance().data._db;
    return !! (_db.currentUserGrains({}, {}).count() ||
               _db.currentUserApiTokens().count());
  },
  myGrainsSize: function () {
    // TODO(cleanup): extract prettySize and other similar helpers from globals into a package
    // TODO(cleanup): access Meteor.user() through db object
    return prettySize(Meteor.user().storageUsage);
  }
});
Template.sandstormGrainList.onCreated(function () {
  Template.instance().subscribe("userPackages");
});
Template.sandstormGrainList.onRendered(function () {
  // Auto-focus search bar on desktop, but not mobile (on mobile it will open the software
  // keyboard which is undesirable). window.orientation is generally defined on mobile browsers
  // but not desktop browsers, but some mobile browsers don't support it, so we also check
  // clientWidth. Note that it's better to err on the side of not auto-focusing.
  if (window.orientation === undefined && window.innerWidth > 600) {
    this.findAll(".search-bar")[0].focus();
  }
});
Template.sandstormGrainList.events({
  "click tbody tr": function(event) {
    var grainId = event.currentTarget.getAttribute('data-grainid');
    Router.go("grain", {grainId: grainId});
  },
  // We use keyup rather than keypress because keypress's event.target.value will not have
  // taken into account the keypress generating this event, so we'll miss a letter to filter by
  "keyup .search-bar": function(event) {
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
