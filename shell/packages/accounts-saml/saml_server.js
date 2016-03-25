if (!Accounts.saml) {
  Accounts.saml = {};
}

var Fiber = Npm.require('fibers');
var connect = Npm.require('connect');
RoutePolicy.declare('/_saml/', 'network');

Accounts.registerLoginHandler(function(loginRequest) {
  if(!loginRequest.saml || !loginRequest.credentialToken) {
    return undefined;
  }
  var loginResult = Accounts.saml.retrieveCredential(loginRequest.credentialToken);
  if(loginResult && loginResult.profile && loginResult.profile.email){
    var user = Meteor.users.findOne({'emails.address':loginResult.profile.email});

    if(!user)
      throw new Error("Could not find an existing user with supplied email " + loginResult.profile.email);


      //creating the token and adding to the user
      var stampedToken = Accounts._generateStampedLoginToken();
      Meteor.users.update(user,
        {$push: {'services.resume.loginTokens': stampedToken}}
      );

      //sending token along with the userId
      return {
        id: user._id,
        token: stampedToken.token
      }

  }else{
    throw new Error("SAML Profile did not contain an email address");
  }
});

Accounts.saml._loginResultForCredentialToken = {};

Accounts.saml.hasCredential = function(credentialToken) {
  return _.has(Accounts.saml._loginResultForCredentialToken, credentialToken);
}

Accounts.saml.retrieveCredential = function(credentialToken) {
  var result = Accounts.saml._loginResultForCredentialToken[credentialToken];
  delete Accounts.saml._loginResultForCredentialToken[credentialToken];
  return result;
}

// Listen to incoming OAuth http requests
WebApp.connectHandlers.use(connect.bodyParser()).use(function(req, res, next) {
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
    var samlObject = samlUrlToObject(req.url);
    if(!samlObject || !samlObject.serviceName){
      next();
      return;
    }

    if(!samlObject.actionName)
      throw new Error("Missing SAML action");

    var service = _.find(Meteor.settings.saml, function(samlSetting){
      return samlSetting.provider === samlObject.serviceName;
    });

    // Skip everything if there's no service set by the saml middleware
    if (!service)
      throw new Error("Unexpected SAML service " + samlObject.serviceName);

    if(samlObject.actionName === "authorize"){
      service.callbackUrl = Meteor.absoluteUrl("_saml/validate/"+service.provider+"/"+samlObject.credentialToken);
      service.id = samlObject.credentialToken;
      _saml = new SAML(service);
      _saml.getAuthorizeUrl(req, function (err, url) {
        if(err)
          throw new Error("Unable to generate authorize url");
        res.writeHead(302, {'Location': url});
        res.end();
      });
    }else if (samlObject.actionName === "validate"){
      _saml = new SAML(service);
      _saml.validateResponse(req.body.SAMLResponse, function (err, profile, loggedOut) {
        if(err)
          throw new Error("Unable to validate response url");

        var credentialToken = profile.inResponseToId || profile.InResponseTo || samlObject.credentialToken;
        if(!credentialToken)
          throw new Error("Unable to determine credentialToken");

        Accounts.saml._loginResultForCredentialToken[credentialToken] = {
          profile: profile
        };

        closePopup(res);
      });
    }else {
      throw new Error("Unexpected SAML action " + samlObject.actionName);
    }
  } catch (err) {
    closePopup(res, err);
  }
};

var samlUrlToObject = function (url) {
  // req.url will be "/_saml/<action>/<service name>/<credentialToken>"
  if(!url)
    return null;

  var splitPath = url.split('/');

  // Any non-saml request will continue down the default
  // middlewares.
  if (splitPath[1] !== '_saml')
    return null;

  return {
    actionName:splitPath[2],
    serviceName:splitPath[3],
    credentialToken:splitPath[4]
  };
};

var closePopup = function(res, err) {
  res.writeHead(200, {'Content-Type': 'text/html'});
  var content =
        '<html><head><script>window.close()</script></head></html>';
  if(err)
    content = '<html><body><h2>Sorry, an error occured</h2><div>'+err+'</div><a onclick="window.close();">Close Window</a></body></html>';
  res.end(content, 'utf-8');
};