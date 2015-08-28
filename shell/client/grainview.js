var counter = 0;

GrainView = function GrainView(grainId, path, query, hash, token, parentElement) {
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
  this._path = this._originalPath;
  this._originalQuery = query;
  this._originalHash = hash;
  this._token = token;

  this._status = "closed";
  this._revealIdentity = new ReactiveVar(undefined); // set to true or false to make explicit

  if (token) {
    if (!Meteor.userId()) {
      this._revealIdentity.set(false);
    } else if (this._isIdentityAlreadyRevealedToOwner()) {
      this._revealIdentity.set(true);
    }
  }

  this._dep = new Tracker.Dependency();

  // We manage our Blaze view directly in order to get more control over when iframes get
  // re-rendered. E.g. if we were to instead use a template with {{#each grains}} iterating over
  // the list of open grains, all grains might get re-rendered whenever a grain is removed from the
  // list, which would reset all the iframe states, making users sad.
  this._blazeView = Blaze.renderWithData(Template.grainView, this, parentElement);

  this.id = counter++;
}

GrainView.prototype.destroy = function () {
  // This must be called when the GrainView is removed from the list otherwise Blaze will go on
  // rendering the iframe forever, even if it is no longer linked into the page DOM.

  Blaze.remove(this._blazeView);
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
  var size = GrainSizes.findOne(this._sessionId);
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
    var apiToken = ApiTokens.findOne({grainId: this._grainId, "owner.user.userId": Meteor.userId()},
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
    var token = ApiTokens.findOne({grainId: this._grainId, 'owner.user.userId': Meteor.userId()},
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

GrainView.prototype.setTitle = function (newTitle) {
  Meteor.call("updateGrainTitle", this._grainId, newTitle);
  this._title = newTitle;
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

GrainView.prototype.setRevealIdentity = function (revealIdentity) {
  this._revealIdentity.set(revealIdentity);
  this._dep.changed();
}

GrainView.prototype.shouldRevealIdentity = function () {
  this._dep.depend();
  return this._revealIdentity.get();
}

GrainView.prototype._isIdentityAlreadyRevealedToOwner = function () {
  // If we own the grain, we have revealed our identity to ourself
  if (Grains.findOne({_id: this._grainId, userId: Meteor.userId()})) {
    return true;
  }
  // If we own a sturdyref from the grain owner, we have revealed our identity to that grain owner
  // TODO(soon): Base this decision on the contents of the Contacts collection.
  var tokenInfo = TokenInfo.findOne({_id: this._token});
  if (tokenInfo && tokenInfo.apiToken &&
     ApiTokens.findOne({userId: tokenInfo.apiToken.userId, "owner.user.userId": Meteor.userId()})) {
    return true;
  }
  return false;
}

GrainView.prototype.shouldShowInterstitial = function () {
  this._dep.depend();
  // If we have explictly set _revealIdentity, we don't need to show the interstitial.
  if (this._revealIdentity.get() !== undefined) {
    return false;
  }
  // If we are not logged in, we don't need to show the interstitial - we'll go incognito by default.
  if (!Meteor.userId()) {
    return false;
  }
  // If we have already revealed our identity to the grain's owner, we don't need to show the
  // interstitial, we can ask to reveal our identity without consequence.
  if (this._isIdentityAlreadyRevealedToOwner()) {
    return false;
  }

  // Otherwise, we should show it.
  return true;
}

GrainView.prototype._openGrainSession = function () {
  var self = this;
  Meteor.call("openSession", self._grainId, function(error, result) {
    if (error) {
      console.log("openSession error");
      self._error = error.message;
      self._status = "error";
      self._dep.changed();
    } else {
      // result is an object containing sessionId, initial title, and grainId.
      console.log("openSession success");
      console.log(result);
      if (result.title) {
        self._title = result.title;
      }
      self._grainId = result.grainId;
      self._sessionId = result.sessionId;
      self._sessionSub = Meteor.subscribe("sessions", result.sessionId);
      Sessions.find({_id : result.sessionId}).observeChanges({
        removed: function(session) {
          self._sessionSub.stop();
          self._sessionSub = undefined;
          self._status = "closed";
          self._dep.changed();
          Meteor.defer(function () { self.openSession(); });
        },
        added: function(session) {
          self._status = "opened";
          self._dep.changed();
        }
      });
      self._grainSizeSub = Meteor.subscribe("grainSize", result.sessionId);
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
  function condition() { return self._revealIdentity.get() !== undefined; }
  onceConditionIsTrue(condition, function () {
    var openSessionArg = {
      token: self._token,
      incognito: !self._revealIdentity.get(),
    };
    Meteor.call("openSessionFromApiToken", openSessionArg, function(error, result) {
      if (error) {
        console.log("openSessionFromApiToken error");
        self._error = error.message;
        self._status = "error";
        self._dep.changed();
      } else if (result.redirectToGrain) {
        console.log("openSessionFromApiToken redirectToGrain");
        self._grainId = result.redirectToGrain;
        self._dep.changed();
        // Make sure to carry over any within-grain path.
        var routeParams = { grainId: result.redirectToGrain };
        if (self._originalPath) {
          routeParams.path = self._originalPath;
        }
        var urlParams = {};
        if (self._originalQuery) {
          urlParams.query = self._originalQuery;
        }
        if (self._originalHash) {
          urlParams.hash = self._originalHash;
        }
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
        return Router.go("grain", routeParams, urlParams);
      } else {
        // We are viewing this via just the /shared/ link, either as an anonymous user on in our
        // incognito mode (since we'd otherwise have redeemed the token and been redirected).
        console.log("openSessionFromApiToken success");
        self._title = result.title;
        self._grainId = result.grainId;
        self._sessionId = result.sessionId;
        self._sessionSub = Meteor.subscribe("sessions", result.sessionId);
        Sessions.find({_id : result.sessionId}).observeChanges({
          removed: function(session) {
            self._sessionSub.stop();
            self._sessionSub = undefined;
            self._status = "closed";
            self._dep.changed();
            Meteor.defer(function () { self.openSession(); });
          },
          added: function(session) {
            self._status = "opened";
            self._dep.changed();
          }
        });
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
  // 1. We own the grain.  Look up the icon metadata in the Package manifest.
  // 2. We own an Api token for the grain.  Use the denormalizedGrainMetadata.
  // 3. We're using an ApiToken anonymously.  Use the data from the TokenInfo pseudocollection.
  this._dep.depend();
  if (this.isOwner()) {
    // Case 1
    var grain = Grains.findOne({_id: this._grainId});
    if (grain) {
      var pkg = Packages.findOne({_id: grain.packageId});
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
