Meteor.publish("packageInfo", function (packageId) {
  check(packageId, String);
  const db = this.connection.sandstormDb;
  const pkgCursor = db.collections.packages.find(packageId);
  const pkg = pkgCursor.fetch()[0];
  if (pkg && this.userId) {
    return [
      pkgCursor,
      db.collections.userActions.find({ userId: this.userId, appId: pkg.appId }),
      db.collections.grains.find({ userId: this.userId, appId: pkg.appId }),
    ];
  } else {
    return pkgCursor;
  }
});
