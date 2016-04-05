Template.adminNavPill.helpers({
  currentRouteNameIs(name) {
    return Router.current().route.getName() === name;
  },
});

Template.newAdmin.helpers({
  adminTab() {
    return Router.current().route.getName();
  },

  wildcardHostSeemsBroken() {
    return Session.get("alreadyTestedWildcardHost") && !Session.get("wildcardHostWorks");
  },
});
