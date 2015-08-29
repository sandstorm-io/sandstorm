// TODO(cleanup): Make this class client-only since it does nothing useful on the server.
SandstormAppList = function(db, quotaEnforcer, highlight) {
  this._filter = new ReactiveVar("");
  this._sortOrder = new ReactiveVar([["appTitle", 1]]);
  this._staticHost = db.makeWildcardHost("static");
  this._db = db;
  this._quotaEnforcer = quotaEnforcer;
  this._highlight = highlight;
}
