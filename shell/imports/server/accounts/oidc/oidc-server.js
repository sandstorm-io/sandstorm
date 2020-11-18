import { Accounts } from "meteor/accounts-base";
import { check } from "meteor/check";
import { Meteor } from "meteor/meteor";
import { OAuth } from "meteor/oauth";
import { ServiceConfiguration } from "meteor/service-configuration";

import { Issuer } from "openid-client";

Accounts.oauth.registerService("oidc");

Accounts.addAutopublishFields({
  forLoggedInUser: ["services.oidc"],
  forOtherUsers: ["services.oidc.id"]
});

const oidcServiceHandler = async ({code, state: _}) => {
  // We don't care about checking `state` -- this has been done by accounts-oauth before:
  // https://github.com/meteor/meteor/blob/85a66b8/packages/accounts-oauth/oauth_server.js#L19

  const config = getConfiguration();
  const issuer = new Issuer(config.issuer);
  const client = new issuer.Client({
    client_id                 : config.clientId,
    client_secret             : OAuth.openSecret(config.secret),
    token_endpoint_auth_method: config.clientAuthMethod
  });

  const redirect_uri = OAuth._redirectUri("oidc", config);

  const token = await client.callback(redirect_uri, { code });
  const userinfo = await client.userinfo(token);

  const meteorUserinfo = {
    id      : userinfo.id || userinfo.sub,
    username: userinfo.username || userinfo.preferred_username,
    email   : userinfo.email,
    name    : userinfo.name
  };

  const serviceData = {
    id         : meteorUserinfo.id,
    username   : meteorUserinfo.username,
    accessToken: OAuth.sealSecret(token.access_token),
    expiresAt  : token.expires_at,
    email      : meteorUserinfo.email
  }

  if (token.refresh_token) {
    serviceData.refreshToken = token.refresh_token;
  }

  const profile = {
    name : userinfo.name,
    email: userinfo.email
  }

  return {
    serviceData: serviceData,
    options: { profile: profile }
  };
};

OAuth.registerService("oidc", 2, null, query => oidcServiceHandler(query).await());

const getConfiguration = () => {
  const config = ServiceConfiguration.configurations.findOne({ service: "oidc" });
  if (!config) {
    throw new ServiceConfiguration.ConfigError("Service oidc not configured.");
  }
  return config;
};

export const Oidc = {
  retrieveCredential: (credentialToken, credentialSecret) =>
    OAuth.retrieveCredential(credentialToken, credentialSecret)
}

Meteor.methods({
  resolveOidcSigninUrl(state) {
    check(state, String);

    // Strictly, this method does not need to run on the server: It just builds
    // a URL from the information contained in config.issuer. However, the `Issuer`
    // and `Client` classes cannot easily be used from the browser.

    const config = ServiceConfiguration.configurations.findOne({service: "oidc"});
    if (!config) {
      throw new ServiceConfiguration.ConfigError("Service oidc not configured.");
    }

    const issuer = new Issuer(config.issuer);
    const client = new issuer.Client({
      client_id: config.clientId,
      redirect_uris: [OAuth._redirectUri("oidc", config)],
    });

    const scope = config.requestPermissions || ["openid", "profile", "email"];
    return client.authorizationUrl({ scope: scope.join(" "), state });
  }
});
