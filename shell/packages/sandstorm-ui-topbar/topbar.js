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

var reloadBlockingCount = 0;
var blockedReload = new ReactiveVar(null);
var explicitlyUnblocked = false;
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
  var retry = blockedReload.get();
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
    var topbar = Template.instance().data;
    var grains = topbar._grains.get();
    var data = grains.map(function (grain) {
      grain.depend();
      return {
        grainId: grain.grainId(),
        active: grain.isActive(),
        title: grain.title() || "(unknown grain)",
        grainLink: grain.route(),
        iconSrc: grain.iconSrc(),
        appTitle: grain.appTitle(),
      };
    });
    console.log("rendering navbar with");
    console.log(data);
    return data;
  },
  grainCount: function () {
    var topbar = Template.instance().data;
    var grains = topbar._grains.get();
    return grains.length;
  },

  currentPopup: function () {
    var name = this._expanded.get();
    if (name) {
      this._itemsTracker.depend();
      return this._items[name];
    } else {
      return null;
    }
  },

  template: function () {
    // Spacebars' {{>foo bar}} passes `bar` by pushing it onto the data context stack rather than
    // passing it as a parameter. The original data context must be accessed via `parentData()`.
    var item = Template.parentData(1);
    return item.template;
  },

  popupTemplate: function () {
    var item = Template.parentData(1);
    return item.popupTemplate;
  },

  popupTemplateNested: function () {
    // Here we need parentData(2) because we've also pushed `position` onto the stack.
    var item = Template.parentData(2);
    return item.popupTemplate;
  },

  position: function () {
    var instance = Template.instance();
    var item = instance.data._items[instance.data._expanded.get()];
    if (item) {
      Meteor.defer(function () {
        var element = instance.find(".topbar>.menubar>." + item.name);
        if (element) {
          // This positions the popup under the topbar item that spawned it. As a hacky heuristic,
          // we position the popup from the left if the item is closer to the left of the window,
          // or from the right otherwise.
          //
          // TODO(someday): Make this better. We could wait until the popup template has opened and
          //   rendered, then choose a better position based on its full size.

          var rect = element.getBoundingClientRect();
          var currentWindowWidth = windowWidth.get();
          var windowMid = currentWindowWidth / 2;
          var itemMid = (rect.left + rect.right) / 2;
          instance.popupPosition.set(itemMid < windowMid
              ? { name: item.name, align: "left", px: Math.max(itemMid - 50, 0) }
              : { name: item.name, align: "right",
                  px: Math.max(currentWindowWidth - itemMid - 50, 0) });
        }
      });
    }

    var result = instance.popupPosition.get();
    if (item && result && result.name === item.name) {
      return result;
    } else {
      // We haven't calculated the popup position yet. Place it off-screen for now.
      return { align: "left", px: -10000 };
    }
  },
});

var windowWidth = new ReactiveVar(window.innerWidth);
window.addEventListener("resize", function () {
  windowWidth.set(window.innerWidth);
});

Template.sandstormTopbar.events({
  "click .topbar-update": function (event) {
    unblockUpdate();
  },

  "click .topbar>.menubar>li": function (event) {
    var data = Blaze.getData(event.currentTarget);
    if (data.popupTemplate) {
      event.stopPropagation();
      event.preventDefault();

      var topbar = Template.instance().data;
      topbar._expanded.set(data.name);
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

  "click .popup>.frame>.close-popup": function (event) {
    event.stopPropagation();
    Template.instance().data.closePopup();
  },

  "click .toggle-navbar": function (event) {
    var topbar = Template.instance().data;
    topbar._showNavbar.set(!topbar._showNavbar.get());
  },

  "click .menu-button": function (event) {
    var topbar = Template.instance().data;
    topbar._menuExpanded.set(!topbar._menuExpanded.get());
  },

  "click .navbar .close-button": function (event) {
    var grainId = event.currentTarget.parentNode.getAttribute("data-grainid");
    var topbar = Template.instance().data;
    var grains = topbar._grains.get();

    var activeIndex = -1;
    var closeIndex = -1;
    grains.forEach(function(grain, i){
      if (grain.isActive()) {
        activeIndex = i;
      }
      if (grain.grainId() == grainId) {
        closeIndex = i;
        grain.destroy();
      }
    });

    if (grains.length == 1) {
      // Redirect to /grain/ after closing the last grain, if it was the active view.
      topbar._grains.set([]);
      if (activeIndex == 0) {
        Router.go("selectGrain");
      }
      return;
    }

    if (activeIndex == closeIndex) {
      // If the user closed the active grain, redirect to the next one after closing this one.
      var newActiveIndex = (activeIndex == grains.length - 1) ? activeIndex - 1 : activeIndex;
      // Unless the active grain was the last one, in which case redirect to the previous one.
      grains.splice(closeIndex, 1);
      grains[newActiveIndex].setActive(true);
      topbar._grains.set(grains);
      Router.go("grain", {grainId: grains[newActiveIndex].grainId()});
    } else {
      grains.splice(closeIndex, 1);
      topbar._grains.set(grains);
    }
  }
});

Template.sandstormTopbarItem.onCreated(function () {
  var item = _.clone(this.data);
  var topbar = item.topbar;
  delete item.topbar;

  if (typeof item.template === "string") {
    item.template = Template[item.template];
  }
  if (typeof item.popupTemplate === "string") {
    item.popupTemplate = Template[item.popupTemplate];
  }

  var instance = Template.instance();

  // Support inline definitions using {{#sandstormTopbarItem}}.
  var view = instance.view;
  if (!item.template && view.templateContentBlock) {
    item.template = view.templateContentBlock;
  }
  if (!item.popupTemplate && view.templateElseBlock) {
    item.popupTemplate = view.templateElseBlock;
  }

  if ("data" in item) {
    // TODO(someday): Verify that the template is recreated if the input data changes, or
    //   otherwise force this ReactiveVar to update whenever the data changes.
    item.data = new ReactiveVar(item.data);
  } else {
    // TODO(someday): We really want to pull the whole data *stack*, but I don't know how.
    var dataVar = new ReactiveVar(Template.parentData(1), _.isEqual);
    instance.autorun(function () {
      dataVar.set(Template.parentData(1));
    });
    item.data = dataVar;
  }

  instance.topbarCloser = topbar.addItem(item);
});

Template.sandstormTopbarItem.onDestroyed(function () {
  Template.instance().topbarCloser.close();
});

// =======================================================================================
// Public interface

SandstormTopbar = function (db, expandedVar, grainsVar, showNavbarVar) {
  // `expandedVar` is an optional object that behaves like a `ReactiveVar` and will be used to
  // track which popup is currently open. (The caller may wish to back this with a Session
  // variable.)
  this._staticHost = db.makeWildcardHost('static');

  this._items = {};
  this._itemsTracker = new Tracker.Dependency();

  this._expanded = expandedVar || new ReactiveVar(null);
  this._menuExpanded = new ReactiveVar(false);
  // showNavbar is different from menuExpanded:
  //  - on desktop, we want to show the navbar by default,
  //    and toggle if the user clicks the logo
  //  - on mobile, we wish to hide the menu by default,
  //    and show it when the user clicks the menu button
  this._showNavbar = showNavbarVar || new ReactiveVar(true);
  this._grains = grainsVar || new ReactiveVar([]);

}

SandstormTopbar.prototype.reset = function () {
  this._menuExpanded.set(false);
  this.closePopup();
}

SandstormTopbar.prototype.closePopup = function () {
  var name = this._expanded.get();
  if (!name) return;

  var item = this._items[name];
  if (item && item.onDismiss) {
    var result = item.onDismiss();
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
}

SandstormTopbar.prototype.isUpdateBlocked = function () {
  return !!blockedReload.get();
}

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
    // Data context for `template` and `popupTempelate`.

    startOpen: Match.Optional(Boolean),
    // If true, this item's popup should start out open.

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
    throw new Error("duplicate top bar item name:", item.name);
  }

  this._items[item.name] = item;
  this._itemsTracker.changed();

  if (item.startOpen) {
    this._expanded.set(item.name);
  }

  var self = this;
  return {
    close: function() {
      if (self._items[item.name] === item) {
        if (self._expanded.get() === item.name) {
          self._expanded.set(null);
        }

        delete self._items[item.name];
        self._itemsTracker.changed();
      }
    }
  };
};
