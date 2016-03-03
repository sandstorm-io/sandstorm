if (Meteor.isClient) {
  Meteor.loginWithGoogle = function (options, callback) {
    // support a callback without options
    if (!callback && typeof options === "function") {
      callback = options;
      options = null;
    }

    const credentialRequestCompleteCallback = Accounts.oauth.credentialRequestCompleteHandler(callback);
    Google.requestCredential(options, credentialRequestCompleteCallback);
  };

  Meteor.loginWithGithub = function (options, callback) {
    // support a callback without options
    if (!callback && typeof options === "function") {
      callback = options;
      options = null;
    }

    const credentialRequestCompleteCallback = Accounts.oauth.credentialRequestCompleteHandler(callback);
    Github.requestCredential(options, credentialRequestCompleteCallback);
  };
}

if (Meteor.isServer) {
  Google.whitelistedFields = Google.whitelistedFields.concat(["hd"]);
  // hd is the "hosted domain" parameter. It is only present for google accounts that are part of a
  // google apps for work domain.
}

Accounts.identityServices = {};
// A dictionary of identity services. At the moment, this is mainly used for rendering login UI
// components. Each key in the dictionary is the name of the service, e.g. "github", exactly as it
// would appear in the `Users.profile.service` field in the Sandstorm database. Each value in the
// dictionary is an object with the following fields:
//
//   isEnabled: A function of no arguments. Returns a boolean indicating whether this service is
//              currently configured to be active.
//   loginTemplate: An object indicating how to render this service's login UI. Contains the
//                  following fields:
//       name: The name of the template to render.
//       priority: Number representing this template's sort order when it appears within a list
//                 with other login templates. Lower priority means higher in the list.
//       data: An object to pass along to the template when it is rendered. The value of this
//             field will be placed in the `data` field. In addition, there will be a
//             boolean `linkingNewIdentity` field, which is true if the component is currently being
//             used to link an new identity, rather than just to log in.
//
// TODO(someday): It probably makes sense also to collect in these objects the service-specific
// user initialization logic currently found in sandstorm-db/user.js and sandstorm-db/profile.js.
