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
Reload._onMigrate(undefined, function (retry) {
  if (reloadBlockingCount > 0 && !explicitlyUnblocked) {
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

  isExpanded: function () {
    var data = Template.instance().data;
    return data._expanded.get() === this.name;
  },

  template: function () {
    // Spacebars' {{>foo bar}} passes `bar` by pushing it onto the data context stack rather than
    // passing it as a parameter. The original data context must be accessed via `parentData()`.
    var data = Template.parentData(1);
    return data.template;
  },

  popupTemplate: function () {
    // Spacebars' {{>foo bar}} passes `bar` by pushing it onto the data context stack rather than
    // passing it as a parameter. The original data context must be accessed via `parentData()`.
    var data = Template.parentData(1);
    return data.popupTemplate;
  },

  data: function () {
    return Template.currentData().data.get();
  },

  hasPopup: function () {
    return !!this.popupTemplate;
  }
});

Template.sandstormTopbar.events({
  "click .topbar-update": function (event) {
    unblockUpdate();
  },

  "click ul.topbar>li": function (event) {
    event.stopPropagation();
    var data = Template.instance().data;
    data._expanded.set(event.currentTarget.className);
  },

  "click ul.topbar>li>div.closer": function (event) {
    event.stopPropagation();
    var data = Template.instance().data;
    data._expanded.set(null);
  },

  "click ul.topbar>li>div>div.popup": function (event) {
    event.stopPropagation();
  }
});

Template.sandstormTopbarItem.onCreated(function () {
  var item = _.clone(this.data);
  var topbar = item.topbar;
  delete item.topbar;

  if (typeof item.template === "string") {
    item.template = Template[item.template];
  }

  var instance = Template.instance();

  // Supprot inline definitions using {{#sandstormTopbarItem}}.
  var view = instance.view;
  if (!item.template && view.templateContentBlock) {
    item.template = view.templateContentBlock;
  }

  if (!("data" in item)) {
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

Template.sandstormTopbarPopup.onCreated(function () {
  Template.instance().positionVar = new ReactiveVar(undefined);
});

Template.sandstormTopbarPopup.onRendered(function () {
  // This positions the popup under the topbar item that spawned it. As a hacky heuristic, we
  // position the popup from the left if the item is closer to the left of the window, or from
  // the right otherwise.
  //
  // TODO(someday): Make this better. We could wait until the popup template has opened and
  //   rendered, then choose a better position based on its full size.
  var rect = Template.instance().firstNode.parentNode.getBoundingClientRect();
  var windowMid = window.innerWidth / 2;
  var itemMid = (rect.left + rect.right) / 2;
  var pos;
  if (itemMid < windowMid) {
    pos = "left: " + Math.max(rect.left - 50, 0) + "px";
  } else {
    pos = "right: " + Math.max(window.innerWidth - rect.right - 50, 0) + "px";
  }

  Template.instance().positionVar.set(pos);
});

Template.sandstormTopbarPopup.helpers({
  isExpanded: function () {
    return Template.parentData(2)._expanded.get() === Template.parentData(1).name;
  },

  position: function () {
    return Template.instance().positionVar.get();
  },
});

SandstormTopbar = function () {
  this._items = {};
  this._itemsTracker = new Tracker.Dependency();

  this._expanded = new ReactiveVar(null);
}

SandstormTopbar.prototype.addItem = function (item) {
  // Adds a new item to the top bar, such as a button or a menu.
  //
  // Returns an object with a close() method which may be called to unregister the item.

  check(item, {
    name: String,
    // CSS class name of this item. Must be unique.

    template: Template,
    // Template for the item content as rendered in the topbar.

    data: Match.Optional(ReactiveVar),
    // Data context for `template`.

    startOpen: Match.Optional(Boolean),
    // If true, this item's popup should start out open.

    priority: Match.Optional(Number),
    // Specifies ordering of items. Higher-priority items will be at the top of the list. Items
    // with the same priority are sorted in the order in which addItem() was called. The default
    // priority is zero.
    //
    // Note that Sandstorm's stylesheet makes some items float: right. Of the items floating
    // right, the highest-priority will be *rightmost*. Essentially, higher-priority items tend
    // towards the outsides of the top bar while lower-priority items going inside of them.
  });

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
      delete self._items[item.name];
      self._itemsTracker.changed();
    }
  };
};
