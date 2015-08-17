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
      size: "0kb",
      iconSrc: iconSrc,
    };
  });
};
var mapApiTokensToTemplateObject = function (apiTokens) {
  var db = Template.instance().data._db;
  var tokensForGrain = _.groupBy(apiTokens, 'grainId');
  var grainIdsForApiTokens = Object.keys(tokensForGrain);
  var sharedGrains = db.collections.grains.find({_id: {$in: grainIdsForApiTokens}}).fetch();
  var packageIds = _.chain(sharedGrains)
      .pluck('packageId')
      .uniq()
      .value();
  var packages = db.collections.packages.find({ _id: { $in: packageIds } }).fetch();
  var packagesById = _.indexBy(packages, '_id');
  return sharedGrains.map(function(grain) {
    var pkg = packagesById[grain.packageId];
    var iconSrc = pkg ? Identicon.iconSrcForPackage(pkg, 'grain', Template.instance().data._staticHost) : "";
    var appTitle = (pkg && pkg.manifest && pkg.manifest.appTitle &&
                    pkg.manifest.appTitle.defaultText) || "";
    // It's theoretically possible to have multiple API tokens for the same grain.
    // Pick one arbitrarily to assign the grain petname from.
    var token = tokensForGrain[grain._id][0];
    return {
      _id: grain._id,
      title: token.owner.user.title,
      appTitle: appTitle,
      lastUsed: grain.lastUsed,
      iconSrc: iconSrc,
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
  }
});
Template.sandstormGrainList.onCreated(function () {
  Template.instance().subscribe("grainsMenu");
  Template.instance().subscribe("userPackages");
  Template.instance().subscribe("sharedGrainInfo");
});
Template.sandstormGrainList.events({
  "click tr": function(event) {
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

