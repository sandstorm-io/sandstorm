GrainView = function GrainView(grainId, path, query, hash, token) {
  // Owned grains:
  // grainId, path, query, hash, dep.
  //   callback sets error, openingSession on failure,
  //                 grainId, sessionId, sessionSub on success.
  //
  // Sturdyref ApiTokens:
  // grainId, path, query, hash, dep.
  //   callback sets error, openingSession on failure
  //                 grainId, sessionId, sessionSub on success.
  //
  // Token-only sessions:
  // grainId, token, path, query, hash, dep
  //   callback sets error, openingSession on failure
  //                 grainId, sessionId, title, and session Sub on success

  this._grainId = grainId;
  this._originalPath = path;
  this._originalQuery = query;
  this._originalHash = hash;
  this._token = token;

  this._tokenOnly = token !== undefined;
  this._status = "closed";
  this._revealIdentity = undefined; // set to true or false to make explicit
  this._dep = new Tracker.Dependency();
}

GrainView.prototype.isActive = function () {
  this._dep.depend();
  return this._isActive;
}

GrainView.prototype.setActive = function (isActive) {
  this._isActive = isActive;
  this._dep.changed();
}

GrainView.prototype.isOwner = function () {
  // See if this is one of our own grains.
  var grain = Grains.findOne({_id: this._grainId, userId: Meteor.userId()});
  return grain != undefined;
}

GrainView.prototype.size = function () {
  var size = GrainSizes.findOne(this._sessionId);
  return size && size.size;
}

GrainView.prototype.title = function () {
  // Three cases:
  // 1) We own the grain.  Use the value from the Grains collection.
  // 2) We own an ApiToken for the grain.  Use the value from the ApiTokens collection.
  // 3) We are using an ApiToken for the grain.  Use the transient value stored in this._title.
  var grain = Grains.findOne({_id: this._grainId, userId: Meteor.userId()});
  if (grain) {
    // Case 1.
    return grain.title;
  }
  var apiToken = ApiTokens.findOne({grainId: this._grainId, "owner.user.userId": Meteor.userId()},
                                   {sort: {created: 1}});
  if (apiToken) {
    // Case 2.
    return apiToken && apiToken.owner && apiTOken.owner.user && apiToken.owner.user.title;
  }
  // Case 3.
  return this._title;
}

GrainView.prototype.appTitle = function () {
  this._dep.depend();
  if (this._token) {
    var tokenInfo = TokenInfo.findOne({_id: this._token});
    var token = ApiTokens.findOne({_id: tokenInfo.apiToken});
    return tokenInfo && tokenInfo.grainMetadata && tokenInfo.grainMetadata.appTitle &&
           tokenInfo.grainMetadata.appTitle.defaultText;
    // TODO(someday) - shouldn't use defaultText
  } else {
    var grain = Grains.findOne({_id: this._grainId});
    if (grain) {
      var pkg = Packages.findOne({_id: grain.packageId})
      appTitle = pkg && pkg.manifest && pkg.manifest.appTitle && pkg.manifest.appTitle.defaultText;
    }
    var token = ApiTokens.findOne({grainId: this._grainId, 'owner.user.userId': Meteor.userId()},
                                     {sort: {created: 1}});
    if (token && token.owner && token.owner.user && token.owner.user.denormalizedGrainMetadata) {
      return token.owner.user.denormalizedGrainMetadata.appTitle.defaultText;
      // TODO(someday) - shouldn't use defaultText
    }
  }
  return undefined;
}

GrainView.prototype.frameTitle = function () {
  this._dep.depend();
  if (this._frameTitle !== undefined) {
    return this._frameTitle;
  }
  var appTitle = this.appTitle();
  var grainTitle = this.title();
  // Actually set the values
  if (appTitle && grainTitle) {
    return appTitle + " · " + grainTitle + " · Sandstorm";
  } else if (grainTitle) {
    return grainTitle + " · Sandstorm";
  } else {
    return "Sandstorm";
  }
}

GrainView.prototype.updateDocumentTitle = function () {
  this._dep.depend();
  document.title = this.frameTitle();
}

GrainView.prototype.showPowerboxOffer = function () {
  //TODO(now): implement
}

GrainView.prototype.error = function () {
  this._dep.depend();
  return this._error;
}

GrainView.prototype.hasLoaded = function () {
  this._dep.depend();
  var session = Sessions.findOne({_id: this._sessionId});
  return session && session.hasLoaded;
}

GrainView.prototype.origin = function () {
  this._dep.depend();
  var session = Sessions.findOne({_id: this._sessionId});
  return session && (window.location.protocol + "//" + makeWildcardHost(session.hostId));
}

GrainView.prototype.viewInfo = function () {
  this._dep.depend();
  var session = Sessions.findOne({_id: this._sessionId});
  return session && session.viewInfo;
}

GrainView.prototype.grainId = function () {
  this._dep.depend();
  return this._grainId;
}

GrainView.prototype.sessionId = function () {
  this._dep.depend();
  return this._sessionId;
}

GrainView.prototype.setSessionId = function (newSessionId) {
  // This should only be called by an openSession callback
  this._sessionId = newSessionId;
  this._dep.changed();
}

GrainView.prototype.setTitle = function (newTitle) {
  // if we own the grain, set the grain title
  var grain = Grains.findOne({_id: this._grainId, userId: Meteor.userId()});
  if (grain) {
    // Case 1.
    // TODO(someday): remove the allow/deny rules and make this a Meteor method
    Grains.update(this._grainId, {$set: {title: newTitle}});
    return;
  }
  // if we don't own the grain, but have an owned token, set owner.user.title
  var token = ApiTokens.findOne({grainId: this.grainId, objectId: {$exists: false},
                                "owner.user.userId": Meteor.userId()},
                                {sort:{created:1}});
  if (token) {
    ApiTokens.update(token._id, {$set: {"owner.user.title": newTitle}});
    return;
  }
  // if we're just using the token anonymously, just set our in-memory title
  this._title = newTitle;
}

GrainView.prototype.depend = function () {
  this._dep.depend();
}

GrainView.prototype.setRevealIdentity = function (revealIdentity) {
  this._revealIdentity = revealIdentity;
  this._dep.changed();
}

GrainView.prototype._openSession = function () {
  if (this._status !== "closed") {
    console.error("_openSession called but state was " + this._status);
  }
  this._status = "opening";
  var self = this;
  if (self._token == undefined) {
    // Opening a grain session.
    Meteor.call("openSession", self._grainId, function(error, result) {
      if (error) {
        console.log("openSession error");
        self._error = error.message;
        self._status = "error";
        self.dep.changed();
      } else {
        // result is an object containing sessionId, initial title, and grainId.
        console.log("openSession success");
        console.log(result);
        if (result.title) {
          console.log("Title provided for grain session by ID?");
          self._title = result.title;
        }
        self._grainId = result.grainId;
        self._sessionId = result.sessionId;
        var subscription = Meteor.subscribe("sessions", result.sessionId);
        Sessions.find({_id : result.sessionId}).observeChanges({
          removed: function(session) {
            self._sessionSub.stop();
            self._sessionSub = undefined;
            self._status = "closed";
            self._dep.changed();
          },
          added: function(session) {
            self._status = "opened";
            self._dep.changed();
          }
        });
        self._sessionSub = subscription;
        self._grainSizeSub = Meteor.subscribe("grainSize", result.sessionId);
        self._dep.changed();
      }
    });
  } else {
    // Opening an ApiToken session.
    var openSessionArg = {
      token: token,
      incognito: !this._revealIdentity, // TODO: read from self._revealIdentity
    };
    Meteor.call("openSessionFromApiToken", openSessionArg, function(error, result) {
      if (error) {
        console.log("openSessionFromApiToken error");
        self._error = error.message;
        self._status = "error";
        self._dep.changed();
      } else if (result.redirectToGrain) {
        console.log("openSessionFromApiToken redirectToGrain");
        self._tokenOnly = false;
        self._grainId = result.redirectToGrain;
        self._dep.changed();
        // Make sure to carry over any within-grain path.
        var routeParams = { grainId: result.redirectToGrain };
        if (self._path) {
          routeParams.path = grainState.path;
        }
        var urlParams = {};
        if (self._query) {
          urlParams.query = grainState.query;
        }
        if (self._hash) {
          urlParams.hash = grainState.hash;
        }
        // TODO(now): We should remove this tab from the tab list, since the /grain/<grainId> route
        // will set up its own for this grain.  Maybe there's even such a tab already open.
        // OK, go to the grain.
        return Router.go("grain", routeParams, urlParams);
      } else {
        // We are viewing this via just the /shared/ link, either as an anonymous user on in our
        // incognito mode (since we'd otherwise have redeemed the token and been redirected).
        self._tokenOnly = true;
        // If this session is tokenOnly, then we will use the cached title and sessionId, rather than
        // looking them up in collections that we won't have subscriptions for.
        console.log("openSessionFromApiToken success");
        console.log(result);
        self._title = result.title;
        self._grainId = result.grainId;
        self._sessionId = result.sessionId;
        var subscription = Meteor.subscribe("sessions", result.sessionId);
        Sessions.find({_id : result.sessionId}).observeChanges({
          removed: function(session) {
            console.log("session removed");
            subscription.stop();
            self._sessionSub = undefined;
            self._status = "closed";
            self._dep.changed();
          },
          added: function(session) {
            console.log("session added");
            self._status = "opened";
            self._dep.changed();
          }
        });
        grainState._sessionSub = subscription;
        grainState._dep.changed();
      }
    });
  }
}

GrainView.prototype.sessionStatus = function () {
  // "opening", "opened", "closed"
  this._dep.depend();
  return this._status;
}

GrainView.prototype.route = function () {
  this._dep.depend();
  if (this._token) {
    return "/shared/" + this._token;
  } else {
    return "/grain/" + this._grainId;
  }
}

GrainView.prototype._fallbackIdenticon = function () {
  // identifier is SHA1("");
  return Identicon.identiconForApp("da39a3ee5e6b4b0d3255bfef95601890afd80709", "grain");
}

GrainView.prototype.iconSrc = function() {
  this._dep.depend();
  if (this._token) {
    // The TokenInfo collection includes some safe denormalized grain metadata.
    var tokenInfo = TokenInfo.findOne({_id: this._token});
    if (tokenInfo && tokenInfo.grainMetadata) {
      var meta = tokenInfo.grainMetadata;
      if (meta.icon) return meta.icon.assetId;
      if (meta.appId) return Identicon.identiconForApp(meta.appId, "grain");
    }
  } else {
    var grain = Grains.findOne({_id: this._grainId});
    if (grain) {
      var pkg = Packages.findOne({_id: grain.packageId});
      if (pkg) return Identicon.iconSrcForPackage(pkg, "grain", makeWildcardHost('static'));
    }
    var apiToken = ApiTokens.findOne({grainId: this._grainId, 'owner.user.userId': Meteor.userId()},
                                     {sort: {created: 1}});
    if (apiToken) {
      var meta = apiToken.owner.user.denormalizedGrainMetadata;
      if (meta && meta.icon && meta.icon.assetId) return meta.icon.assetId;
      if (meta && meta.appId) return Identicon.identiconForApp(meta.appId, "grain");
    }
  }
  // None of our other info sources were available.  Weird.  Show a fallback identicon.
  return this._fallbackIdenticon();
}

GrainView.prototype.setFrameTitle = function (newFrameTitle) {
  this._frameTitle = newFrameTitle;
  this._dep.changed();
}
