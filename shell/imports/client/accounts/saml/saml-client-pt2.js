import { Meteor } from "meteor/meteor";
import { Router } from "meteor/iron:router";

import { loginWithSaml } from "/imports/client/accounts/saml/saml-client";

// Reexported for use in shared/admin.js.  We should probably break that up into
// client/ and server/ pieces so we can actually import functions in the appropriate
// loci.
Meteor.loginWithSaml = loginWithSaml;

Router.route("/saml/logout/default", function () {
  const params = this.params;
  if (!Meteor.user() && !Meteor.loggingIn()) {
    Router.go("root");
  }

  if (Meteor.user()) {
    Meteor.call("validateSamlLogout", params.query.SAMLRequest, function (err) {
      if (err) {
        console.error(err);
      } else {
        Meteor.logout(function () {
          Router.go("root");
        });
      }
    });
  }
});
