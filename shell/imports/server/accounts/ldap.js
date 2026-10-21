import ldapjs from "ldapjs";

import { Meteor } from "meteor/meteor";
import { _ } from "meteor/underscore";

// At a minimum, set up LDAP_DEFAULTS.url and .dn according to
// your needs. url should appear as 'ldap://your.url.here'
// dn should appear in normal ldap format of comma separated attribute=value
// e.g. 'uid=someuser,cn=users,dc=somevalue'
const LDAP_DEFAULTS = {
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
function LDAP() {
  // Set options
  this.options = _.clone(LDAP_DEFAULTS);
}

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
LDAP.prototype.ldapCheck = async function (db, options) {

  let _this = this;

  options = options || {};

  let hasOwnProperty = Object.prototype.hasOwnProperty;
  hasOwnProperty = hasOwnProperty.call.bind(hasOwnProperty);

  if ((hasOwnProperty(options, "username") && hasOwnProperty(options, "ldapPass")) ||
      hasOwnProperty(options, "searchUsername")) {
    const [ldapBase, ldapUrl, ldapSearchUsername, ldapFilter, ldapSearchBindDn, ldapSearchBindPassword,
      ldapCaCert] = await Promise.all([
      db.getLdapBase(),
      db.getLdapUrl(),
      db.getLdapSearchUsername(),
      db.getLdapFilter(),
      db.getLdapSearchBindDn(),
      db.getLdapSearchBindPassword(),
      db.getLdapCaCert(),
    ]);

    _this.options.base = ldapBase;
    _this.options.url = ldapUrl;
    _this.options.searchBeforeBind = {};
    _this.options.searchBeforeBind[options.searchUsernameField || ldapSearchUsername] = options.searchUsername ||
      options.username;
    _this.options.filter = ldapFilter || "(objectclass=*)";
    _this.options.searchBindDn = ldapSearchBindDn;
    _this.options.searchBindPassword = ldapSearchBindPassword;

    let resolved = false;

    // Create ldap client
    let fullUrl = ldapUrl;
    let client = null;

    let resolveLdapAsync = () => {};
    let errorFunc = function (err) {
      if (err) {
        if (resolved) return;
        resolved = true;
        resolveLdapAsync({
          error: err,
        });
      }
    };

    if (fullUrl.indexOf("ldaps://") === 0) {
      const tlsOptions = {};
      const cert = ldapCaCert;
      if (cert) {
        tlsOptions.ca = cert;
      }

      client = ldapjs.createClient({
        url: fullUrl,
        tlsOptions: tlsOptions,
      }, errorFunc);
    } else {
      client = ldapjs.createClient({
        url: fullUrl,
      }, errorFunc);
    }

    client.on("error", errorFunc);

    let username = options.username;
    let domain = _this.options.defaultDomain;

    if (!hasOwnProperty(options, "searchUsername")) {
      // Slide @xyz.whatever from username if it was passed in
      // and replace it with the domain specified in defaults
      let emailSliceIndex = options.username.indexOf("@");

      // If user appended email domain, strip it out
      // And use the defaults.defaultDomain if set
      if (emailSliceIndex !== -1) {
        username = options.username.substring(0, emailSliceIndex);
        domain = domain || options.username.substring((emailSliceIndex + 1), options.username.length);
      } else {
        username = options.username;
      }
    }

    if (_this.options.searchBindDn) {
      try {
        await new Promise((resolve, reject) => {
          client.bind(_this.options.searchBindDn, _this.options.searchBindPassword, (err) => {
            if (err) {
              reject(err);
            } else {
              resolve();
            }
          });
        });
      } catch (err) {
        return { error: err };
      }
    }
    // initialize result
    let retObject = {
      username: username,
      email: domain ? username + "@" + domain : false,
      emptySearch: true,
      searchResults: {},
    };

    let filter = _this.options.filter;
    Object.keys(_this.options.searchBeforeBind).forEach(function (searchKey) {
      filter = "&" + filter + "(" + searchKey + "=" + _this.options.searchBeforeBind[searchKey] + ")";
    });

    let searchOptions = {
      scope: "sub",
      sizeLimit: 1,
      filter: filter,
    };

    const ldapAsyncPromise = new Promise((resolve) => {
      resolveLdapAsync = resolve;
      // perform LDAP search to determine DN
      client.search(_this.options.base, searchOptions, function (err, res) {
        if (err) {
          if (resolved) return;
          resolved = true;
          resolve({
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

          if (hasOwnProperty(options, "searchUsername")) {
            // This was only a search, return immediately
            resolved = true;
            resolve(retObject);
            return;
          }

          // use the determined DN to bind
          client.bind(entry.objectName, options.ldapPass, function (err) {
            try {
              if (err) {
                throw new Meteor.Error(err.code, err.message);
              } else {
                resolved = true;
                resolve(retObject);
              }
            } catch (e) {
              if (resolved) return;
              resolved = true;
              resolve({
                error: e,
              });
            }
          });
        });

        res.on("error", errorFunc);

        // If no dn is found, return as is.
        res.on("end", function () {
          if (retObject.dn === undefined) {
            resolved = true;
            resolve(retObject);
          }
        });
      });
    });

    return await ldapAsyncPromise;

  } else {
    throw new Meteor.Error(403, "Missing LDAP Auth Parameter");
  }

};

LDAP.prototype.updateUserQuota = async function (db, user) {
  const fallback = {
    storage: user.cachedStorageQuota || 0,
    grains: Infinity,
    compute: Infinity,
  };

  const setting = await db.collections.settings.findOneAsync({ _id: "quotaLdapAttribute" });
  if (!setting || !setting.value) return fallback;

  // TODO(someday): don't just assume the first login identity is the primary identity?
  const email = await db.getPrimaryEmail(user._id, user.loginCredentials[0].id);
  if (!email) return fallback;

  let ldapUser;
  try {
    ldapUser = await this.ldapCheck(db, { searchUsername: email, searchUsernameField: "mail", });
  } catch (err) {
    console.error("Error looking up quota from LDAP:", err);
    return fallback;
  }

  if (!ldapUser || ldapUser.error || !ldapUser.searchResults) return fallback;

  const newStorageQuota = +ldapUser.searchResults[setting.value];
  if (Number.isNaN(newStorageQuota)) return fallback;

  if (newStorageQuota !== user.cachedStorageQuota) {
    await Meteor.users.updateAsync({ _id: user._id }, { $set: { cachedStorageQuota: newStorageQuota } });
  }

  // TODO(someday): cache timestamp as well and only check/update if greater than 60s ago
  return {
    storage: newStorageQuota,
    grains: Infinity,
    compute: Infinity,
  };
};

export { LDAP };
