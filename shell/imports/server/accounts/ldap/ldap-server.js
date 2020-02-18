import { LDAP } from "/imports/server/accounts/ldap.js";

// Register login handler with Meteor
Accounts.registerLoginHandler("ldap", function (loginRequest) {
  // If 'ldap' isn't set in loginRequest object,
  // then this isn't the proper handler (return undefined)
  if (!loginRequest.ldap) {
    return undefined;
  }

  if (!Accounts.loginServices.ldap.isEnabled()) {
    throw new Meteor.Error(403, "LDAP service is disabled.");
  }

  check(loginRequest, {
    ldap: true,
    username: String,
    ldapPass: String,
  });

  // Instantiate LDAP
  let ldapObj = new LDAP();

  // Call ldapCheck and get response
  let ldapResponse = ldapObj.ldapCheck(this.connection.sandstormDb, loginRequest);

  if (ldapResponse.error) {
    return {
      userId: null,
      error: ldapResponse.error,
    };
  }  else if (ldapResponse.emptySearch) {
    return {
      userId: null,
      error: new Meteor.Error(403, "User not found in LDAP"),
    };
  }  else {
    // Set initial userId and token vals
    return Accounts.updateOrCreateUserFromExternalService("ldap",
      { id: ldapResponse.dn, username: loginRequest.username,
        rawAttrs: ldapResponse.searchResults, }, {});
  }

});

Meteor.methods({
  updateQuota() {
    return this.connection.sandstormDb.updateUserQuota(Meteor.user());
    // This is a no-op if settings aren't enabled
  },
});
