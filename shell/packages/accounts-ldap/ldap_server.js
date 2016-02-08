Future = Npm.require('fibers/future');

// At a minimum, set up LDAP_DEFAULTS.url and .dn according to
// your needs. url should appear as 'ldap://your.url.here'
// dn should appear in normal ldap format of comma separated attribute=value
// e.g. 'uid=someuser,cn=users,dc=somevalue'
LDAP_DEFAULTS = {
    url: false,
    port: '389',
    dn: false,
    searchDN: false,
    searchCredentials: false,
    createNewUser: true,
    defaultDomain: false,
    searchResultsProfileMap: false,
    base: null,
    search: '(objectclass=*)',
    ldapsCertificate: false
};

/**
 @class LDAP
 @constructor
 */
var LDAP = function (options) {
    // Set options
    this.options = _.defaults(options, LDAP_DEFAULTS);

    // Make sure options have been set
    try {
        check(this.options.url, String);
        //check(this.options.dn, String);
    } catch (e) {
        throw new Meteor.Error('Bad Defaults', 'Options not set. Make sure to set LDAP_DEFAULTS.url and LDAP_DEFAULTS.dn!');
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
LDAP.prototype.ldapCheck = function (options) {

    var self = this;

    options = options || {};

    if (options.hasOwnProperty('username') && options.hasOwnProperty('ldapPass')) {

        var ldapAsyncFut = new Future();


        // Create ldap client
        var fullUrl = self.options.url + ':' + self.options.port;
        var client = null;

        if (self.options.url.indexOf('ldaps://') === 0) {
            client = self.ldapjs.createClient({
                url: fullUrl,
                tlsOptions: {
                    ca: [self.options.ldapsCertificate]
                }
            });
        }
        else {
            client = self.ldapjs.createClient({
                url: fullUrl
            });
        }


        // Slide @xyz.whatever from username if it was passed in
        // and replace it with the domain specified in defaults
        var emailSliceIndex = options.username.indexOf('@');
        var username;
        var domain = self.options.defaultDomain;

        // If user appended email domain, strip it out
        // And use the defaults.defaultDomain if set
        if (emailSliceIndex !== -1) {
            username = options.username.substring(0, emailSliceIndex);
            domain = domain || options.username.substring((emailSliceIndex + 1), options.username.length);
        } else {
            username = options.username;
        }


        // If DN is provided, use it to bind
        if (self.options.dn) {
            // Attempt to bind to ldap server with provided info
            client.bind(self.options.searchDN || self.options.dn, self.options.searchCredentials || options.ldapPass, function (err) {
                try {
                    if (err) {
                        // Bind failure, return error
                        throw new Meteor.Error(err.code, err.message);
                    }

                    var handleSearchProfile = function (retObject, bindAfterSearch) {
                        retObject.emptySearch = true;

                        // construct list of ldap attributes to fetch
                        var attributes = [];
                        if (self.options.searchResultsProfileMap) {
                            self.options.searchResultsProfileMap.map(function (item) {
                                attributes.push(item.resultKey);
                            });
                        }

                        // use base if given, else the dn for the ldap search
                        var searchBase = self.options.base || self.options.dn;
                        var searchOptions = {
                            scope: 'sub',
                            sizeLimit: 1,
                            attributes: attributes,
                            filter: self.options.search
                        };

                        client.search(searchBase, searchOptions, function (err, res) {
                            if (err) {
                                ldapAsyncFut.return({
                                    error: err
                                });
                            }

                            res.on('searchEntry', function (entry) {
                                retObject.emptySearch = false;
                                // Add entry results to return object
                                retObject.searchResults = entry.object;
                                if (bindAfterSearch) {
                                    client.bind(retObject.searchResults.dn, options.ldapPass, function (err) {
                                        try {
                                            if (err) {
                                                throw new Meteor.Error(err.code, err.message);
                                            }
                                            ldapAsyncFut.return(retObject);
                                        } catch (e) {
                                            ldapAsyncFut.return({
                                                error: e
                                            });
                                        }
                                    })
                                } else ldapAsyncFut.return(retObject);
                            });

                            res.on('end', function () {
                                ldapAsyncFut.return(retObject);
                            });

                        });
                    };

                    var retObject = {
                        username: username,
                        searchResults: null,
                        email: domain ? username + '@' + domain : false
                    };

                    if (self.options.searchDN) {
                        handleSearchProfile(retObject, true);
                    } else if (self.options.searchResultsProfileMap) {
                        handleSearchProfile(retObject, false);
                    } else {
                        ldapAsyncFut.return(retObject);
                    }

                } catch (e) {
                    ldapAsyncFut.return({
                        error: e
                    });
                }
            });
        }
        // DN not provided, search for DN and use result to bind
        else if (typeof self.options.searchBeforeBind !== undefined) {
            // initialize result
            var retObject = {
                username: username,
                email: domain ? username + '@' + domain : false,
                emptySearch: true,
                searchResults: {}
            };

            // compile attribute list to return
            var searchAttributes = ['dn'];
            self.options.searchResultsProfileMap.map(function (item) {
                searchAttributes.push(item.resultKey);
            });


            var filter = self.options.search;
            Object.keys(options.ldapOptions.searchBeforeBind).forEach(function (searchKey) {
                filter = '&' + filter + '(' + searchKey + '=' + options.ldapOptions.searchBeforeBind[searchKey] + ')';
            });
            var searchOptions = {
                scope: 'sub',
                sizeLimit: 1,
                filter: filter
            };

            // perform LDAP search to determine DN
            client.search(self.options.base, searchOptions, function (err, res) {
                retObject.emptySearch = true;
                res.on('searchEntry', function (entry) {
                    retObject.dn = entry.objectName;
                    retObject.username = retObject.dn;
                    retObject.emptySearch = false;

                    // Return search results if specified
                    if (self.options.searchResultsProfileMap) {
                        // construct list of ldap attributes to fetch
                        self.options.searchResultsProfileMap.map(function (item) {
                            retObject.searchResults[item.resultKey] = entry.object[item.resultKey];
                        });
                    }

                    // use the determined DN to bind
                    client.bind(entry.objectName, options.ldapPass, function (err) {
                        try {
                            if (err) {
                                throw new Meteor.Error(err.code, err.message);
                            }
                            else {
                                ldapAsyncFut.return(retObject);
                            }
                        }
                        catch (e) {
                            ldapAsyncFut.return({
                                error: e
                            });
                        }
                    });
                });
                // If no dn is found, return as is.
                res.on('end', function (result) {
                    if (retObject.dn === undefined) {
                        ldapAsyncFut.return(retObject);
                    }
                });
            });
        }

        return ldapAsyncFut.wait();

    } else {
        throw new Meteor.Error(403, 'Missing LDAP Auth Parameter');
    }

};


// Register login handler with Meteor
// Here we create a new LDAP instance with options passed from
// Meteor.loginWithLDAP on client side
// @param {Object} loginRequest will consist of username, ldapPass, ldap, and ldapOptions
Accounts.registerLoginHandler('ldap', function (loginRequest) {
    // If 'ldap' isn't set in loginRequest object,
    // then this isn't the proper handler (return undefined)
    if (!loginRequest.ldap) {
        return undefined;
    }

    // Instantiate LDAP with options
    var userOptions = loginRequest.ldapOptions || {};
    var ldapObj = new LDAP(userOptions);

    // Call ldapCheck and get response
    var ldapResponse = ldapObj.ldapCheck(loginRequest);

    if (ldapResponse.error) {
        return {
            userId: null,
            error: ldapResponse.error
        };
    }
    else if (ldapResponse.emptySearch) {
        return {
            userId: null,
            error: new Meteor.Error(403, 'User not found in LDAP')
        };
    }
    else {
        // Set initial userId and token vals
        var userId = null;
        var stampedToken = {
            token: null
        };

        // Look to see if user already exists
        var user = Meteor.users.findOne({
            username: ldapResponse.username
        });

        // Login user if they exist
        if (user) {
            userId = user._id;

            // Create hashed token so user stays logged in
            stampedToken = Accounts._generateStampedLoginToken();
            var hashStampedToken = Accounts._hashStampedToken(stampedToken);
            // Update the user's token in mongo
            Meteor.users.update(userId, {
                $push: {
                    'services.resume.loginTokens': hashStampedToken
                }
            });
        }
        // Otherwise create user if option is set
        else if (ldapObj.options.createNewUser) {
            var userObject = {
                username: ldapResponse.username
            };
            // Set email
            if (ldapResponse.email) userObject.email = ldapResponse.email;

            // Set profile values if specified in searchResultsProfileMap
            if (ldapResponse.searchResults && ldapObj.options.searchResultsProfileMap.length > 0) {

                var profileMap = ldapObj.options.searchResultsProfileMap;
                var profileObject = {};

                // Loop through profileMap and set values on profile object
                for (var i = 0; i < profileMap.length; i++) {
                    var resultKey = profileMap[i].resultKey;

                    // If our search results have the specified property, set the profile property to its value
                    if (ldapResponse.searchResults.hasOwnProperty(resultKey)) {
                        profileObject[profileMap[i].profileProperty] = ldapResponse.searchResults[resultKey];
                    }

                }
                // Set userObject profile
                userObject.profile = profileObject;
            }


            userId = Accounts.createUser(userObject);
        } else {
            // Ldap success, but no user created
            console.log('LDAP Authentication succeeded for ' + ldapResponse.username + ', but no user exists in Meteor. Either create the user manually or set LDAP_DEFAULTS.createNewUser to true');
            return {
                userId: null,
                error: new Meteor.Error(403, 'User found in LDAP but not in application')
            };
        }

        return {
            userId: userId,
            token: stampedToken.token
        };
    }

});
