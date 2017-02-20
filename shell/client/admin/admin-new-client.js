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
