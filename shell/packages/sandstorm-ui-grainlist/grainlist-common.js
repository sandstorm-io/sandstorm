// TODO(cleanup): Make this class client-only since it does nothing useful on the server.
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
    // It's theoretically possible to have multiple API tokens for the same grain.
    // Pick one arbitrarily to assign the grain petname from.
    var token = tokensForGrain[grainId][0];
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
