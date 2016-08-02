import { loginWithSaml } from "/imports/client/accounts/saml/saml-client.js";

// Reexported for use in shared/admin.js.  We should probably break that up into
// client/ and server/ pieces so we can actually import functions in the appropriate
// loci.
Meteor.loginWithSaml = loginWithSaml;
