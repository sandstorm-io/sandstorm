Meteor.publish('packageInfo', function(packageId) {
  check(packageId, String);
  var db = this.connection.sandstormDb;
  var pkgCursor = db.collections.packages.find(packageId);
  var pkg = pkgCursor.fetch()[0];
  if (pkg && this.userId) {
    return [
      pkgCursor,
      db.collections.userActions.find({ userId: this.userId, appId: pkg.appId }),
      db.collections.grains.find({ userId: this.userId, appId: pkg.appId}),
    ];
  } else {
    return pkgCursor;
  }
});
