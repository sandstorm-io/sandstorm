SandstormAppDetails = function(db, quotaEnforcer, appId) {
    this._db = db;
    this._quotaEnforcer = quotaEnforcer;
    this._appId = appId;

    this._filter = new ReactiveVar("");
    this._sortOrder = new ReactiveVar([]);
    this._staticHost = db.makeWildcardHost("static");

    this._keybaseSubscription = undefined;

    this._newGrainIsLaunching = new ReactiveVar(false);
    this._showPublisherDetails = new ReactiveVar(false);
}
