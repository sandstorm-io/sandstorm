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

// This file provides some helper functions that are used in multiple places
// by client-side code.

import { Tracker } from "meteor/tracker";
import { ReactiveVar } from "meteor/reactive-var";

getOrigin = function () {
  return document.location.protocol + "//" + document.location.host;
};

// Use HTML5 document visibility API to track whether Sandstorm is currently the foreground tab.
// For old browsers that don't support the API, document.hidden will be undefined which is falsy --
// but we don't support such old browsers anyway.
//
// (Note that tracking window focus does not work because the Sandstorm window is considered
// blured when focus is inside an iframe.)
browserTabHidden = new ReactiveVar(document.hidden);

if ("visibilityState" in document) {
  document.addEventListener("visibilitychange", () => {
    browserTabHidden.set(document.hidden);
  });
}

// Maintain a reactive variable storing the current path. This seems harder than it should be.
//
// TODO(cleanup): Surely there is a better way.
function currentPathFromWindow() {
  return window.location.pathname + window.location.search + window.location.hash;
}

currentPath = new ReactiveVar(currentPathFromWindow());

Tracker.autorun(() => {
  // Set current path whenever IronRouter detects a change.

  const current = Router.current();
  if (current && current.url) {
    currentPath.set(current.url);
  }
});

currentPathChanged = () => {
  // Call after using window.history API to change the path. IronRouter does not observe such
  // changes.

  currentPath.set(currentPathFromWindow());
};
