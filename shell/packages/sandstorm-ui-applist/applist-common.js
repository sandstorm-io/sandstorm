SandstormAppList = function(db) {
  this._filter = new ReactiveVar("");
  this._sortOrder = new ReactiveVar([["appTitle", "desc"]]);
  this._staticHost = db.makeWildcardHost("static");
  this._db = db;
}
