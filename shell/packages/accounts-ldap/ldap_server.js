Future = Npm.require("fibers/future");

// At a minimum, set up LDAP_DEFAULTS.url and .dn according to
// your needs. url should appear as 'ldap://your.url.here'
// dn should appear in normal ldap format of comma separated attribute=value
// e.g. 'uid=someuser,cn=users,dc=somevalue'
LDAP_DEFAULTS = {
  url: false,
  port: "389",
  dn: false,
  searchDN: false,
  searchCredentials: false,
  createNewUser: true,
  defaultDomain: false,
  searchResultsProfileMap: false,
  base: null,
  search: "(objectclass=*)",
  ldapsCertificate: false,
};

/**
 @class LDAP
 @constructor
 */
let LDAP = function (options) {
  // Set options
  this.options = _.clone(LDAP_DEFAULTS);

  // Make sure options have been set
  try {
    check(this.options.url, String);
    //check(this.options.dn, String);
  } catch (e) {
    throw new Meteor.Error("Bad Defaults", "Options not set. Make sure to set LDAP_DEFAULTS.url and LDAP_DEFAULTS.dn!");
  }

  // Because NPM ldapjs module has some binary builds,
  // We had to create a wraper package for it and build for
  // certain architectures. The package typ:ldap-js exports
  // 'MeteorWrapperLdapjs' which is a wrapper for the npm module
  this.ldapjs = MeteorWrapperLdapjs;
};

/**
 * Attempt to bind (authenticate) ldap
 * and perform a dn search if specified
 *
 * @method ldapCheck
 *
 * @param {Object} options  Object with username, ldapPass and overrides for LDAP_DEFAULTS object.
 * Additionally the searchBeforeBind parameter can be specified, which is used to search for the DN
 * if not provided.
 */
LDAP.prototype.ldapCheck = function (db, options) {

  let _this = this;

  options = options || {};

  if (options.hasOwnProperty("username") && options.hasOwnProperty("ldapPass")) {
    _this.options.base = db.getLdapBase();
    _this.options.dn = db.getLdapDnPattern().replace("$USERNAME", options.username);
    _this.options.searchBeforeBind = {
      uid: options.username,
    };

    let resolved = false;
    let ldapAsyncFut = new Future();

    // Create ldap client
    let fullUrl = _this.options.url + ":" + _this.options.port;
    let client = null;

    let errorFunc = function (err) {
      if (err) {
        if (resolved) return;
        resolved = true;
        ldapAsyncFut.return({
          error: err,
        });
      }
    };

    if (_this.options.url.indexOf("ldaps://") === 0) {
      client = _this.ldapjs.createClient({
        url: fullUrl,
        tlsOptions: {
          ca: [_this.options.ldapsCertificate],
        },
      }, errorFunc);
    } else {
      client = _this.ldapjs.createClient({
        url: fullUrl,
      }, errorFunc);
    }

    client.on("error", errorFunc);

    // Slide @xyz.whatever from username if it was passed in
    // and replace it with the domain specified in defaults
    let emailSliceIndex = options.username.indexOf("@");
    let username;
    let domain = _this.options.defaultDomain;

    // If user appended email domain, strip it out
    // And use the defaults.defaultDomain if set
    if (emailSliceIndex !== -1) {
      username = options.username.substring(0, emailSliceIndex);
      domain = domain || options.username.substring((emailSliceIndex + 1), options.username.length);
    } else {
      username = options.username;
    }

    // If DN is provided, use it to bind
    if (!_this.options.base) {
      // Attempt to bind to ldap server with provided info
      client.bind(_this.options.searchDN || _this.options.dn, _this.options.searchCredentials ||
          options.ldapPass,
          function (err) {
        try {
          if (err) {
            // Bind failure, return error
            throw new Meteor.Error(err.code, err.message);
          }

          let handleSearchProfile = function (retObject, bindAfterSearch) {
            retObject.emptySearch = true;

            // use dn if given, else use the base for the ldap search
            let searchBase = _this.options.dn || _this.options.base;
            let searchOptions = {
              scope: "sub",
              sizeLimit: 1,
              filter: _this.options.search,
            };

            client.search(searchBase, searchOptions, function (err, res) {
              if (err) {
                if (resolved) return;
                resolved = true;
                ldapAsyncFut.return({
                  error: err,
                });
                return;
              }

              let found = false;
              res.on("searchEntry", function (entry) {
                found = true;
                retObject.emptySearch = false;
                // Add entry results to return object
                retObject.searchResults = _.omit(entry.object, "userPassword");

                if (bindAfterSearch) {
                  client.bind(retObject.searchResults.dn, options.ldapPass, function (err) {
                    try {
                      if (err) {
                        throw new Meteor.Error(err.code, err.message);
                      }

                      resolved = true;
                      ldapAsyncFut.return(retObject);
                    } catch (e) {
                      resolved = true;
                      ldapAsyncFut.return({
                        error: e,
                      });
                    }
                  });
                } else {
                  resolved = true;
                  ldapAsyncFut.return(retObject);
                }
              });

              res.on("error", errorFunc);

              res.on("end", function () {
                if (!found) {
                  resolved = true;
                  ldapAsyncFut.return({
                    error: new Meteor.Error(500, "No user found"),
                  });
                }
              });

            });
          };

          let retObject = {
            username: username,
            searchResults: null,
            email: domain ? username + "@" + domain : false,
            dn: _this.options.dn,
          };

          if (_this.options.searchDN) {
            handleSearchProfile(retObject, true);
          } else {
            handleSearchProfile(retObject, false);
          }
        } catch (e) {
          if (resolved) return;
          resolved = true;
          ldapAsyncFut.return({
            error: e,
          });
        }
      });
    }
    // DN not provided, search for DN and use result to bind
    else {
      // initialize result
      let retObject = {
        username: username,
        email: domain ? username + "@" + domain : false,
        emptySearch: true,
        searchResults: {},
      };

      let filter = _this.options.search;
      Object.keys(_this.options.searchBeforeBind).forEach(function (searchKey) {
        filter = "&" + filter + "(" + searchKey + "=" + _this.options.searchBeforeBind[searchKey] + ")";
      });

      let searchOptions = {
        scope: "sub",
        sizeLimit: 1,
        filter: filter,
      };

      // perform LDAP search to determine DN
      client.search(_this.options.base, searchOptions, function (err, res) {
        if (err) {
          if (resolved) return;
          resolved = true;
          ldapAsyncFut.return({
            error: err,
          });
          return;
        }

        retObject.emptySearch = true;
        res.on("searchEntry", function (entry) {
          retObject.dn = entry.objectName;
          retObject.username = retObject.dn;
          retObject.emptySearch = false;

          retObject.searchResults = _.omit(entry.object, "userPassword");

          // use the determined DN to bind
          client.bind(entry.objectName, options.ldapPass, function (err) {
            try {
              if (err) {
                throw new Meteor.Error(err.code, err.message);
              }              else {
                resolved = true;
                ldapAsyncFut.return(retObject);
              }
            }
            catch (e) {
              if (resolved) return;
              resolved = true;
              ldapAsyncFut.return({
                error: e,
              });
            }
          });
        });

        res.on("error", errorFunc);

        // If no dn is found, return as is.
        res.on("end", function (result) {
          if (retObject.dn === undefined) {
            resolved = true;
            ldapAsyncFut.return(retObject);
          }
        });
      });
    }

    return ldapAsyncFut.wait();

  } else {
    throw new Meteor.Error(403, "Missing LDAP Auth Parameter");
  }

};

// Register login handler with Meteor
// Here we create a new LDAP instance with options passed from
// Meteor.loginWithLDAP on client side
// @param {Object} loginRequest will consist of username, ldapPass, ldap, and ldapOptions
Accounts.registerLoginHandler("ldap", function (loginRequest) {
  // If 'ldap' isn't set in loginRequest object,
  // then this isn't the proper handler (return undefined)
  if (!loginRequest.ldap) {
    return undefined;
  }

  if (!Accounts.identityServices.ldap.isEnabled()) {
    throw new Meteor.Error(403, "LDAP service is disabled.");
  }

  // Instantiate LDAP with options
  let userOptions = loginRequest.ldapOptions || {};
  let ldapObj = new LDAP(userOptions);

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
      { id: ldapResponse.dn, rawAttrs: ldapResponse.searchResults }, {});
  }

});
