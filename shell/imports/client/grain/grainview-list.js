// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";
import { Tracker } from "meteor/tracker";
import { ReactiveVar } from "meteor/reactive-var";
import { Router } from "meteor/iron:router";
import { Accounts } from "meteor/accounts-base";

import { GrainView, onceConditionIsTrue } from "./grainview.js";
import { isStandalone } from "/imports/client/standalone.js";
import { SandstormDb } from "/imports/sandstorm-db/db.js";

class GrainViewList {
  constructor(db) {
    check(db, SandstormDb);
    this._db = db;
    this._grains = new ReactiveVar([]);

    // Restore last-open grain list for the same URL.

    // Meteor has a nice package for detecting if localStorage is available, but it's internal.
    // We use it anyway. If it goes away, this will throw an exception at startup which will should
    // be really obvious and we'll fix it.
    const key = "openGrains-" + SHA256(window.location.toString());
    const old = Meteor._localStorage.getItem(key);
    if (old && !isStandalone()) {
      Meteor.startup(() => this.restoreOpenGrains(JSON.parse(old)));
      Meteor._localStorage.removeItem(key);
    }

    window.addEventListener("unload", () => {
      // If more than one grain is open, save a list to restore later. We don't save if just one grain
      // because people who like to open grains in separate browser tabs probably don't want this
      // feature. Also, anonymous users who can only open one grain at a time (because they have no
      // sidebar) would probably be surprised to find the grain re-open if they return to Sandstorm
      // later.

      // Don't save anything if the user isn't logged in, because users who aren't logged in can't
      // see the sidebar and probably would be surprised that Sandstorm remembers what they had
      // opened.
      if (!Meteor.userId()) return;

      const grains = this._grains.get();
      const key = "openGrains-" + SHA256(window.location.toString());

      const old = Meteor._localStorage.getItem(key);
      if (old) {
        const oldParsed = JSON.parse(old);

        if (oldParsed.time > Date.now() - 5000) {
          // Crap. It seems that some other tab was closed in the last 5 seconds that had the same
          // URL (perhaps a common one like "/apps"). We have no way to distinguish our tab from this
          // other tab. Rather than arbitrarily clobber one tab's grains list with the other --
          // which will likely confuse the user, opening grains in multiple places that weren't
          // previously -- we will have to give up and not restore anything. :(
          Meteor._localStorage.setItem(key, JSON.stringify({ time: Date.now(), grains: [] }));
          return;
        }
      }

      Meteor._localStorage.setItem(key,
          JSON.stringify({ time: Date.now(), grains: grains.map(grain => grain.save()) }));
    });

    this._grainsUserId = new ReactiveVar(Meteor.userId());

    // Although we only ever construct a single global GrainViewList, and therefore we never need to
    // stop() the below autorun(), it's probably a good idea keep a reference to the handle, just in
    // case we need it someday.
    this._autoclearHandle = Tracker.autorun(() => {
      const currentUserId = Meteor.userId();
      if (currentUserId !== this._grainsUserId.get()) {
        const current = Router.current();
        if (current.route.getName() === "grain" || current.route.getName() === "shared") {
          current.state.set("beforeActionHookRan", false);
        }

        if (isStandalone()) {
          const activeGrain = globalGrains.getActive();
          if (activeGrain) {
            activeGrain.reset(Meteor.user() && Meteor.user().loginCredentials &&
              Meteor.user().loginCredentials[0]);
            activeGrain.openSession();
          }
        } else {
          this.clear();
        }

        this._grainsUserId.set(currentUserId);
      }
    });
  }

  clear() {
    const grains = this._grains.get();
    grains.forEach(function (grain) {
      grain.destroy();
    });

    this._grains.set([]);
  }

  getAll() {
    return this._grains.get();
  }

  getById(grainId) {
    check(grainId, String);

    const grains = this._grains.get();
    for (let i = 0; i < grains.length; i++) {
      const grain = grains[i];
      if (grains[i].grainId() === grainId) {
        return grains[i];
      }
    }

    return null;
  }

  getByOrigin(origin) {
    check(origin, String);

    const grains = this._grains.get();
    for (let i = 0; i < grains.length; i++) {
      if (grains[i].origin() === origin) {
        return grains[i];
      }
    }

    return null;
  }

  contains(grainView) {
    return this._grains.get().indexOf(grainView) != -1;
  }

  addNewGrainView(grainId, path, tokenInfo, parentElement) {
    const grains = this._grains.get();
    const grainview = new GrainView(this, this._db, grainId, path, tokenInfo, parentElement);
    grains.push(grainview);
    this._grains.set(grains);
    return grainview;
  }

  remove(grainId, updateActive) {
    check(grainId, String);
    const grains = this._grains.get();
    let newActiveIdx;
    for (let idx = 0; idx < grains.length; idx++) {
      const grain = grains[idx];
      if (grain.grainId() === grainId) {
        const wasActive = grain.isActive();
        grain.destroy();
        grains.splice(idx, 1);
        if (updateActive && grains.length == 0) {
          Router.go("grains");
        } else if (updateActive && wasActive) {
          const newActiveIdx = (idx == grains.length ? idx - 1 : idx);
          grains[newActiveIdx].setActive(true);
          Router.go(grains[newActiveIdx].route());
        }

        this._grains.set(grains);
        return;
      }
    }
  }

  setActive(grainId) {
    check(grainId, String);
    const grains = this._grains.get();
    for (let i = 0; i < grains.length; i++) {
      const grain = grains[i];
      if (grain.grainId() === grainId) {
        if (!grain.isActive()) {
          grain.setActive(true);
        }
      } else {
        if (grain.isActive()) {
          grain.setActive(false);
        }
      }
    }
  }

  setAllInactive() {
    this._grains.get().forEach(function (grain) {
      if (grain.isActive()) {
        grain.setActive(false);
      }
    });
  }

  getActive() {
    const grains = this._grains.get();
    for (let i = 0; i < grains.length; i++) {
      if (grains[i].isActive()) {
        return grains[i];
      }
    }

    return null;
  }

  restoreOpenGrains(old) {
    // Load last-opened grain list, if any.

    if (old.grains.length === 0) return;

    const mainContentElement = document.querySelector("body>.main-content");
    if (!mainContentElement) {
      // Main content doesn't exist yet. Defer.
      Meteor.defer(() => this.restoreOpenGrains(old));
      return;
    }

    const ready = () => {
      if (Meteor.loggingIn() || Accounts.isLinkingNewCredential()) return false;

      // The list auto-clears when Meteor.userId() changes. Make sure that we wait until the dust
      // has settled.
      if (this._grainsUserId.get() !== Meteor.userId()) return false;

      for (const i in globalSubs) {
        if (!globalSubs[i].ready()) return false;
      }

      return true;
    };

    // Open all view sessions as soon as we're fully loaded.
    onceConditionIsTrue(ready, () => this.restore(old, mainContentElement));
  }

  restore(old, mainContentElement) {
    const alreadyOpen = this._grains.get();

    if (alreadyOpen.length > 1) {
      // It would be bad to overwrite the grain list if something is open already. This should
      // never happen, though, because the /grain and /shared routes won't begin to render until
      // all subscriptions are ready.
      console.error("Couldn't restore grain list because multiple grains are already open.");
    } else {
      let alreadyOpenGrain = alreadyOpen[0];  // maybe undefined

      const newGrains = old.grains.map(args => {
        if (alreadyOpenGrain && alreadyOpenGrain.grainId() === args[0]) {
          // Inject the already-open grain into the grain list here to maintain ordering.
          const result = alreadyOpenGrain;
          alreadyOpenGrain = undefined;
          return result;
        } else {
          const view = new GrainView(this, this._db, args[0], args[1], args[2], mainContentElement);
          view.openSession();
          return view;
        }
      });
      if (alreadyOpenGrain) newGrains.push(alreadyOpenGrain);
      this._grains.set(newGrains);
    }
  }
}

export { GrainViewList };

try {
  // We want to clear "openGrains" entries more than a week old since those windows are
  // probably never going to be restored. We can't use Meteor._localStorage for this because
  // it doesn't provide a way to iterate over all keys. So we use window.localStorage in a
  // try/catch.
  const keys = new Array(window.localStorage.length);
  for (let i = 0; i < keys.length; i++) {
    keys[i] = window.localStorage.key(i);
  }

  keys.forEach(key => {
    if (key.startsWith("openGrains-")) {
      if (JSON.parse(window.localStorage.getItem(key)).time < Date.now() - 86400000 * 7) {
        // This is more than a week old. Delete.
        delete window.localStorage[key];
      }
    }
  });
} catch (e) {
  console.error(e);
}
