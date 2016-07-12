// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

const Crypto = Npm.require("crypto");
const Capnp = Npm.require("capnp");
const Url = Npm.require("url");

const PersistentHandle = Capnp.importSystem("sandstorm/supervisor.capnp").PersistentHandle;
const SandstormCore = Capnp.importSystem("sandstorm/supervisor.capnp").SandstormCore;
const SandstormCoreFactory = Capnp.importSystem("sandstorm/backend.capnp").SandstormCoreFactory;
const PersistentOngoingNotification = Capnp.importSystem("sandstorm/supervisor.capnp").PersistentOngoingNotification;
const PersistentUiView = Capnp.importSystem("sandstorm/persistentuiview.capnp").PersistentUiView;
const StaticAsset = Capnp.importSystem("sandstorm/grain.capnp").StaticAsset;
const SystemPersistent = Capnp.importSystem("sandstorm/supervisor.capnp").SystemPersistent;

class SandstormCoreImpl {
  constructor(grainId) {
    this.grainId = grainId;
  }

  restore(sturdyRef) {
    return inMeteor(() => {
      const hashedSturdyRef = hashSturdyRef(sturdyRef);
      const token = ApiTokens.findOne({
        _id: hashedSturdyRef,
        "owner.grain.grainId": this.grainId,
      });

      if (!token) {
        throw new Error("no such token");
      }

      if (token.owner.grain.introducerIdentity) {
        throw new Error("Cannot restore grain-owned sturdyref that contains the obsolete " +
                        "introducerIdentity field. Please request a new capability.");
      }

      return restoreInternal(sturdyRef,
                             { grain: Match.ObjectIncluding({ grainId: this.grainId }) },
                             [], hashedSturdyRef);
    });
  }

  drop(sturdyRef) {
    return inMeteor(() => {
      return dropInternal(sturdyRef, { grain: Match.ObjectIncluding({ grainId: this.grainId }) });
    });
  }

  makeToken(ref, owner, requirements) {
    const _this = this;
    return inMeteor(() => {
      const sturdyRef = new Buffer(generateSturdyRef());
      const hashedSturdyRef = hashSturdyRef(sturdyRef);
      ApiTokens.insert({
        _id: hashedSturdyRef,
        grainId: _this.grainId,
        objectId: ref,
        owner: owner,
        created: new Date(),
        requirements: requirements,
      });

      return {
        token: sturdyRef,
      };
    });
  }

  makeChildToken(parent, owner, requirements) {
    const _this = this;
    return inMeteor(() => {
      return {
        token: new Buffer(makeChildTokenInternal(parent, owner, requirements)),
      };
    });
  }

  getOwnerNotificationTarget() {
    const grainId = this.grainId;
    return {
      owner: {
        addOngoing: (displayInfo, notification) => {
          return inMeteor(() => {
            const grain = Grains.findOne({ _id: grainId });
            if (!grain) {
              throw new Error("Grain not found.");
            }

            const castedNotification = notification.castAs(PersistentOngoingNotification);
            const wakelockToken = waitPromise(castedNotification.save()).sturdyRef;

            // We have to close both the casted cap and the original. Perhaps this should be fixed in
            // node-capnp?
            castedNotification.close();
            notification.close();
            const notificationId = Notifications.insert({
              ongoing: wakelockToken,
              grainId: grainId,
              userId: grain.userId,
              text: displayInfo.caption,
              timestamp: new Date(),
              isUnread: true,
            });

            const persistentMethods = {
              save(params) {
                return saveFrontendRef({ notificationHandle: notificationId }, params.sealFor);
              },
            };

            return { handle: makeNotificationHandle(notificationId, false, persistentMethods) };
          });
        },
      },
    };
  }

  backgroundActivity(event) {
    return inMeteor(() => {
      logActivity(this.grainId, null, event);
    });
  }
}

const makeSandstormCore = (grainId) => {
  return new Capnp.Capability(new SandstormCoreImpl(grainId), SandstormCore);
};

class NotificationHandle {
  constructor(notificationId, saved, persistentMethods) {
    this.notificationId = notificationId;
    this.saved = saved;
    _.extend(this, persistentMethods);
  }

  close() {
    const _this = this;
    return inMeteor(() => {
      if (!_this.saved) {
        dismissNotification(_this.notificationId);
      }
    });
  }
}

const PROTOCOL = Url.parse(process.env.ROOT_URL).protocol;

class StaticAssetImpl {
  constructor(assetId) {
    check(assetId, String);
    this._protocol = PROTOCOL.slice(0, -1);
    this._hostPath = makeWildcardHost("static") + "/" + assetId;
  }

  getUrl() {
    return { protocol: this._protocol, hostPath: this._hostPath, };
  }
}

class IdenticonStaticAssetImpl {
  constructor(hash, size) {
    check(hash, String);
    check(size, Match.Integer);
    this._protocol = PROTOCOL.slice(0, -1);
    this._hostPath =  makeWildcardHost("static") + "/identicon/" + hash + "?s=" + size;
  }

  getUrl() {
    return { protocol: this._protocol, hostPath: this._hostPath, };
  }
}

class PersistentUiViewImpl {
  constructor(persistentMethods, grainId) {
    check(grainId, String);
    this._grainId = grainId;
    _.extend(this, persistentMethods);
  }

  getViewInfo() {
    return inMeteor(() => {
      const grain = Grains.findOne({ _id: this._grainId, trashed: { $exists: false }, });
      if (!grain) {
        throw new Error("grain no longer exists");
      }

      const pkg = Packages.findOne({ _id: grain.packageId });
      const manifest = pkg.manifest || {};

      const viewInfo = grain.cachedViewInfo || {};

      if (!viewInfo.appTitle) {
        viewInfo.appTitle = manifest.appTitle || {};
      }

      if (!viewInfo.grainIcon) {
        const grainIcon = ((manifest.metadata || {}).icons || {}).grain;
        if (grainIcon) {
          viewInfo.grainIcon = new Capnp.Capability(new StaticAssetImpl(grainIcon.assetId),
                                                    StaticAsset);
        } else {
          const hash = Identicon.hashAppIdForIdenticon(pkg.appId);
          viewInfo.grainIcon = new Capnp.Capability(new IdenticonStaticAssetImpl(hash, 24),
                                                    StaticAsset);
        }
      }

      return viewInfo;
    });
  }

  // All other UiView methods are currently unimplemented, which, while not strictly correct,
  // results in the same overall behavior, since users can't call restore() on a PersistentUiView,
  // and grains can't call methods on UiViews because they lack the "is human" pseudopermission.
}

const makePersistentUiView = function (persistentMethods, grainId) {
  check(grainId, String);
  if (!Grains.findOne({ _id: grainId, trashed: { $exists: false }, })) {
    throw new Meteor.Error(404, "grain not found");
  }

  return new Capnp.Capability(new PersistentUiViewImpl(persistentMethods, grainId),
                              PersistentUiView);
};

function makeNotificationHandle(notificationId, saved, persistentMethods) {
  return new Capnp.Capability(new NotificationHandle(notificationId, saved, persistentMethods),
                              PersistentHandle);
}

function dropWakelock(grainId, wakeLockNotificationId) {
  waitPromise(globalBackend.useGrain(grainId, (supervisor) => {
    return supervisor.drop({ wakeLockNotification: wakeLockNotificationId });
  }));
}

function dismissNotification(notificationId, callCancel) {
  const notification = Notifications.findOne({ _id: notificationId });
  if (notification) {
    Notifications.remove({ _id: notificationId });
    if (notification.ongoing) {
      // For some reason, Mongo returns an object that looks buffer-like, but isn't a buffer.
      // Only way to fix seems to be to copy it.
      const id = new Buffer(notification.ongoing);

      if (!callCancel) {
        dropInternal(id, { frontend: null });
      } else {
        const notificationCap = restoreInternal(id, { frontend: null }, []).cap;
        const castedNotification = notificationCap.castAs(PersistentOngoingNotification);
        dropInternal(id, { frontend: null });
        try {
          waitPromise(castedNotification.cancel());
          castedNotification.close();
          notificationCap.close();
        } catch (err) {
          if (err.kjType !== "disconnected") {
            // ignore disconnected errors, since cancel may shutdown the grain before the supervisor
            // responds.
            throw err;
          }
        }
      }
    } else if (notification.appUpdates) {
      _.forEach(notification.appUpdates, (app, appId) => {
        globalDb.deleteUnusedPackages(appId);
      });
    }
  }
}

hashSturdyRef = (sturdyRef) => {
  return Crypto.createHash("sha256").update(sturdyRef).digest("base64");
};

function generateSturdyRef() {
  return Random.secret();
}

Meteor.methods({
  dismissNotification(notificationId) {
    // This will remove notifications from the database and from view of the user.
    // For ongoing notifications, it will begin the process of cancelling and dropping them from
    // the app.

    check(notificationId, String);

    const notification = Notifications.findOne({ _id: notificationId });
    if (!notification) {
      throw new Meteor.Error(404, "Notification id not found.");
    } else if (notification.userId !== Meteor.userId()) {
      throw new Meteor.Error(403, "Notification does not belong to current user.");
    } else {
      dismissNotification(notificationId, true);
    }
  },

  readAllNotifications() {
    // Marks all notifications as read for the current user.
    if (!Meteor.userId()) {
      throw new Meteor.Error(403, "User not logged in.");
    }

    Notifications.update({ userId: Meteor.userId() }, { $set: { isUnread: false } }, { multi: true });
  },
});

saveFrontendRef = (frontendRef, owner, requirements) => {
  return inMeteor(() => {
    const sturdyRef = new Buffer(generateSturdyRef());
    const hashedSturdyRef = hashSturdyRef(sturdyRef);
    ApiTokens.insert({
      _id: hashedSturdyRef,
      frontendRef: frontendRef,
      owner: owner,
      created: new Date(),
      requirements: requirements,
    });
    return { sturdyRef: sturdyRef };
  });
};

checkRequirements = (requirements) => {
  if (!requirements) {
    return true;
  }

  for (let i in requirements) {
    const requirement = requirements[i];
    if (requirement.tokenValid) {
      const token = ApiTokens.findOne({ _id: requirement.tokenValid, revoked: { $ne: true }, },
                                      { fields: { requirements: 1 } });
      if (!token || !checkRequirements(token.requirements)) {
        return false;
      }

      if (token.parentToken && !checkRequirements([{ tokenValid: token.parentToken }])) {
        return false;
      }
    } else if (requirement.permissionsHeld) {
      const p = requirement.permissionsHeld;
      const viewInfo = Grains.findOne(p.grainId, { fields: { cachedViewInfo: 1 } }).cachedViewInfo;
      const currentPermissions = SandstormPermissions.grainPermissions(
        globalDb,
        { grain: { _id: p.grainId, identityId: p.identityId } }, viewInfo || {}).permissions;
      if (!currentPermissions) {
        return false;
      }

      const requiredPermissions = p.permissions || [];
      for (let ii = 0; ii < requiredPermissions.length; ++ii) {
        if (requiredPermissions[ii] && !currentPermissions[ii]) {
          return false;
        }
      }
    } else if (requirement.userIsAdmin) {
      if (!isAdminById(requirement.userIsAdmin)) {
        return false;
      }
    } else {
      throw new Meteor.Error(403, "Unknown requirement");
    }
  }

  return true;
};

restoreInternal = (originalToken, ownerPattern, requirements, tokenId, saveByCopy) => {
  // Restores the token `originalToken`, which is a Buffer.
  //
  // `ownerPattern` is a match pattern (i.e. used with check()) that the token's owner must match.
  // This is used to enforce than an entity can't use tokens owned by some other entity.
  //
  // `requirements` is a list of additional MembraneRequirements to add to the returned capability,
  // beyond what's already stored in ApiTokens. This is often an empty list.
  //
  // `tokenId` is optional. If specified, it should be hashSturdyRef(originalToken); only specify
  // it if you happen to have computed this already.
  //
  // By default, saving the returned capability will create a child of `originalToken`. However,
  // if the optional `saveByCopy` parameter is set to `true`, then saving will yield a sibling
  // of `originalToken`, with all fields other than `_id`, `owner`, and `created` copied, and with
  // the new `requirements` appended.
  //
  // (When the token turns out to have a parent, this function will call itself recursively. When
  // it does, `originalToken` stays the same, but `tokenId` is replaced with the parent. This is
  // because the capability we ultimately restore needs to become a child of the token that is
  // being restored.)

  tokenId = tokenId || hashSturdyRef(originalToken);
  requirements = requirements || [];

  const token = ApiTokens.findOne(tokenId);
  if (!token) {
    throw new Meteor.Error(403, "No token found to restore");
  }

  if (token.revoked) {
    throw new Meteor.Error(403, "Token has been revoked");
  }

  // The ownerPattern should specify the appropriate user or grain involved, if appropriate.
  check(token.owner, ownerPattern);

  // Check requirements on the token.
  if (!checkRequirements(token.requirements)) {
    throw new Meteor.Error(403, "Requirements not satisfied.");
  }

  // Check expiration.
  if (token.expires && token.expires.getTime() <= Date.now()) {
    throw new Meteor.Error(403, "Authorization token expired");
  }

  if (token.expiresIfUnused) {
    if (token.expiresIfUnused.getTime() <= Date.now()) {
      throw new Meteor.Error(403, "Authorization token expired");
    } else {
      // It's getting used now, so clear the expiresIfUnused field.
      ApiTokens.update(token._id, { $unset: { expiresIfUnused: "" } });
    }
  }

  // If this token has a parent, go ahead and recurse to it now.
  if (token.parentToken) {
    // A token which chains to some parent token.  Restore the parent token (possibly recursively),
    // checking requirements on the way up.
    return restoreInternal(originalToken, Match.Any, requirements, token.parentToken, saveByCopy);
  }

  // Check the passed-in `requirements`.
  if (!checkRequirements(requirements)) {
    throw new Meteor.Error(403, "Requirements not satisfied.");
  }

  // The capability we restore must implement SystemPersistent, and we already know what the
  // implementation will look like. So, construct it here.
  //
  // TODO(cleanup): It would probably be a lot cleaner to have a common base class that these
  //   inherit, and to pass down some common parameters to the constructor.
  const persistentMethods = {
    save(params) {
      return inMeteor(() => {
        const sturdyRefString = saveByCopy
            ? saveByCopyInternal(originalToken, params.sealFor, requirements, token)
            : makeChildTokenInternal(originalToken, params.sealFor, requirements, token);
        const sturdyRef = new Buffer(sturdyRefString);
        return { sturdyRef };
      });
    },

    // TODO(someday): Implement SystemPersistent.addRequirements().
  };

  if (token.frontendRef) {
    // A token which represents a capability implemented by a pseudo-driver.

    if (token.frontendRef.identity) {
      return { cap: makeIdentity(token.frontendRef.identity, persistentMethods) };
    } else if (token.frontendRef.notificationHandle) {
      const notificationId = token.frontendRef.notificationHandle;
      return { cap: makeNotificationHandle(notificationId, true, persistentMethods) };
    } else if (token.frontendRef.ipNetwork) {
      return { cap: makeIpNetwork(persistentMethods) };
    } else if (token.frontendRef.ipInterface) {
      return { cap: makeIpInterface(persistentMethods) };
    } else if (token.frontendRef.emailVerifier) {
      return { cap: makeEmailVerifier(
          persistentMethods, tokenId, token.frontendRef.emailVerifier), };
    } else if (token.frontendRef.verifiedEmail) {
      return { cap: makeVerifiedEmail(persistentMethods) };
    } else {
      throw new Meteor.Error(500, "Unknown frontend token type.");
    }
  } else if (token.objectId) {
    // A token which represents a specific capability exported by a grain.

    // Fix Mongo converting Buffers to Uint8Arrays.
    if (token.objectId.appRef) {
      token.objectId.appRef = new Buffer(token.objectId.appRef);
    }

    // Ensure the grain is running, then restore the capability.
    return waitPromise(globalBackend.useGrain(token.grainId, (supervisor) => {
      // Note that in this case it is the supervisor's job to implement SystemPersistent, so we
      // discard persistentMethods.
      return supervisor.restore(token.objectId, requirements, originalToken);
    }));
  } else if (token.grainId) {
    // It's a UiView.

    // If a grain is attempting to restore a UiView, it gets a UiView which filters out all
    // the method calls.  In the future, we may allow grains to restore UiViews that pass along the
    // "is human" pseudopermission (say, to allow an app to proxy all requests to some grain and
    // do some transformation), which will return a different capability.
    return { cap: makePersistentUiView(persistentMethods, token.grainId) };
  } else {
    throw new Meteor.Error(500, "Unknown token type. ID: " + token._id);
  }
};

function dropInternal(sturdyRef, ownerPattern) {
  // Drops `sturdyRef`, checking first that its owner matches `ownerPattern`.

  const hashedSturdyRef = hashSturdyRef(sturdyRef);
  const token = ApiTokens.findOne({ _id: hashedSturdyRef });
  if (!token) {
    return;
  }

  check(token.owner, ownerPattern);

  if (token.frontendRef && token.frontendRef.notificationHandle) {
    const notificationId = token.frontendRef.notificationHandle;
    globalDb.removeApiTokens({ _id: hashedSturdyRef });
    const anyToken = ApiTokens.findOne({ "frontendRef.notificationHandle": notificationId });
    if (!anyToken) {
      // No other tokens referencing this notification exist, so dismiss the notification
      dismissNotification(notificationId);
    }
  } else if (token.objectId && token.objectId.wakeLockNotification) {
    dropWakelock(token.grainId, token.objectId.wakeLockNotification);
    globalDb.removeApiTokens({ _id: hashedSturdyRef });
  } else {
    globalDb.removeApiTokens({ _id: hashedSturdyRef });
  }
}

function saveByCopyInternal(rawOriginalToken, owner, requirements, tokenInfo) {
  const hashedOriginal = hashSturdyRef(rawOriginalToken);
  tokenInfo = tokenInfo || ApiTokens.findOne(hashedOriginal);
  if (!tokenInfo) {
    throw new Error("parent token doesn't exist");
  }

  const sturdyRef = generateSturdyRef();
  const hashedSturdyRef = hashSturdyRef(sturdyRef);

  const newTokenInfo = _.clone(tokenInfo);
  newTokenInfo._id = hashedSturdyRef;
  newTokenInfo.owner = owner;
  newTokenInfo.created = new Date();
  newTokenInfo.requirements = (tokenInfo.requirements || []).concat(requirements);

  ApiTokens.insert(newTokenInfo);

  return sturdyRef;
}

function makeChildTokenInternal(rawParentToken, owner, requirements, tokenInfo) {
  const hashedParent = hashSturdyRef(rawParentToken);

  // If we don't have tokenInfo (we were called from SandstormCore.makeChildToken()), look up
  // the parent token now and use that.
  // TODO(someday): I think this makeChildToken() will lose titles because of this.
  //   Option 1: Somehow pass info through the supervisor for it to pass back through
  //       makeChildToken().
  //   Option 2: Follow the chain of parentTokens here.
  //   Option 3: Maybe the title should actually be passed in a PowerboxDescriptor which the app
  //       is expected to thread through to offer(). This is analogous to how file transfers
  //       work: the file name is not normally stored in the content. Our petname system for
  //       grains already matches that model better -- and if we decide to get rid of said petname
  //       system and instead have everyone see the author's title, then we'd presumably stop
  //       storing it in the token `owner` field altogether, so this becomes moot.
  tokenInfo = tokenInfo || ApiTokens.findOne(hashedParent);
  if (!tokenInfo) {
    throw new Error("parent token doesn't exist");
  }

  if (tokenInfo.identityId) {
    // This is a UiView capability. We need to use SandstormPermissions to create it in order
    // to properly denormalize fields.

    if (owner.user) {
      // Initialize the grain's title to a copy of the title set by the human user closest in the
      // sharing graph. It turns out that the "root token" is actually the token representing that
      // user, not the grain owner, because user-to-user sharing relationships are not parent-child
      // token relationships.
      const rootTitle = globalDb.userGrainTitle(tokenInfo.grainId, tokenInfo.accountId,
                                                tokenInfo.identityId);

      if (!owner.user.title && rootTitle) {
        owner.user.title = rootTitle;
      }
    }

    return SandstormPermissions.createNewApiToken(globalDb, { rawParentToken },
        tokenInfo.grainId, tokenInfo.petname, { allAccess: null }, owner).token;
  }

  if (owner.user) {
    throw new Error("can't save non-UiView with user as owner");
  }

  const sturdyRef = generateSturdyRef();
  const hashedSturdyRef = hashSturdyRef(sturdyRef);

  const newTokenInfo = {
    _id: hashedSturdyRef,
    parentToken: hashedParent,
    owner: owner,
    created: new Date(),
    requirements: requirements,
  };

  // For non-UiView capabilities, we need not denormalize grainId, identityId, etc. into the child
  // token.

  ApiTokens.insert(newTokenInfo);

  return sturdyRef;
};

function SandstormCoreFactoryImpl() {
}

SandstormCoreFactoryImpl.prototype.getSandstormCore = (grainId) => {
  return { core: makeSandstormCore(grainId) };
};

makeSandstormCoreFactory = () => {
  return new Capnp.Capability(new SandstormCoreFactoryImpl(), SandstormCoreFactory);
};

unwrapFrontendCap = (cap, type, callback) => {
  // Expect that `cap` is a Cap'n Proto capability implemented by the frontend as a frontendRef
  // with the given type (the name of one of the fields of frontendRef). Unwraps the capability
  // and then calls callback() with the `frontendRef[type]` descriptor object as
  // the paramater. The callback runs in a Meteor fiber, but this function can be called from
  // anywhere. The function returns a Promise for the result of the callback.
  //
  // (The reason for the callback, rather than just returning a Promise for the descriptor, is
  // so that you don't have to do your own inMeteor() dance.)

  // For now, we save() the capability and then dig through ApiTokens to find where it leads.
  // TODO(cleanup): In theory we should be using something like CapabilityServerSet, but it is
  //   not available in Javascript yet and even if it were, it wouldn't work in the case where
  //   there are multiple front-end replicas, since the capability could be on a different
  //   replica.

  return cap.castAs(SystemPersistent).save({ frontend: null }).then(saveResult => {
    return inMeteor(() => {
      const tokenId = hashSturdyRef(saveResult.sturdyRef);
      let tokenInfo = ApiTokens.findOne(tokenId);

      // Delete the token now since it's not needed.
      ApiTokens.remove(tokenId);

      for (;;) {
        if (!tokenInfo) throw new Error("missing token?");
        if (!tokenInfo.parentToken) break;
        tokenInfo = ApiTokens.findOne(tokenInfo.parentToken);
      }

      if (!tokenInfo.frontendRef || !tokenInfo.frontendRef[type]) {
        throw new Error("not a " + type + " capability");
      }

      return callback(tokenInfo.frontendRef[type]);
    });
  });
};
