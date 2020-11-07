Oidc = {};

OAuth.registerService('oidc', 2, null, function (query) {

  var debug = false;
  var token = getToken(query);
  if (debug) console.log('XXX: register token:', token);

  var accessToken = token.access_token || token.id_token;
  var expiresAt = (+new Date) + (1000 * parseInt(token.expires_in, 10));

  var userinfo = getUserInfo(accessToken, expiresAt);
  if (debug) console.log('XXX: userinfo:', userinfo);

  var serviceData = {};
  serviceData.id = userinfo.id;
  serviceData.username = userinfo.username;
  serviceData.accessToken = userinfo.accessToken;
  serviceData.expiresAt = userinfo.expiresAt;
  serviceData.email = userinfo.email;

  if (accessToken) {
    var tokenContent = getTokenContent(accessToken);
    var fields = _.pick(tokenContent, getConfiguration().idTokenWhitelistFields);
    _.extend(serviceData, fields);
  }

  if (token.refresh_token)
    serviceData.refreshToken = token.refresh_token;
  if (debug) console.log('XXX: serviceData:', serviceData);

  var profile = {};
  profile.name = userinfo.name;
  profile.email = userinfo.email;
  if (debug) console.log('XXX: profile:', profile);

  return {
    serviceData: serviceData,
    options: { profile: profile }
  };
});

var userAgent = "Meteor";
if (Meteor.release) {
  userAgent += "/" + Meteor.release;
}

var getToken = function (query) {
  var debug = false;
  var config = getConfiguration();
  var serverTokenEndpoint = config.serverUrl + config.tokenEndpoint;
  var response;

  try {
    response = HTTP.post(
      serverTokenEndpoint,
      {
        headers: {
          Accept: 'application/json',
          "User-Agent": userAgent
        },
        params: {
          code: query.code,
          client_id: config.clientId,
          client_secret: OAuth.openSecret(config.secret),
          redirect_uri: OAuth._redirectUri('oidc', config),
          grant_type: 'authorization_code',
          state: query.state
        }
      }
    );
  } catch (err) {
    throw _.extend(new Error("Failed to get token from OIDC " + serverTokenEndpoint + ": " + err.message),
      { response: err.response });
  }
  if (response.data.error) {
    // if the http response was a json object with an error attribute
    throw new Error("Failed to complete handshake with OIDC " + serverTokenEndpoint + ": " + response.data.error);
  } else {
    if (debug) console.log('XXX: getToken response: ', response.data);
    return response.data;
  }
};

var getUserInfo = function (accessToken, expiresAt) {
  var config = getConfiguration();

  if (config.userinfoEndpoint) {
    return getUserInfoFromEndpoint(accessToken, config, expiresAt);
  }
  else {
    return getUserInfoFromToken(accessToken);
  }
};

var getConfiguration = function () {
  var config = ServiceConfiguration.configurations.findOne({ service: 'oidc' });
  if (!config) {
    throw new ServiceConfiguration.ConfigError('Service oidc not configured.');
  }
  return config;
};

var getTokenContent = function (token) {
  var content = null;
  if (token) {
    try {
      var parts = token.split('.');
      var header = JSON.parse(new Buffer(parts[0], 'base64').toString());
      content = JSON.parse(new Buffer(parts[1], 'base64').toString());
      var signature = new Buffer(parts[2], 'base64');
      var signed = parts[0] + '.' + parts[1];
    } catch (err) {
      this.content = {
        exp: 0
      };
    }
  }
  return content;
}

Oidc.retrieveCredential = function (credentialToken, credentialSecret) {
  return OAuth.retrieveCredential(credentialToken, credentialSecret);
};

var getUserInfoFromEndpoint = function (accessToken, config, expiresAt) {
  var debug = false;

  var serverUserinfoEndpoint = config.serverUrl + config.userinfoEndpoint;
  var response;
  try {
    response = HTTP.get(serverUserinfoEndpoint, {
      headers: {
        "User-Agent": userAgent,
        "Authorization": "Bearer " + accessToken
      }
    });
  }
  catch (err) {
    throw _.extend(new Error("Failed to fetch userinfo from OIDC " + serverUserinfoEndpoint + ": " + err.message), { response: err.response });
  }
  if (debug)
    console.log('XXX: getUserInfo response: ', response.data);

  var userinfo = response.data;
  return {
    id: userinfo.id || userinfo.sub,
    username: userinfo.username || userinfo.preferred_username,
    accessToken: OAuth.sealSecret(accessToken),
    expiresAt: expiresAt,
    email: userinfo.email,
    name: userinfo.name
  };
}

var getUserInfoFromToken = function (accessToken) {
  var tokenContent = getTokenContent(accessToken);
  var mainEmail = tokenContent.email || tokenContent.emails[0];

  return {
    id: tokenContent.sub,
    username: tokenContent.username || tokenContent.preferred_username || mainEmail,
    accessToken: OAuth.sealSecret(accessToken),
    expiresAt: tokenContent.exp,
    email: mainEmail,
    name: tokenContent.name
  }
}
