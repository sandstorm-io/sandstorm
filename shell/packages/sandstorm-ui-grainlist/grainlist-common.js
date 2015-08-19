SandstormGrainList = function (db) {
  this._filter = new ReactiveVar("");
  this._staticHost = db.makeWildcardHost('static');
  this._db = db;
};
