var counter = 0;

GrainView = function GrainView(grainId, path, token, parentElement) {
  // `path` starts with a slash and includes the query and fragment.
  //
  // Owned grains:
  // grainId, path, dep.
  //   callback sets error, openingSession on failure,
  //                 grainId, sessionId, sessionSub on success.
  //
  // Sturdyref ApiTokens:
  // grainId, path, dep.
  //   callback sets error, openingSession on failure
  //                 grainId, sessionId, sessionSub on success.
  //
  // Token-only sessions:
  // grainId, token, path, dep
  //   callback sets error, openingSession on failure
  //                 grainId, sessionId, title, and session Sub on success

  this._grainId = grainId;
  this._originalPath = path;
  this._path = path;
  this._token = token;
  this._parentElement = parentElement;
  this._status = "closed";
  this._dep = new Tracker.Dependency();

  this._userIdentityId = new ReactiveVar(undefined);
  // `false` means incognito; `undefined` means we still need to decide whether to reveal
  // an identity.

  if (token) {
    if (!Meteor.userId()) {
      this.doNotRevealIdentity();
    }
  } else {
    this.revealIdentity();
  }

  // We manage our Blaze view directly in order to get more control over when iframes get
  // re-rendered. E.g. if we were to instead use a template with {{#each grains}} iterating over
  // the list of open grains, all grains might get re-rendered whenever a grain is removed from the
  // list, which would reset all the iframe states, making users sad.
  this._blazeView = Blaze.renderWithData(Template.grainView, this, parentElement);

  this.id = counter++;
}

GrainView.prototype.reset = function (identityId) {
  // TODO(cleanup): This duplicates some code from the GrainView constructor.

  this._dep.changed();
  this.destroy();
  this._sessionId = null;
  this._sessionSalt = null;
  if (this._sessionObserver) {
    this._sessionObserver.stop();
    this._sessionObserver = undefined;
  }
  if (this._sessionSub) {
    this._sessionSub.stop();
    this._sessionSub = undefined;
  }

  this._status = "closed";
  this._userIdentityId = new ReactiveVar(undefined);
  this.revealIdentity(identityId);
  this._blazeView = Blaze.renderWithData(Template.grainView, this, this._parentElement);
}

GrainView.prototype.switchIdentity = function (identityId) {
  check(identityId, String);
  var currentIdentityId = this.identityId();
  var grainId = this.grainId();
  if (currentIdentityId === identityId) return;
  var self = this;
  if (this._token) {
    self.reset(identityId);
    self.openSession();
  } else if (this.isOwner()) {
    Meteor.call("updateGrainPreferredIdentity", grainId, identityId,
                function (err, result) {
      if (err) {
        console.log("error:", err);
      } else {
        self.reset(identityId);
        self.openSession();
      }
    });
  } else {
    if (ApiTokens.findOne({grainId: grainId,
                           "owner.user.identityId": identityId, revoked: {$ne: true}})) {
      // just do the switch
      self.reset(identityId);
      self.openSession();
    } else {
      // Should we maybe prompt the user first?
      //  "That identity does not already have access to this grain. Would you like to share access
      //   from your current identity? Y/ cancel."
      Meteor.call("newApiToken", {identityId: currentIdentityId}, grainId, "direct share",
                  {allAccess: null}, {user: {identityId: identityId, title: self.title()}},
                  function (err, result) {
        if (err) {
          console.log("error:", err);
        } else {
          self.reset(identityId);
          self.openSession();
        }
      });
    }
  }
}

GrainView.prototype.destroy = function () {
  // This must be called when the GrainView is removed from the list otherwise Blaze will go on
  // rendering the iframe forever, even if it is no longer linked into the page DOM.

  Blaze.remove(this._blazeView);
  if (this._grainSizeSub) this._grainSizeSub.stop();
}

GrainView.prototype.isActive = function () {
  this._dep.depend();
  return this._isActive;
}

GrainView.prototype.setActive = function (isActive) {
  this._isActive = isActive;
  this._dep.changed();
}

GrainView.prototype.isOldSharingModel = function () {
  this._dep.depend();
  var grain = Grains.findOne({_id: this._grainId})
  return grain && !grain.private;
}

GrainView.prototype.isOwner = function () {
  this._dep.depend();
  // See if this is one of our own grains.
  // If we're not logged in, we can't be the owner.
  if (!Meteor.userId()) return false;
  var grain = Grains.findOne({_id: this._grainId, userId: Meteor.userId()});
  return grain != undefined;
}

GrainView.prototype._isUsingAnonymously = function () {
  this._dep.depend();
  if (this.isOldSharingModel()) {
    return false;
  }
  if (!Meteor.userId() && !this._token) {
    console.error("should never happen: anonymous, but no token either.");
  }
  return !!this._token;
}

GrainView.prototype.size = function () {
  var size = GrainSizes.findOne(this._grainId);
  return size && size.size;
}

GrainView.prototype.title = function () {
  // Returns the user's name for this grain, not the browser tab title.
  // Three cases:
  // 1) We own the grain or it is public. Use the value from the Grains collection.
  // 2) We own an ApiToken for the grain.  Use the value from the ApiTokens collection.
  // 3) We are using an ApiToken for the grain.  Use the transient value stored in this._title.
  this._dep.depend();
  if (this.isOwner() || this.isOldSharingModel()) {
    // Case 1.
    var grain = Grains.findOne({_id: this._grainId});
    return grain && grain.title;
  } else if (!this._isUsingAnonymously()) {
    // Case 2.
    var apiToken = ApiTokens.findOne({grainId: this._grainId,
                                      "owner.user.identityId": this.identityId()},
                                     {sort: {created: 1}});
    return apiToken && apiToken.owner && apiToken.owner.user && apiToken.owner.user.title;
  } else {
    // Case 3.
    return this._title;
  }
}

GrainView.prototype.appTitle = function () {
  // Three cases:
  // 1) We own the grain.  Look up the app title in the package manifest.
  // 2) We own an ApiToken for the grain.  Use the value from the denormalizedGrainMetadata.
  // 3) We are using an ApiToken for the grain (either logged out or incognito).  Use the value
  //    from the TokenInfo pseudocollection.
  this._dep.depend();
  if (this.isOwner()) {
    // Case 1.
    var grain = Grains.findOne({_id: this._grainId});
    var pkg = grain && Packages.findOne({_id: grain.packageId})
    return pkg && pkg.manifest && pkg.manifest.appTitle && pkg.manifest.appTitle.defaultText;
  } else if (!this._isUsingAnonymously()) {
    // Case 2
    var token = ApiTokens.findOne({grainId: this._grainId,
                                   'owner.user.identityId': this.identityId()},
                                  {sort: {created: 1}});
    return (token && token.owner && token.owner.user && token.owner.user.denormalizedGrainMetadata &&
      token.owner.user.denormalizedGrainMetadata.appTitle.defaultText);
    // TODO(someday) - shouldn't use defaultText
  } else {
    // Case 3
    var tokenInfo = TokenInfo.findOne({_id: this._token});
    var token = ApiTokens.findOne({_id: tokenInfo.apiToken});
    return tokenInfo && tokenInfo.grainMetadata && tokenInfo.grainMetadata.appTitle &&
           tokenInfo.grainMetadata.appTitle.defaultText;
    // TODO(someday) - shouldn't use defaultText
  }
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
    return grainTitle + " · " + appTitle + " · Sandstorm";
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
  if (this._hasLoaded) {
    return true;
  }

  var session = Sessions.findOne({_id: this._sessionId});
  // TODO(soon): this is a hack to cache hasLoaded. Consider moving it to an autorun.
  this._hasLoaded = session && session.hasLoaded;

  return this._hasLoaded;
}

GrainView.prototype.origin = function () {
  this._dep.depend();
  return this._hostId && (window.location.protocol + "//" + makeWildcardHost(this._hostId));
}

GrainView.prototype.viewInfo = function () {
  this._dep.depend();
  return this._viewInfo;
}

GrainView.prototype.grainId = function () {
  this._dep.depend();
  return this._grainId;
}

GrainView.prototype.sessionId = function () {
  this._dep.depend();
  return this._sessionId;
}

GrainView.prototype.setTitle = function (newTitle) {
  this._title = newTitle;
  if (this._userIdentityId.get()) {
    Meteor.call("updateGrainTitle", this._grainId, newTitle, this._userIdentityId.get());
  }
  this._dep.changed();
}

GrainView.prototype.setPath = function (newPath) {
  this._path = newPath;
  if (this.isActive()) {
    window.history.replaceState({}, "", this.route());
  }
  this._dep.changed();
}

GrainView.prototype.depend = function () {
  this._dep.depend();
}

GrainView.prototype.revealIdentity = function (identityId) {
  if (!Meteor.user()) {
    return;
  }
  var myIdentities = SandstormDb.getUserIdentities(Meteor.user());
  var myIdentityIds = myIdentities.map(function(x) { return x._id; });
  var identity = myIdentities[0]; // Default.
  var grain = Grains.findOne(this._grainId);
  if (identityId && myIdentityIds.indexOf(identityId) != -1) {
    identity = _.findWhere(myIdentities, {_id: identityId});
  } else if (grain && myIdentityIds.indexOf(grain.identityId) != -1) {
    // If we own the grain, open it as the owning identity.
    identity = _.findWhere(myIdentities, {_id: grain.identityId});
  } else {
    var token = ApiTokens.findOne({grainId: this._grainId,
                                   "owner.user.identityId": {$in: myIdentityIds}},
                                  {sort:{"owner.user.lastUsed": -1}});
    if (token) {
      identity = _.findWhere(myIdentities, {_id: token.owner.user.identityId});
    }
  }
  this._userIdentityId.set(identity._id);
  this._dep.changed();
}

GrainView.prototype.doNotRevealIdentity = function () {
  this._userIdentityId.set(false);
  this._dep.changed();
}

GrainView.prototype.identityId = function () {
  this._dep.depend();
  var identityId = this._userIdentityId.get();
  if (identityId) {
    return identityId;
  } else {
    return null;
  }
}

GrainView.prototype._identityAlreadyRevealedToOwner = function () {
  // Returns the ID of an identity that the current user has already revealed to the owner of
  // this._token, if such an identity exists. Returns `false` otherwise.

  var grain = Grains.findOne({_id: this._grainId, userId: Meteor.userId()});
  if (grain) {
    // If we own the grain, we have revealed our identity to ourself
    return grain.identityId;
  }
  // If we own a sturdyref from the grain owner, we have revealed our identity to that grain owner
  // TODO(soon): Base this decision on the contents of the Contacts collection.
  var tokenInfo = TokenInfo.findOne({_id: this._token});
  if (tokenInfo && tokenInfo.apiToken) {
    var identities = SandstormDb.getUserIdentities(Meteor.user());
    var identityIds = identities.map(function(x) { return x._id; });
    if (identityIds.indexOf(tokenInfo.apiToken.identityId) != -1) {
      // A self-share.
      return tokenInfo.apiToken.identityId;
    }
    var otherToken = ApiTokens.findOne({identityId: tokenInfo.apiToken.identityId,
                                        "owner.user.identityId": {$in: identityIds}});
    if (otherToken) {
      return otherToken.owner.user.identityId;
    }
  }
  return false;
}

GrainView.prototype.shouldShowInterstitial = function () {
  this._dep.depend();

  // We only show the interstitial for /shared/ routes.
  if (!this._token) {
    return false;
  }

  // If we have explictly set _userIdentityId, we don't need to show the interstitial.
  if (this._userIdentityId.get() !== undefined) {
    return false;
  }
  // If we are not logged in, we don't need to show the interstitial - we'll go incognito by default.
  if (!Meteor.userId()) {
    return false;
  }
  // Otherwise, we should show it.
  return true;
}

GrainView.prototype._addSessionObserver = function (sessionId) {
  var self = this;
  self._sessionSub = Meteor.subscribe("sessions", sessionId);
  self._sessionObserver = Sessions.find({_id : sessionId}).observe({
    removed: function(session) {
      self._sessionSub.stop();
      self._sessionSub = undefined;
      self._status = "closed";
      self._dep.changed();
      if (self._sessionObserver) {
        self._sessionObserver.stop();
      }
      Meteor.defer(function () { self.openSession(); });
    },
    changed: function(session) {
      self._viewInfo = session.viewInfo || self._viewInfo;
      self._permissions = session.permissions || self._permissions;
      self._dep.changed();
    },
    added: function(session) {
      self._viewInfo = session.viewInfo || self._viewInfo;
      self._permissions = session.permissions || self._permissions;
      self._status = "opened";
      self._dep.changed();
    }
  });

}

GrainView.prototype._openGrainSession = function () {
  var self = this;
  var identityId = self.identityId();
  Meteor.call("openSession", self._grainId, identityId, self._sessionSalt, function(error, result) {
    if (error) {
      console.error("openSession error", error);
      self._error = error.message;
      self._status = "error";
      self._dep.changed();
    } else {
      // result is an object containing sessionId, initial title, and grainId.
      if (result.title) {
        self._title = result.title;
      }
      self._grainId = result.grainId;
      self._sessionId = result.sessionId;
      self._hostId = result.hostId;
      self._sessionSalt = result.salt;

      self._addSessionObserver(result.sessionId);

      if (self._grainSizeSub) self._grainSizeSub.stop();
      self._grainSizeSub = Meteor.subscribe("grainSize", result.grainId);
      self._dep.changed();
    }
  });
}

function onceConditionIsTrue(condition, continuation) {
  Tracker.nonreactive(function () {
    Tracker.autorun(function(handle) {
      if (!condition()) {
        return;
      }
      handle.stop();
      Tracker.nonreactive(continuation);
    });
  });
}

GrainView.prototype._openApiTokenSession = function () {
  var self = this;
  function condition() { return self._userIdentityId.get() !== undefined; }
  onceConditionIsTrue(condition, function () {
    var identityId = self.identityId();
    var openSessionArg = {
      token: self._token,
      incognito: !identityId,
    };
    Meteor.call("openSessionFromApiToken", openSessionArg, identityId, self._sessionSalt,
                function(error, result) {
      if (error) {
        console.log("openSessionFromApiToken error");
        self._error = error.message;
        self._status = "error";
        self._dep.changed();
      } else if (result.redirectToGrain) {
        console.log("openSessionFromApiToken redirectToGrain");
        self._grainId = result.redirectToGrain;
        self._dep.changed();

        // We should remove this tab from the tab list, since the /grain/<grainId> route
        // will set up its own tab for this grain.  There could even already be a tab open, if the
        // user reuses a /shared/ link.
        self.destroy();
        var allGrains = globalGrains.get();
        for (var i = 0 ; i < allGrains.length ; i++) {
          if (allGrains[i] === self) {
            allGrains.splice(i, 1);
            globalGrains.set(allGrains);
          }
        }

        // OK, go to the grain.
        return Router.go("/grain/" + result.redirectToGrain + self._path, {}, {replaceState: true});
      } else {
        // We are viewing this via just the /shared/ link, either as an anonymous user on in our
        // incognito mode (since we'd otherwise have redeemed the token and been redirected).
        console.log("openSessionFromApiToken success");
        self._title = result.title;
        self._grainId = result.grainId;
        self._sessionId = result.sessionId;
        self._hostId = result.hostId;
        self._sessionSalt = result.salt;
        self._addSessionObserver(result.sessionId);
        self._dep.changed();
      }
    });
  });
}

GrainView.prototype.openSession = function () {
  if (this._status !== "closed") {
    console.error("GrainView: openSession() called but state was " + this._status);
    return;
  }
  this._status = "opening";
  if (this._token === undefined) {
    // Opening a grain session.
    this._openGrainSession();
  } else {
    // Opening an ApiToken session.  Only do so if we don't need to show the interstitial first.
    this._openApiTokenSession();
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
    return "/shared/" + this._token + this._path;
  } else {
    return "/grain/" + this._grainId + this._path;
  }
}

GrainView.prototype._fallbackIdenticon = function () {
  // identifier is SHA1("");
  return Identicon.identiconForApp("da39a3ee5e6b4b0d3255bfef95601890afd80709", "grain");
}

GrainView.prototype._urlForAsset = function (assetId) {
  return window.location.protocol + "//" + makeWildcardHost('static') + "/" + assetId;
}

GrainView.prototype.iconSrc = function() {
  // Several options here:
  // 1. We own the grain.  Look up the icon metadata in the Package manifest (or DevPackage if applicable).
  // 2. We own an Api token for the grain.  Use the denormalizedGrainMetadata.
  // 3. We're using an ApiToken anonymously.  Use the data from the TokenInfo pseudocollection.
  this._dep.depend();
  if (this.isOwner()) {
    // Case 1
    var grain = Grains.findOne({_id: this._grainId});
    if (grain) {
      var pkg = DevPackages.findOne({appId: grain.appId}) ||
                Packages.findOne({_id: grain.packageId});
      if (pkg) return Identicon.iconSrcForPackage(pkg, "grain", makeWildcardHost('static'));
    }
  } else if (!this._isUsingAnonymously()) {
    // Case 2
    var apiToken = ApiTokens.findOne({grainId: this._grainId, 'owner.user.userId': Meteor.userId()},
                                     {sort: {created: 1}});
    if (apiToken) {
      var meta = apiToken.owner.user.denormalizedGrainMetadata;
      if (meta && meta.icon && meta.icon.assetId) return this._urlForAsset(meta.icon.assetId);
      if (meta && meta.appId) return Identicon.identiconForApp(meta.appId, "grain");
    }
  } else {
    // Case 3
    var tokenInfo = TokenInfo.findOne({_id: this._token});
    if (tokenInfo && tokenInfo.grainMetadata) {
      var meta = tokenInfo.grainMetadata;
      if (meta.icon) return this._urlForAsset(meta.icon.assetId);
      if (meta.appId) return Identicon.identiconForApp(meta.appId, "grain");
    }
  }

  if (this._token) {
    // The TokenInfo collection includes some safe denormalized grain metadata.
  } else {
  }
  // None of our other info sources were available.  Weird.  Show a fallback identicon.
  return this._fallbackIdenticon();
}

GrainView.prototype.setFrameTitle = function (newFrameTitle) {
  this._frameTitle = newFrameTitle;
  this._dep.changed();
}

GrainView.prototype.token = function () {
  this._dep.depend();
  return this._token;
}

GrainView.prototype.generatedApiToken = function () {
  this._dep.depend();
  return this._generatedApiToken;
}

GrainView.prototype.setGeneratedApiToken = function(newApiToken) {
  this._generatedApiToken = newApiToken;
  this._dep.changed();
}
