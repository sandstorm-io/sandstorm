import { Template } from "meteor/templating";
import { Router } from "meteor/vlasky:galvanized-iron-router";
import { Session } from "meteor/session";

import { globalDb } from "/imports/db-deprecated";

Template.adminNavItem.helpers({
  linkRoute() {
    const routeName = (Template.currentData() || {}).routeName;
    if (!routeName) {
      console.error("adminNavItem missing routeName:", Template.currentData());
    }

    return routeName;
  },

  linkClass() {
    return (Template.currentData() || {}).class;
  },

  linkData() {
    return (Template.currentData() || {}).data;
  },
});

Template.newAdmin.helpers({
  setDocumentTitle: function () {
    document.title = "Admin panel · " + globalDb.getServerTitle();
  },

  adminTab() {
    return Router.current().route.getName();
  },

  wildcardHostSeemsBroken() {
    return Session.get("alreadyTestedWildcardHost") && !Session.get("wildcardHostWorks");
  },
});
