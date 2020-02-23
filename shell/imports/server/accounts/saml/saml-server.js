import Url from "url";
import zlib from "zlib";
import { SAML } from "/imports/server/accounts/saml-utils.js";

import Fiber from "fibers";
import BodyParser from "body-parser";

if (!Accounts.saml) {
  Accounts.saml = {};
}

RoutePolicy.declare("/_saml/", "network");

const HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;

// TODO(soon): This may need to be a Mongo collection in order to work when the frontend is
//   replicated (but currently SAML is not used on any Blackrock servers).
const _loginResultForCredentialToken = {};

const retrieveCredential = function (credentialToken) {
  const result = _loginResultForCredentialToken[credentialToken];
  delete _loginResultForCredentialToken[credentialToken];
  return result;
};

Accounts.registerLoginHandler(function (loginRequest) {
  if (!loginRequest.saml || !loginRequest.credentialToken) {
    return undefined;
  }

  if (!Accounts.loginServices.saml.isEnabled()) {
    throw new Meteor.Error(403, "SAML service is disabled.");
  }

  const loginResult = retrieveCredential(loginRequest.credentialToken);
  if (!loginResult) {
    throw new Meteor.Error(500, "SAML login did not complete.");
  } else if (loginResult.profile && loginResult.profile.email) {
    let user = _.pick(loginResult.profile, "displayName", "email", "nameIDFormat");
    user.id = loginResult.profile.nameID;
    return Accounts.updateOrCreateUserFromExternalService("saml", user, {});
  } else {
    throw new Meteor.Error(500, "SAML profile did not contain an email address");
  }
});

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
    content = "<html><body><h2>Sorry, an error occured</h2><div>" + err + '</div><a onclick="window.close();">Close Window</a> <a href="/admin/status" target="_blank">View system log (admin only)</a></body></html>';
  res.end(content, "utf-8");
};

const generateService = function () {
  // TODO(cleanup): Inject the db.
  const db = new SandstormDb();

  const entityId = db.getSamlEntityId();
  const service = {
    "provider": "default",
    "entryPoint": db.getSamlEntryPoint(),
    "logoutUrl": db.getSamlLogout(),
    // TODO(someday): find a better way to inject the DB
    "issuer": entityId || HOSTNAME,
    // If the certificate has "-----BEGIN CERTIFICATE-----" markers, automatically remove those.
    "cert": db.getSamlPublicCert().replace(/-[^\n]*-/g, "").trim(),
  };
  return service;
};

const middleware = function (req, res, next) {
  // Make sure to catch any exceptions because otherwise we'd crash
  // the runner
  try {
    const samlObject = samlUrlToObject(req.url);
    if (!samlObject || !samlObject.serviceName) {
      next();
      return;
    }

    if (samlObject.actionName === "config") {
      const _saml = new SAML(generateService());
      res.writeHead(200, { "Content-Type": "text/xml" });
      res.end(_saml.generateServiceProviderMetadata());
      return;
    }

    if (!Accounts.loginServices.saml.isEnabled()) {
      next();
      return;
    }

    if (!samlObject.actionName)
      throw new Error("Missing SAML action");

    const service = generateService();

    // Skip everything if there's no service set by the saml middleware
    if (!service || samlObject.serviceName !== service.provider)
      throw new Error("Unexpected SAML service " + samlObject.serviceName);

    if (samlObject.actionName === "authorize") {
      service.callbackUrl = Meteor.absoluteUrl("_saml/validate/" + service.provider);
      service.id = samlObject.credentialToken;
      const _saml = new SAML(service);
      _saml.getAuthorizeUrl(req, function (err, url) {
        if (err)
          throw new Error("Unable to generate authorize url");
        res.writeHead(302, { "Location": url });
        res.end();
      });
    } else if (samlObject.actionName === "validate") {
      const _saml = new SAML(service);
      _saml.validateResponse(req.body.SAMLResponse,
          function (err, profile, loggedOut, responseText) {
        if (err) {
          console.error("Error validating SAML response:", err.toString(),
                        "\nFull SAML response XML:\n", responseText);
          throw new Error("Unable to validate SAML response.");
        }

        // Do NOT use samlObject.credentialToken; it isn't signed!
        const credentialToken = profile.inResponseToId || profile.InResponseTo;
        if (!credentialToken) {
          throw new Error(
              "SAML response missing InResponseTo attribute. Sandstorm does not support " +
              "IdP-initiated authentication; authentication requests must start " +
              "from the user choosing SAML login in the Sandstorm UI.");
        }

        _loginResultForCredentialToken[credentialToken] = {
          profile: profile,
        };

        closePopup(res);
      });
    } else {
      throw new Error("Unexpected SAML action " + samlObject.actionName);
    }
  } catch (err) {
    console.error(err.stack);
    closePopup(res, err);
  }
};

// Listen to incoming OAuth http requests
WebApp.connectHandlers.use(BodyParser.urlencoded()).use(function (req, res, next) {
  // Need to create a Fiber since we're using synchronous http calls and nothing
  // else is wrapping this in a fiber automatically
  Fiber(function () {
    middleware(req, res, next);
  }).run();
});

Meteor.methods({
  generateSamlLogout: function () {
    const service = generateService();
    if (!service.logoutUrl) {
      throw new Meteor.Error(500, "No SAML logout url specified");
    }

    const _saml = new SAML(service);
    let credential;
    Meteor.user().loginCredentials.forEach((_credential) => {
      const currCredential = Meteor.users.findOne({ _id: _credential.id, });
      if (currCredential.services.saml) {
        credential = currCredential;
      }
    });
    // TODO(someday): handle user having more than one SAML credential

    return Meteor.wrapAsync(_saml.getLogoutUrl.bind(_saml))({
      user: {
        nameID: credential.services.saml.id,
        nameIDFormat: credential.services.saml.nameIDFormat ||
          "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent",
      },
    });
  },

  validateSamlLogout: function (samlRequest) {
    check(samlRequest, String);

    const db = this.connection.sandstormDb;
    const userId = Meteor.userId();
    if (!userId) {
      return new Meteor.Error(403, "Non-logged in users can't logout.");
    }

    const service = generateService();
    const _saml = new SAML(service);
    if (samlRequest) {
      const buf = new Buffer(samlRequest, "base64");
      const xml = zlib.inflateRawSync(buf).toString();
      _saml.parseLogoutRequest(xml, function (err, nameId) {
        if (err) {
          console.error("Error validating SAML logout response:", err.toString(),
                        "\nFull SAML response XML:\n", responseText);
          throw new Error("Unable to validate SAML logout response.");
        }

        check(nameId, String);
        const credential = db.collections.users.findOne({ "services.saml.id": nameId, },
          { fields: { _id: 1, }, });
        if (!credential) {
          return new Meteor.Error(400, "No credential found matching SAML nameID.");
        }

        const user = db.collections.users.findOne({ "loginCredentials.id": credential._id, },
          { fields: { _id: 1, }, });
        if (!user) {
          return new Meteor.Error(403, "No user found for expected SAML credential.");
        }

        if (user._id !== userId) {
          const txt = "SAML logout requested for wrong user: " + nameId + ", " + userId;
          console.error(txt);
          throw new Error(txt);
        }
      });
    }
  },
});
