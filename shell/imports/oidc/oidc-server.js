import { Accounts } from "meteor/accounts-base";
import { check } from "meteor/check";
import { Meteor } from "meteor/meteor";
import { OAuth } from "meteor/oauth";
import { ServiceConfiguration } from "meteor/service-configuration";
import { SandstormDb } from "/imports/sandstorm-db/db";
import { waitForMigrationDocument } from "/imports/server/migration-coordination";
import { checkMigrationTestFailure } from "/imports/server/migration-testing";
import {
  OIDC_INDEX_MIGRATION_VERSION,
  reconcileOidcUsersIndex,
} from "/imports/server/oidc-index";

import {
  ClientSecretBasic,
  ClientSecretPost,
  Configuration,
  None,
  allowInsecureRequests,
  authorizationCodeGrant,
  buildAuthorizationUrl,
  fetchUserInfo,
  skipSubjectCheck,
} from "openid-client";

// accounts-oauth creates this index as soon as registerService() is called. Reconcile the
// non-unique index left by older Sandstorm releases first so Meteor 3 cannot race migration 42.
const oidcMigrationDb = new SandstormDb();
if (Meteor.settings.replicaNumber) {
  await waitForMigrationDocument(
    oidcMigrationDb.collections.migrations,
    { _id: "migrations_applied" },
    (doc) => doc.value >= OIDC_INDEX_MIGRATION_VERSION,
    { label: "oidc-index-migration" }
  );
} else {
  checkMigrationTestFailure(OIDC_INDEX_MIGRATION_VERSION);
}

await reconcileOidcUsersIndex(oidcMigrationDb);
Accounts.oauth.registerService("oidc");

Accounts.addAutopublishFields({
  forLoggedInUser: ["services.oidc"],
  forOtherUsers: ["services.oidc.id"]
});

function getClientAuthentication(method, secret) {
  switch (method) {
    case "client_secret_basic": return ClientSecretBasic(secret);
    case "client_secret_post": return ClientSecretPost(secret);
    case "none": return None();
    default: throw new Error(`Unsupported OIDC client authentication method: ${method}`);
  }
}

function getClientConfiguration(config, redirectUri) {
  const secret = OAuth.openSecret(config.secret);
  const clientAuthMethod = config.clientAuthMethod || "client_secret_basic";
  const client = new Configuration(config.issuer, config.clientId, {
    client_secret: secret,
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: clientAuthMethod,
  }, getClientAuthentication(clientAuthMethod, secret));
  if (config.issuer.issuer.startsWith("http://")) allowInsecureRequests(client);
  return client;
}

const oidcServiceHandler = async ({code}) => {
  // We don't care about checking `state` -- this has been done by accounts-oauth before:
  // https://github.com/meteor/meteor/blob/85a66b8/packages/accounts-oauth/oauth_server.js#L19

  const config = await getConfiguration();
  const redirectUri = OAuth._redirectUri("oidc", config);
  const client = getClientConfiguration(config, redirectUri);
  const callbackUrl = new URL(redirectUri);
  callbackUrl.searchParams.set("code", code);

  // accounts-oauth validates and consumes its integrity-protected state before
  // invoking this handler, so only the authorization code is passed onward.
  const token = await authorizationCodeGrant(client, callbackUrl);
  const expectedSubject = token.claims()?.sub || skipSubjectCheck;
  const userinfo = await fetchUserInfo(client, token.access_token, expectedSubject);
  const expiresIn = token.expiresIn();

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
    expiresAt  : expiresIn === undefined
      ? undefined
      : Math.floor(Date.now() / 1000) + expiresIn,
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

OAuth.registerService("oidc", 2, null, async query => await oidcServiceHandler(query));

const getConfiguration = async () => {
  const config = await ServiceConfiguration.configurations.findOneAsync({ service: "oidc" });
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
  async resolveOidcSigninUrl(state) {
    check(state, String);

    // Strictly, this method does not need to run on the server: It just builds
    // a URL from the information contained in config.issuer. However, the `Issuer`
    // and `Client` classes cannot easily be used from the browser.

    const config = await ServiceConfiguration.configurations.findOneAsync({ service: "oidc" });
    if (!config) {
      throw new ServiceConfiguration.ConfigError("Service oidc not configured.");
    }

    const redirectUri = OAuth._redirectUri("oidc", config);
    const client = getClientConfiguration(config, redirectUri);
    const scope = config.requestPermissions || ["openid", "profile", "email"];
    return buildAuthorizationUrl(client, {
      redirect_uri: redirectUri,
      response_type: "code",
      scope: scope.join(" "),
      state,
    }).href;
  }
});
