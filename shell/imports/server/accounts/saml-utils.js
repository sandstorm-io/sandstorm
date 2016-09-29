import crypto from "crypto";
import querystring from "querystring";
import Url from "url";
import xml2js from "xml2js";
import xmlbuilder from "xmlbuilder";
import xmlCrypto from "xml-crypto";
import xmldom from "xmldom";
import zlib from "zlib";

const HOSTNAME = Url.parse(process.env.ROOT_URL).hostname;

const SAML = function (options) {
  this.options = this.initialize(options);
};

SAML.prototype.initialize = function (options) {
  if (!options) {
    options = {};
  }

  if (!options.protocol) {
    options.protocol = "https://";
  }

  if (!options.path) {
    options.path = "/saml/consume";
  }

  if (!options.issuer) {
    options.issuer = "onelogin_saml";
  }

  if (options.identifierFormat === undefined) {
    options.identifierFormat = "urn:oasis:names:tc:SAML:2.0:nameid-format:persistent";
  }

  return options;
};

SAML.prototype.generateUniqueID = function () {
  const chars = "abcdef0123456789";
  let uniqueID = "";
  for (let i = 0; i < 20; i++) {
    uniqueID += chars.substr(Math.floor((Math.random() * 15)), 1);
  }

  return uniqueID;
};

SAML.prototype.generateInstant = function () {
  const date = new Date();
  return date.getUTCFullYear() + "-" + ("0" + (date.getUTCMonth() + 1)).slice(-2) + "-" + ("0" + date.getUTCDate()).slice(-2) + "T" + ("0" + (date.getUTCHours())).slice(-2) + ":" + ("0" + date.getUTCMinutes()).slice(-2) + ":" + ("0" + date.getUTCSeconds()).slice(-2) + "Z";
};

SAML.prototype.signRequest = function (xml) {
  const signer = crypto.createSign("RSA-SHA1");
  signer.update(xml);
  return signer.sign(this.options.privateCert, "base64");
};

SAML.prototype.generateAuthorizeRequest = function (req) {
  let id = "_" + this.generateUniqueID();
  const instant = this.generateInstant();

  let callbackUrl;
  // Post-auth destination
  if (this.options.callbackUrl) {
    callbackUrl = this.options.callbackUrl;
  } else {
    callbackUrl = this.options.protocol + req.headers.host + this.options.path;
  }

  if (this.options.id)
    id = this.options.id;

  let request =
   "<samlp:AuthnRequest xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\" ID=\"" + id + "\" Version=\"2.0\" IssueInstant=\"" + instant +
   "\" ProtocolBinding=\"urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST\" AssertionConsumerServiceURL=\"" + callbackUrl + "\" Destination=\"" +
   this.options.entryPoint + "\">" +
    "<saml:Issuer xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\">" + this.options.issuer + "</saml:Issuer>\n";

  if (this.options.identifierFormat) {
    request += "<samlp:NameIDPolicy xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\" Format=\"" + this.options.identifierFormat +
    "\" AllowCreate=\"true\"></samlp:NameIDPolicy>\n";
  }

  request +=
    "<samlp:RequestedAuthnContext xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\" Comparison=\"exact\">" +
      "<saml:AuthnContextClassRef xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\">" +
        "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport" +
      "</saml:AuthnContextClassRef>" +
    "</samlp:RequestedAuthnContext>\n" +
  "</samlp:AuthnRequest>";

  return request;
};

SAML.prototype.generateLogoutRequest = function (req) {
  const id = "_" + this.generateUniqueID();
  const instant = this.generateInstant();

  //samlp:LogoutRequest xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
  // ID="_135ad2fd-b275-4428-b5d6-3ac3361c3a7f" Version="2.0" Destination="https://idphost/adfs/ls/"
  //IssueInstant="2008-06-03T12:59:57Z"><saml:Issuer>myhost</saml:Issuer><NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress"
  //NameQualifier="https://idphost/adfs/ls/">myemail@mydomain.com</NameID<samlp:SessionIndex>_0628125f-7f95-42cc-ad8e-fde86ae90bbe
  //</samlp:SessionIndex></samlp:LogoutRequest>

  const request = "<samlp:LogoutRequest xmlns:samlp=\"urn:oasis:names:tc:SAML:2.0:protocol\" " +
    "xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\" ID=\"" + id + "\" Version=\"2.0\" IssueInstant=\"" + instant +
    "\" Destination=\"" + this.options.entryPoint + "\">" +
    "<saml:Issuer xmlns:saml=\"urn:oasis:names:tc:SAML:2.0:assertion\">" + this.options.issuer + "</saml:Issuer>" +
    "<saml:NameID Format=\"" + req.user.nameIDFormat + "\">" + req.user.nameID + "</saml:NameID>" +
    "</samlp:LogoutRequest>";
  return request;
};

SAML.prototype.requestToUrl = function (request, operation, callback) {
  const _this = this;
  zlib.deflateRaw(request, function (err, buffer) {
    if (err) {
      return callback(err);
    }

    const base64 = buffer.toString("base64");
    let target = _this.options.entryPoint;

    if (operation === "logout") {
      if (_this.options.logoutUrl) {
        target = _this.options.logoutUrl;
      }
    }

    if (target.indexOf("?") > 0)
      target += "&";
    else
      target += "?";

    const samlRequest = {
      SAMLRequest: base64,
    };

    if (_this.options.privateCert) {
      samlRequest.SigAlg = "http://www.w3.org/2000/09/xmldsig#rsa-sha1";
      samlRequest.Signature = _this.signRequest(querystring.stringify(samlRequest));
    }

    target += querystring.stringify(samlRequest);

    callback(null, target);
  });
};

SAML.prototype.getAuthorizeUrl = function (req, callback) {
  const request = this.generateAuthorizeRequest(req);

  this.requestToUrl(request, "authorize", callback);
};

SAML.prototype.getLogoutUrl = function (req, callback) {
  const request = this.generateLogoutRequest(req);

  this.requestToUrl(request, "logout", callback);
};

SAML.prototype.certToPEM = function (cert) {
  cert = cert.match(/.{1,64}/g).join("\n");
  cert = "-----BEGIN CERTIFICATE-----\n" + cert;
  cert = cert + "\n-----END CERTIFICATE-----\n";
  return cert;
};

SAML.prototype.validateSignature = function (xml, cert) {
  const _this = this;
  const doc = new xmldom.DOMParser().parseFromString(xml);
  const signature = xmlCrypto.xpath(doc, "//*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']")[0];
  const sig = new xmlCrypto.SignedXml();
  sig.keyInfoProvider = {
    getKeyInfo: function (key) {
      return "<X509Data></X509Data>";
    },

    getKey: function (keyInfo) {
      return _this.certToPEM(cert);
    },
  };
  sig.loadSignature(signature.toString());
  return sig.checkSignature(xml);
};

SAML.prototype.getElement = function (parentElement, elementName) {
  if (parentElement["saml:" + elementName]) {
    return parentElement["saml:" + elementName];
  } else if (parentElement["samlp:" + elementName]) {
    return parentElement["samlp:" + elementName];
  } else if (parentElement["saml2p:" + elementName]) {
    return parentElement["saml2p:" + elementName];
  } else if (parentElement["saml2:" + elementName]) {
    return parentElement["saml2:" + elementName];
  }

  return parentElement[elementName];
};

SAML.prototype.validateResponse = function (samlResponse, callback) {
  const _this = this;
  const xml = new Buffer(samlResponse, "base64").toString("utf8");
  const parser = new xml2js.Parser({ explicitRoot: true });
  parser.parseString(xml, function (err, doc) {
    // Verify signature
    if (_this.options.cert && !_this.validateSignature(xml, _this.options.cert)) {
      return callback(new Error("Invalid signature"), null, false, xml);
    }

    const response = _this.getElement(doc, "Response");
    if (response) {
      const assertion = _this.getElement(response, "Assertion");
      if (!assertion) {
        return callback(new Error("Missing SAML assertion"), null, false, xml);
      }

      profile = {};

      if (response.$ && response.$.InResponseTo) {
        profile.inResponseToId = response.$.InResponseTo;
      }

      if (response.$ && response.$.Destination) {
        if (!response.$.Destination.startsWith(process.env.ROOT_URL)) {
          return callback(new Error("SAML Response received with invalid Destination: " +
            response.$.Destination), null, false, xml);
        }
      }

      const issuer = _this.getElement(assertion[0], "Issuer");
      if (issuer) {
        profile.issuer = issuer[0];
      }

      const subject = _this.getElement(assertion[0], "Subject");
      if (subject) {
        const nameID = _this.getElement(subject[0], "NameID");
        if (nameID) {
          profile.nameID = nameID[0]._;

          if (nameID[0].$.Format) {
            profile.nameIDFormat = nameID[0].$.Format;
            if (profile.nameIDFormat.toLowerCase().indexOf("transient") !== -1) {
              return callback(new Error(
                  "SAML returned a transient NameID. Sandstorm requires a persistent NameID. " +
                  "Please check your IdP config."), null, false, xml);
            }
          }
        }

        const subjectConfirmation = _this.getElement(subject[0], "SubjectConfirmation");
        if (subjectConfirmation) {
          const subjectConfirmationData = _this.getElement(subjectConfirmation[0],
            "SubjectConfirmationData")[0];
          if (subjectConfirmationData) {
            const recipient = subjectConfirmationData.$.Recipient;
            if (recipient && !recipient.startsWith(process.env.ROOT_URL)) {
              return callback(new Error("SAML sent to wrong recipient"), null, false, xml);
            }

            const nowMs = Date.now();
            const notBefore = subjectConfirmationData.$.NotBefore;
            if (notBefore && nowMs < Date.parse(notBefore)) {
              return callback(new Error("SAML assertion was signed for the future."), null, false, xml);
            }

            const notOnOrAfter = subjectConfirmationData.$.NotOnOrAfter;
            if (notOnOrAfter && nowMs >= Date.parse(notOnOrAfter)) {
              return callback(new Error("SAML assertion was signed for the past."), null, false, xml);
            }
          }
        }
      }

      const conditions = _this.getElement(assertion[0], "Conditions")[0];
      if (conditions) {
        for (const key in conditions) {
          if (conditions.hasOwnProperty(key)) {
            const value = conditions[key];
            if (key === "$") {
              const nowMs = Date.now();
              const notBefore = value.NotBefore;
              if (notBefore && nowMs < Date.parse(notBefore)) {
                return callback(new Error("SAML condition NotBefore is in the future."),
                                null, false, xml);
              }

              const notOnOrAfter = value.NotOnOrAfter;
              if (notOnOrAfter && nowMs >= Date.parse(notOnOrAfter)) {
                return callback(new Error("SAML condition notOnOrAfter is in the past."),
                                null, false, xml);
              }
            } else if (key.endsWith("AudienceRestriction") ||
                       key.endsWith("OneTimeUse") ||
                       key.endsWith("ProxyRestriction")) {
              continue;
              // Do nothing.
              // We already check both Destination and SubjectConfirmation.Recipient, so
              // the Audience constraint isn't as important, and is tricky to handle
              // correctly.
              // OneTimeUse is actually very tricky to get right, and requires a cache of
              // previously seen assertions (or at least their hashes). In Sandstorm's case,
              // we would probably need to stuff it in Mongo to make it robust across multiple
              // front-ends. It is a very rarely used constraint anyways.
              // ProxyRestriction constraints only govern the future use of the assertion by the
              // SP. We don't fall under this constraint so it's meaningless to us. As per the
              // spec, it is always considered valid.
            } else {
              return callback(new Error("Unrecognized SAML constraint: " + key), null, false, xml);
            }
          }
        }
      }

      const attributeStatement = _this.getElement(assertion[0], "AttributeStatement");
      if (attributeStatement) {
        const attributes = _this.getElement(attributeStatement[0], "Attribute");

        if (attributes) {
          attributes.forEach(function (attribute) {
            const value = _this.getElement(attribute, "AttributeValue");
            if (typeof value[0] === "string") {
              profile[attribute.$.Name] = value[0];
            } else {
              profile[attribute.$.Name] = value[0]._;
            }
          });
        }

        if (!profile.mail && profile["urn:oid:0.9.2342.19200300.100.1.3"]) {
          // See http://www.incommonfederation.org/attributesummary.html for definition of attribute OIDs
          profile.mail = profile["urn:oid:0.9.2342.19200300.100.1.3"];
        }

        if (!profile.email && profile.mail) {
          profile.email = profile.mail;
        }

        const microsoftEmail = profile["http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress"];
        if (!profile.email && microsoftEmail) {
          profile.email = microsoftEmail;
        }

        const microsoftDisplayName = profile["http://schemas.microsoft.com/identity/claims/displayname"];
        if (!profile.displayName && microsoftDisplayName) {
          profile.displayName = microsoftDisplayName;
        }
      }

      if (!profile.email && profile.nameID && profile.nameIDFormat && profile.nameIDFormat.indexOf("emailAddress") >= 0) {
        profile.email = profile.nameID;
      }

      callback(null, profile, false, xml);
    } else {
      const logoutResponse = _this.getElement(doc, "LogoutResponse");

      if (logoutResponse) {
        callback(null, null, true, xml);
      } else {
        return callback(new Error("Unknown SAML response message"), null, false, xml);
      }

    }

  });
};

SAML.prototype.generateServiceProviderMetadata = function () {
  const entityId = this.options.issuer;
  let metadata = {
    "EntityDescriptor": {
      "@xmlns": "urn:oasis:names:tc:SAML:2.0:metadata",
      "@xmlns:ds": "http://www.w3.org/2000/09/xmldsig#",
      "@entityID": entityId,
      "@ID": entityId.replace(/\W/g, "_"),
      "SPSSODescriptor": {
        "@protocolSupportEnumeration": "urn:oasis:names:tc:SAML:2.0:protocol",
      },
    },
  };

  let decryptionCert = this.options.localCertPublic; // TODO(someday); support local certs
  if (decryptionCert) {
    decryptionCert = decryptionCert.replace(/-+BEGIN CERTIFICATE-+\r?\n?/, "");
    decryptionCert = decryptionCert.replace(/-+END CERTIFICATE-+\r?\n?/, "");
    decryptionCert = decryptionCert.replace(/\r\n/g, "\n");

    metadata.EntityDescriptor.SPSSODescriptor.KeyDescriptor = {
      "ds:KeyInfo": {
        "ds:X509Data": {
          "ds:X509Certificate": {
            "#text": decryptionCert,
          },
        },
      },
      "EncryptionMethod": [
        // this should be the set that the xmlenc library supports
        { "@Algorithm": "http://www.w3.org/2001/04/xmlenc#aes256-cbc" },
        { "@Algorithm": "http://www.w3.org/2001/04/xmlenc#aes128-cbc" },
        { "@Algorithm": "http://www.w3.org/2001/04/xmlenc#tripledes-cbc" },
      ],
    };
  }

  if (this.options.logoutCallbackUrl) {
    metadata.EntityDescriptor.SPSSODescriptor.SingleLogoutService = {
      "@Binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
      "@Location": this.options.logoutCallbackUrl,
    };
  }

  metadata.EntityDescriptor.SPSSODescriptor.NameIDFormat = this.options.identifierFormat;
  metadata.EntityDescriptor.SPSSODescriptor.AssertionConsumerService = {
    "@index": "1",
    "@isDefault": "true",
    "@Binding": "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST",
    "@Location":  Meteor.absoluteUrl("_saml/validate/default"),
  };

  return xmlbuilder.create(metadata).end({ pretty: true, indent: "  ", newline: "\n" });
};

export { SAML };
