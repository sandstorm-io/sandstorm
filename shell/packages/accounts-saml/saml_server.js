if (!Accounts.saml) {
  Accounts.saml = {};
}

const Url = Npm.require("url");
const Fiber = Npm.require("fibers");

// We need to use connect. Let's make sure we're using the same version as Meteor's WebApp module
// uses. Fortunately, they let us extract it.
const connect = WebAppInternals.NpmModules.connect.module;

RoutePolicy.declare("/_saml/", "network");

const HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;

Accounts.registerLoginHandler(function (loginRequest) {
  if (!loginRequest.saml || !loginRequest.credentialToken) {
    return undefined;
  }

  if (!Accounts.identityServices.saml.isEnabled()) {
    throw new Meteor.Error(403, "SAML service is disabled.");
  }

  const loginResult = Accounts.saml.retrieveCredential(loginRequest.credentialToken);
  if (!loginResult) {
    throw new Meteor.Error(500, "SAML login did not complete.");
  } else if (loginResult.profile && loginResult.profile.email) {
    let user = _.pick(loginResult.profile, "displayName", "email");
    user.id = loginResult.profile.nameID;
    return Accounts.updateOrCreateUserFromExternalService("saml", user, {});
  } else {
    throw new Meteor.Error(500, "SAML profile did not contain an email address");
  }
});

// TODO(soon): This may need to be a Mongo collection in order to work when the frontend is
//   replicated (but currently Sandstorm for Work is not replicated).
Accounts.saml._loginResultForCredentialToken = {};

Accounts.saml.hasCredential = function (credentialToken) {
  return _.has(Accounts.saml._loginResultForCredentialToken, credentialToken);
};

Accounts.saml.retrieveCredential = function (credentialToken) {
  const result = Accounts.saml._loginResultForCredentialToken[credentialToken];
  delete Accounts.saml._loginResultForCredentialToken[credentialToken];
  return result;
};

// Listen to incoming OAuth http requests
WebApp.connectHandlers.use(connect.urlencoded()).use(function (req, res, next) {
  // Need to create a Fiber since we're using synchronous http calls and nothing
  // else is wrapping this in a fiber automatically
  Fiber(function () {
    middleware(req, res, next);
  }).run();
});

middleware = function (req, res, next) {
  // Make sure to catch any exceptions because otherwise we'd crash
  // the runner
  try {
    if (!Accounts.identityServices.saml.isEnabled()) {
      next();
      return;
    }

    const samlObject = samlUrlToObject(req.url);
    if (!samlObject || !samlObject.serviceName) {
      next();
      return;
    }

    if (!samlObject.actionName)
      throw new Error("Missing SAML action");

    const entityId = SandstormDb.prototype.getSamlEntityId();
    const service = {
      "provider": "default",
      "entryPoint": SandstormDb.prototype.getSamlEntryPoint(),
      // TODO(someday): find a better way to inject the DB
      "issuer": entityId || HOSTNAME,
      "cert": SandstormDb.prototype.getSamlPublicCert(),
    };

    // Skip everything if there's no service set by the saml middleware
    if (!service || samlObject.serviceName !== service.provider)
      throw new Error("Unexpected SAML service " + samlObject.serviceName);

    if (samlObject.actionName === "authorize") {
      service.callbackUrl = Meteor.absoluteUrl("_saml/validate/" + service.provider);
      service.id = samlObject.credentialToken;
      _saml = new SAML(service);
      _saml.getAuthorizeUrl(req, function (err, url) {
        if (err)
          throw new Error("Unable to generate authorize url");
        res.writeHead(302, { "Location": url });
        res.end();
      });
    } else if (samlObject.actionName === "validate") {
      _saml = new SAML(service);
      _saml.validateResponse(req.body.SAMLResponse, function (err, profile, loggedOut) {
        if (err) {
          console.error("Error validating SAML response", err.toString());
          throw new Error("Unable to validate response url");
        }

        // Do NOT use samlObject.credentialToken; it isn't signed!
        const credentialToken = profile.inResponseToId || profile.InResponseTo;
        if (!credentialToken) {
          throw new Error(
              "SAML response missing InResponseTo attribute. Sandstorm does not support " +
              "IdP-initiated authentication; authentication requests must start " +
              "from the user choosing SAML login in the Sandstorm UI.");
        }

        Accounts.saml._loginResultForCredentialToken[credentialToken] = {
          profile: profile,
        };

        closePopup(res);
      });
    } else if (samlObject.actionName === "config") {
      _saml = new SAML(service);
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(_saml.generateServiceProviderMetadata());
    } else {
      throw new Error("Unexpected SAML action " + samlObject.actionName);
    }
  } catch (err) {
    closePopup(res, err);
  }
};

const samlUrlToObject = function (url) {
  // req.url will be "/_saml/<action>/<service name>/<credentialToken>"
  if (!url)
    return null;

  const splitPath = url.split("/");

  // Any non-saml request will continue down the default
  // middlewares.
  if (splitPath[1] !== "_saml")
    return null;

  return {
    actionName: splitPath[2],
    serviceName: splitPath[3],
    credentialToken: splitPath[4],
  };
};

const closePopup = function (res, err) {
  res.writeHead(200, { "Content-Type": "text/html" });
  let content =
        "<html><head><script>window.close()</script></head></html>";
  if (err)
    content = "<html><body><h2>Sorry, an error occured</h2><div>" + err + '</div><a onclick="window.close();">Close Window</a></body></html>';
  res.end(content, "utf-8");
};
