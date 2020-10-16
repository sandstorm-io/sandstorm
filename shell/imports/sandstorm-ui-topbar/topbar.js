// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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
import { Match, check } from "meteor/check";
import { Template } from "meteor/templating";
import { Blaze } from "meteor/blaze";
import { Reload } from "meteor/reload";
import { Tracker } from "meteor/tracker";
import { ReactiveVar } from "meteor/reactive-var";
import { Router } from "meteor/iron:router";
import { _ } from "meteor/underscore";

let reloadBlockingCount = 0;
const blockedReload = new ReactiveVar(null);
let explicitlyUnblocked = false;
Reload._onMigrate(undefined, function (retry, options) {
  if (reloadBlockingCount > 0 && !explicitlyUnblocked && !options.immediateMigration) {
    console.log("New version ready, but blocking reload because an app is open.");
    blockedReload.set(retry);
    return false;
  } else {
    return [true];
  }
});

function unblockUpdate() {
  const retry = blockedReload.get();
  if (retry) {
    blockedReload.set(null);
    explicitlyUnblocked = true;
    retry();
  }
}

Template.sandstormTopbarBlockReload.onCreated(function () { ++reloadBlockingCount; });

Template.sandstormTopbarBlockReload.onDestroyed(function () {
  if (--reloadBlockingCount == 0) {
    unblockUpdate();
  }
});

Template.sandstormTopbar.onCreated(function () {
  Template.instance().popupPosition = new ReactiveVar(undefined, _.isEqual);

  const topbar = this.data;
  this.escapeHandler = function (ev) {
    if (ev.keyCode === 27) {
      topbar.closePopup();
    }
  };

  document.getElementsByTagName("body")[0].addEventListener("keydown", this.escapeHandler);
});

Template.sandstormTopbar.onDestroyed(function () {
  document.getElementsByTagName("body")[0].removeEventListener("keydown", this.escapeHandler);
});

Template.sandstormTopbar.helpers({
  isUpdateBlocked: function () {
    return !!blockedReload.get();
  },

  items: function () {
    this._itemsTracker.depend();

    // Note that JS objects always iterate in the order in which keys were added, so this actually
    // produces a stable ordering.
    return _.sortBy(_.values(this._items), function (item) { return -(item.priority || 0); });
  },

  isCurrentRoute: function (routeName) {
    return Router.current().route.getName() == routeName;
  },

  grains: function () {
    const topbar = Template.instance().data;
    const grains = topbar._grains.getAll();
    const data = grains.map(function (grain) {
      grain.depend();
      return {
        grainId: grain.grainId(),
        active: grain.isActive(),
        unread: grain.isUnread(),
        title: grain.title() || "(unknown grain)",
        grainLink: grain.route(),
        iconSrc: grain.iconSrc(),
        appTitle: grain.appTitle(),
        notificationCount: grain.notificationCount(),
      };
    });

    return data;
  },

  grainCount: function () {
    const topbar = Template.instance().data;
    const grains = topbar._grains.getAll();
    return grains.length;
  },

  currentPopup: function () {
    const name = this._expanded.get();
    if (name) {
      this._itemsTracker.depend();
      return this._items[name];
    } else {
      return null;
    }
  },

  modal: function () {
    const topbar = Template.instance().data;
    return topbar._modal.get();
  },

  template: function () {
    // Spacebars' {{>foo bar}} passes `bar` by pushing it onto the data context stack rather than
    // passing it as a parameter. The original data context must be accessed via `parentData()`.
    const item = Template.parentData(1);
    return item.template;
  },

  popupTemplate: function () {
    const item = Template.parentData(1);
    return item.popupTemplate;
  },

  popupTemplateNested: function () {
    // Here we need parentData(2) because we've also pushed `position` onto the stack.
    const item = Template.parentData(2);
    return item.popupTemplate;
  },

  position: function () {
    const instance = Template.instance();
    const item = instance.data._items[instance.data._expanded.get()];
    if (item) {
      Meteor.defer(function () {
        const element = instance.find(".topbar>.menubar>." + item.name);
        if (element) {
          // This positions the popup under the topbar item that spawned it. As a hacky heuristic,
          // we position the popup from the left if the item is closer to the left of the window,
          // or from the right otherwise.
          //
          // TODO(someday): Make this better. We could wait until the popup template has opened and
          //   rendered, then choose a better position based on its full size.

          if (item.name == "account") {
            // account should always be flush right
            instance.popupPosition.set({ name: item.name, align: "right", px: 0 });
          } else {
            const rect = element.getBoundingClientRect();
            const currentWindowWidth = windowWidth.get();
            const windowMid = currentWindowWidth / 2;
            const itemMid = (rect.left + rect.right) / 2;
            instance.popupPosition.set(itemMid < windowMid
                ? { name: item.name, align: "left", px: Math.max(itemMid - 50, 0) }
                : { name: item.name, align: "right",
                    px: Math.max(currentWindowWidth - itemMid - 50, 0), });
          }
        }
      });
    }

    const result = instance.popupPosition.get();
    if (item && result && result.name === item.name) {
      return result;
    } else {
      // We haven't calculated the popup position yet. Place it off-screen for now.
      return { align: "left", px: -10000 };
    }
  },

  accountExpires: function () {
    const user = Meteor.user();
    if (!user || !Meteor.user().expires) return null;

    const ms = Meteor.user().expires.getTime() - Date.now();
    let sec = Math.floor(ms / 1000) % 60;
    if (sec < 10) sec = "0" + sec;
    const min = Math.floor(ms / 60000);
    const comp = Tracker.currentComputation;
    if (comp) {
      Meteor.setTimeout(comp.invalidate.bind(comp), 1000);
    }

    return {
      // We put zero-width spaces on either side of the : in order to allow wrapping when the
      // sidebar is shrunk.
      countdown: min + "\u200b:\u200b" + sec,
      urgent: ms < 600000,
    };
  },
});

const windowWidth = new ReactiveVar(window.innerWidth);
window.addEventListener("resize", function () {
  windowWidth.set(window.innerWidth);
});

Template.sandstormTopbar.events({
  "click .topbar-update": function (event) {
    unblockUpdate();
  },

  "click .topbar>.menubar>li": function (event) {
    const data = Blaze.getData(event.currentTarget);
    if (data.popupTemplate) {
      event.stopPropagation();
      event.preventDefault();

      const topbar = Template.instance().data;
      topbar._expanded.set(data.name);
      topbar._modal.set(false);
      topbar._menuExpanded.set(false);
    }
  },

  "click .popup": function (event) {
    if (event.target === event.currentTarget) {
      // Clicked outside the popup; close it.
      event.stopPropagation();
      Template.instance().data.closePopup();
    }
  },

  // The touchstart handler is to handle a bug in iOS with the click event above.
  // From what I can tell, mobile safari seems to be optimizing out the click.
  "touchstart .popup": function (event) {
    if (event.target === event.currentTarget) {
      // Clicked outside the popup; close it.
      event.stopPropagation();
      Template.instance().data.closePopup();
    }
  },

  "click .popup>.frame-container>.frame>.close-popup": function (event) {
    event.stopPropagation();
    Template.instance().data.closePopup();
  },

  "click .toggle-navbar": function (event) {
    const topbar = Template.instance().data;
    topbar._shrinkNavbar.set(!topbar._shrinkNavbar.get());
  },

  "click .menu-button": function (event) {
    const topbar = Template.instance().data;
    topbar._menuExpanded.set(!topbar._menuExpanded.get());
  },

  "click .navbar-shrink": function (event) {
    const topbar = Template.instance().data;
    topbar._shrinkNavbar.set(!topbar._shrinkNavbar.get());
  },

  "click .navbar .close-button": function (event) {
    const grainId = event.currentTarget.parentNode.getAttribute("data-grainid");
    const topbar = Template.instance().data;
    topbar._grains.remove(grainId, true);
  },

  "click .demo-notice .sign-in": function (event) {
    const topbar = Template.instance().data;
    topbar.openPopup("login");
  },
});

Template.sandstormTopbarItem.onCreated(function () {
  const item = _.clone(this.data);
  const topbar = item.topbar;
  delete item.topbar;

  if (typeof item.template === "string") {
    item.template = Template[item.template];
  }

  if (typeof item.popupTemplate === "string") {
    item.popupTemplate = Template[item.popupTemplate];
  }

  const instance = Template.instance();

  // Support inline definitions using {{#sandstormTopbarItem}}.
  const view = instance.view;
  if (!item.template && view.templateContentBlock) {
    item.template = view.templateContentBlock;
  }

  if (!item.popupTemplate && view.templateElseBlock) {
    item.popupTemplate = view.templateElseBlock;
  }

  const dataVar = new ReactiveVar(null, _.isEqual);
  if ("data" in item) {
    // Changes to the input data do not cause this template to get created anew, so we must
    // propagate such changes to the item.
    instance.autorun(function () {
      dataVar.set(Template.currentData().data);
    });
  } else {
    instance.autorun(function () {
      // TODO(someday): We really want to pull the whole data *stack*, but I don't know how.
      dataVar.set(Template.parentData(1));
    });
  }

  item.data = dataVar;

  instance.topbarCloser = topbar.addItem(item);
});

Template.sandstormTopbarItem.onDestroyed(function () {
  Template.instance().topbarCloser.close();
});

// =======================================================================================
// Public interface

export const SandstormTopbar = function (db, expandedVar, grainsVar, shrinkNavbarVar) {
  // `expandedVar` is an optional object that behaves like a `ReactiveVar` and will be used to
  // track which popup is currently open. (The caller may wish to back this with a Session
  // variable.)
  this._staticHost = db.makeWildcardHost("static");

  this._items = {};
  this._itemsTracker = new Tracker.Dependency();

  this._modal = new ReactiveVar(false);
  this._expanded = expandedVar || new ReactiveVar(null);
  this._menuExpanded = new ReactiveVar(false);
  // shrinkNavbar is different from menuExpanded:
  //  - on desktop, we want to show the navbar by default,
  //    and toggle shrinking it if the user clicks the logo
  //  - on mobile, we wish to hide the menu by default,
  //    and show it when the user clicks the menu button
  this._shrinkNavbar = shrinkNavbarVar || new ReactiveVar(true);
  this._grains = grainsVar;
};

SandstormTopbar.prototype.reset = function () {
  this._menuExpanded.set(false);
  this.closePopup();
};

SandstormTopbar.prototype.closePopup = function () {
  const name = this._expanded.get();
  if (!name) return;

  const item = this._items[name];
  if (item && item.onDismiss) {
    const result = item.onDismiss();
    if (typeof result === "string") {
      if (result === "block") {
        return;
      } else if (result === "remove") {
        delete this._items[item.name];
        this._itemsTracker.changed();
      } else {
        throw new Error("Topbar item onDismiss handler returned bogus result:", result);
      }
    }
  }

  this._expanded.set(null);
};

SandstormTopbar.prototype.isPopupOpen = function () {
  return !!this._expanded.get();
};

SandstormTopbar.prototype.openPopup = function (name, modal) {
  this._expanded.set(name);
  this._modal.set(modal);
  this._menuExpanded.set(false);
};

SandstormTopbar.prototype.isUpdateBlocked = function () {
  return !!blockedReload.get();
};

SandstormTopbar.prototype.addItem = function (item) {
  // Adds a new item to the top bar, such as a button or a menu.
  //
  // Returns an object with a close() method which may be called to unregister the item.

  check(item, {
    name: String,
    // CSS class name of this item. Must be unique.

    template: Match.Optional(Template),
    // Template for the item content as rendered in the topbar.

    popupTemplate: Match.Optional(Template),
    // If a popup box should appear when the item is clicked, this is the template for the content
    // of that box.

    data: Match.Optional(ReactiveVar),
    // Data context for `template` and `popupTemplate`.

    startOpen: Match.Optional(Boolean),
    // If true, this item's popup should start out open.

    startOpenModal: Match.Optional(Boolean),
    // Like `startOpen`, but indicates that the initial state of the popup should be "modal", i.e.
    // not hanging off the top bar.

    priority: Match.Optional(Number),
    // Specifies ordering of items. Higher-priority items will be at the top of the list. Items
    // with the same priority are sorted in the order in which addItem() was called. The default
    // priority is zero.
    //
    // Note that Sandstorm's stylesheet makes some items float: right. Of the items floating
    // right, the highest-priority will be *rightmost*. Essentially, higher-priority items tend
    // towards the outsides of the top bar with lower-priority items going inside of them.

    onDismiss: Match.Optional(Function),
    // Specifies a function to call when the popup is dismissed by clicking outside of the popup
    // space. This function may return some special string values with specific meanings:
    // * "remove": Removes the topbar item, like if close() were called on the result of addItem().
    // * "block": Block the attempt to dismiss the popup.

    onlyPopup: Match.Optional(Boolean),
    // If this is true, then no icon is shown in the topbar (`template` param is ignored). startOpen
    // is defaulted to true and onDismiss defaults to closing the popup.
  });

  if (item.onlyPopup) {
    item.startOpen = item.startOpen || true;
    item.onDismiss = item.onDismiss || function () { return "remove"; };
  } else if (!item.template) {
    throw new Error("template parameter must be supplied unless onlyPopup is true");
  }

  if (!item.popupTemplate && (item.startOpen || item.onDismiss)) {
    throw new Error("can't set startOpen or onDismiss without setting popupTemplate");
  }

  if (item.name in this._items) {
    // Duplicate item. This can sometimes happen due to template redraw timing issues: the old
    // item was supposed to be removed before the new item was added, but things were scheduled
    // in the wrong order. So, we replace the old item with the new one, and also make sure to
    // close the old item if it is currently expanded. (We can't directly call close() since that's
    // a callback we returned without holding on to, but it would do redundant work anyway.)
    console.warn("duplicate top bar item name:", item.name);
    if (this._expanded.get() === item.name) {
      this._expanded.set(null);
    }
  }

  this._items[item.name] = item;
  this._itemsTracker.changed();

  if (item.startOpen || item.startOpenModal) {
    this._expanded.set(item.name);
    this._modal.set(!!item.startOpenModal);
  }

  return {
    close: () => {
      if (this._items[item.name] === item) {
        if (this._expanded.get() === item.name) {
          this._expanded.set(null);
        }

        delete this._items[item.name];
        this._itemsTracker.changed();
      }
    },
  };
};
