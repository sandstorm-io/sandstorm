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
import { Blaze } from "meteor/blaze";
import { Template } from "meteor/templating";
import { Session } from "meteor/session";
import { Iron, Router } from "meteor/vlasky:galvanized-iron-router";

import { globalDb } from "/imports/db-deprecated";
import { SandstormTopbar } from "/imports/sandstorm-ui-topbar/topbar";

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function() {
    navigator.serviceWorker.register('/pwa-service-worker.js')
  })
}

import AccountsUi from "/imports/client/accounts/accounts-ui";
import { GrainViewList } from "/imports/client/grain/grainview-list";

Session.setDefault("shrink-navbar", false);
// window.globalGrains is used by test code and must remain exported.
const globalGrains = new GrainViewList(globalDb);
globalThis.globalGrains = globalGrains;

// If Meteor._localStorage disappears, we'll have to write our own localStorage wrapper, I guess.
// Using window.localStorage is dangerous because it throws an exception if cookies are disabled.
Session.set("shrink-navbar", Meteor._localStorage.getItem("shrink-navbar") === "true");
const globalTopbar = new SandstormTopbar(globalDb,
  {
    get() {
      return Session.get("topbar-expanded");
    },

    set(value) {
      Session.set("topbar-expanded", value);
    },
  },
  globalGrains,
  {
    get() {
      return Session.get("shrink-navbar");
    },

    set(value) {
      Meteor._localStorage.setItem("shrink-navbar", value);
      Session.set("shrink-navbar", value);
    },
  });
globalThis.globalTopbar = globalTopbar;

const globalAccountsUi = new AccountsUi(globalDb);
globalThis.globalAccountsUi = globalAccountsUi;

Template.registerHelper("globalTopbar", () => { return globalTopbar; });
Template.registerHelper("globalAccountsUi", () => { return globalAccountsUi; });

const forceReplica = function (replica) {
  // Helper function for blackrock debugging.
  document.cookie = "force_replica=" + replica + ";path=/;domain=." + window.location.hostname;
};
globalThis.forceReplica = forceReplica;

const unwrapTemplateValue = (value) => {
  if (value === null || value === undefined) return value;

  if (typeof value === "function") {
    try {
      return unwrapTemplateValue(value());
    } catch (e) {
      return value;
    }
  }

  if (Array.isArray(value)) {
    return value.map((part) => unwrapTemplateValue(part));
  }

  if (typeof value === "object" && !value.htmljsType &&
      Object.prototype.hasOwnProperty.call(value, "value")) {
    return unwrapTemplateValue(value.value);
  }

  return value;
};

const patchDynamicTemplateAccessors = () => {
  if (globalThis.__sandstormDynamicTemplateUnwrapPatchInstalled) return true;
  if (!Iron || !Iron.DynamicTemplate) return false;

  const dt = Iron.DynamicTemplate;
  const methods = ["getInclusionArguments", "getParentDataContext", "getDataContext"];
  methods.forEach((method) => {
    if (typeof dt[method] !== "function" || dt[method].__sandstormWrapped) return;
    const original = dt[method];
    const wrapped = function (...args) {
      return unwrapTemplateValue(original.apply(this, args));
    };

    wrapped.__sandstormWrapped = true;
    dt[method] = wrapped;
  });

  globalThis.__sandstormDynamicTemplateUnwrapPatchInstalled = true;
  return true;
};

const installRouterTemplateHelpers = () => {
  if (globalThis.__sandstormRouterHelperPatchInstalled) return true;
  if (!Iron || !Iron.DynamicTemplate || !Router || typeof UI === "undefined" ||
      typeof HTML === "undefined") {
    return false;
  }

  const warn = (condition, message) => {
    if (Iron.utils && typeof Iron.utils.warn === "function") {
      Iron.utils.warn(condition, message);
    } else if (!condition) {
      console.warn(message);
    }
  };

  const normalizeOptions = (options, routeNameArg, dataContext) => {
    const rawOpts = unwrapTemplateValue(options && options.hash) || {};
    const opts = (rawOpts && typeof rawOpts === "object" && !Array.isArray(rawOpts)) ? rawOpts : {};
    const routeName = unwrapTemplateValue(routeNameArg || opts.route);
    const query = unwrapTemplateValue(opts.query);
    const hash = unwrapTemplateValue(opts.hash);

    let data = unwrapTemplateValue(opts.data);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      data = unwrapTemplateValue(dataContext);
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      data = {};
    }

    return { opts, routeName, query, hash, data };
  };

  const addRouteParams = (route, opts, data) => {
    if (!route || !route.handler || !route.handler.compiledUrl ||
        !Array.isArray(route.handler.compiledUrl.keys)) {
      return;
    }

    route.handler.compiledUrl.keys.forEach((keyConfig) => {
      const key = keyConfig && keyConfig.name;
      if (key && Object.prototype.hasOwnProperty.call(opts, key)) {
        data[key] = unwrapTemplateValue(opts[key]);
      }
    });
  };

  UI.registerHelper("pathFor", function (options) {
    let routeNameArg;
    if (arguments.length > 1) {
      routeNameArg = arguments[0];
      options = arguments[1] || {};
    }

    const cfg = normalizeOptions(options, routeNameArg, this);
    const route = Router.routes[cfg.routeName];
    warn(route, "pathFor couldn't find a route named " + JSON.stringify(cfg.routeName));
    if (!route) return "";

    addRouteParams(route, cfg.opts, cfg.data);
    return route.path(cfg.data, { query: cfg.query, hash: cfg.hash });
  });

  UI.registerHelper("urlFor", function (options) {
    let routeNameArg;
    if (arguments.length > 1) {
      routeNameArg = arguments[0];
      options = arguments[1] || {};
    }

    const cfg = normalizeOptions(options, routeNameArg, this);
    const route = Router.routes[cfg.routeName];
    warn(route, "urlFor couldn't find a route named " + JSON.stringify(cfg.routeName));
    if (!route) return "";

    addRouteParams(route, cfg.opts, cfg.data);
    return route.url(cfg.data, { query: cfg.query, hash: cfg.hash });
  });

  UI.registerHelper("linkTo", new Blaze.Template("linkTo", function () {
    const opts = unwrapTemplateValue(Iron.DynamicTemplate.getInclusionArguments(this)) || {};
    if (typeof opts !== "object" || Array.isArray(opts)) {
      throw new Error("linkTo options must be key value pairs such as {{#linkTo route='my.route.name'}}.");
    }

    const query = unwrapTemplateValue(opts.query);
    const hash = unwrapTemplateValue(opts.hash);
    const routeName = unwrapTemplateValue(opts.route);
    const route = Router.routes[routeName];
    warn(route, "linkTo couldn't find a route named " + JSON.stringify(routeName));

    const parentData = unwrapTemplateValue(Iron.DynamicTemplate.getParentDataContext(this));
    const baseData = unwrapTemplateValue(opts.data);
    const data = Object.assign(
      {},
      (parentData && typeof parentData === "object" && !Array.isArray(parentData)) ? parentData : {},
      (baseData && typeof baseData === "object" && !Array.isArray(baseData)) ? baseData : {},
    );

    addRouteParams(route, opts, data);

    const attrs = {};
    Object.keys(opts).forEach((key) => {
      if (key === "route" || key === "query" || key === "hash" || key === "data") return;
      if (route && route.handler && route.handler.compiledUrl &&
          Array.isArray(route.handler.compiledUrl.keys) &&
          route.handler.compiledUrl.keys.some((k) => k && k.name === key)) {
        return;
      }

      attrs[key] = unwrapTemplateValue(opts[key]);
    });

    attrs.href = route ? route.path(data, { query, hash }) : "";
    return HTML.A(attrs, this.templateContentBlock);
  }));

  globalThis.__sandstormRouterHelperPatchInstalled = true;
  return true;
};

const installIronRouterMeteor3Compat = () => {
  const dtReady = patchDynamicTemplateAccessors();
  const helpersReady = installRouterTemplateHelpers();
  return dtReady && helpersReady;
};

installIronRouterMeteor3Compat();
