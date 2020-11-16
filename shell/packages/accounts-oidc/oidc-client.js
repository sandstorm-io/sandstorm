import { Meteor } from "meteor/meteor";
import { OAuth } from "meteor/oauth";
import { Accounts } from "meteor/accounts-base";
import { ServiceConfiguration } from "meteor/service-configuration";
import { Random } from "meteor/random";

Accounts.oauth.registerService("oidc");

const Oidc = {};

Meteor.loginWithOidc = (options, callback) => {
  // support a callback without options
  if (! callback && typeof options === "function") {
    callback = options;
    options = null;
  }

  const credentialRequestCompleteCallback = Accounts.oauth.credentialRequestCompleteHandler(callback);
  Oidc.requestCredential(options, credentialRequestCompleteCallback);
};

// Request OpenID Connect credentials for the user
// @param options {optional}
// @param credentialRequestCompleteCallback {Function} Callback function to call on
//   completion. Takes one argument, credentialToken on success, or Error on
//   error.
Oidc.requestCredential = (options, credentialRequestCompleteCallback) => {
  // support both (options, callback) and (callback).
  if (!credentialRequestCompleteCallback && typeof options === "function") {
    credentialRequestCompleteCallback = options;
    options = {};
  }

  const config = ServiceConfiguration.configurations.findOne({service: "oidc"});
  if (!config) {
    credentialRequestCompleteCallback && credentialRequestCompleteCallback(
      new ServiceConfiguration.ConfigError("Service oidc not configured."));
    return;
  }

  const credentialToken = Random.secret();
  const loginStyle = OAuth._loginStyle("oidc", config, options);
  const state = OAuth._stateParam(loginStyle, credentialToken, options.redirectUrl);

  Meteor.call("resolveOidcSigninUrl", state, function (err, url) {
    if (err) {
      credentialRequestCompleteCallback && credentialRequestCompleteCallback(err);
    } else {
      // options
      options = options || {};
      options.popupOptions = options.popupOptions || {};

      const popupOptions = {
        width:  options.popupOptions.width || 320,
        height: options.popupOptions.height || 450
      };

      OAuth.launchLogin({
        loginService: "oidc",
        loginStyle: loginStyle,
        loginUrl: url,
        credentialRequestCompleteCallback: credentialRequestCompleteCallback,
        credentialToken: credentialToken,
        popupOptions: popupOptions,
      });
    }
  });
};
