// TODO(cleanup): Make this class client-only since it does nothing useful on the server.
SandstormGrainList = function (db, quotaEnforcer) {
  this._filter = new ReactiveVar("");
  this._staticHost = db.makeWildcardHost('static');
  this._db = db;
  this._quotaEnforcer = quotaEnforcer;
};
