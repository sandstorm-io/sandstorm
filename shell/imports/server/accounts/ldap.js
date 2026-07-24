import { AndFilter, Client, EqualityFilter, FilterParser } from "ldapts";

import { Meteor } from "meteor/meteor";
import { omit } from "/imports/shared/collection-utils";

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
  this.options = { ...LDAP_DEFAULTS };
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

    const tlsOptions = {};
    if (ldapCaCert) {
      tlsOptions.ca = ldapCaCert;
    }

    const client = new Client({
      url: ldapUrl,
      ...(ldapUrl.startsWith("ldaps://") ? { tlsOptions } : {}),
    });

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

    const retObject = {
      username: username,
      email: domain ? username + "@" + domain : false,
      emptySearch: true,
      searchResults: {},
    };

    try {
      if (_this.options.searchBindDn) {
        await client.bind(_this.options.searchBindDn, _this.options.searchBindPassword);
      }

      const filters = [FilterParser.parseString(_this.options.filter)];
      Object.entries(_this.options.searchBeforeBind).forEach(([searchKey, value]) => {
        filters.push(new EqualityFilter({ attribute: searchKey, value }));
      });

      const { searchEntries } = await client.search(_this.options.base, {
        scope: "sub",
        sizeLimit: 1,
        filter: new AndFilter({ filters }),
      });
      const entry = searchEntries[0];
      if (!entry) return retObject;

      retObject.dn = entry.dn;
      retObject.username = entry.dn;
      retObject.emptySearch = false;
      retObject.searchResults = omit(entry, "dn", "userPassword");

      if (!hasOwnProperty(options, "searchUsername")) {
        try {
          await client.bind(entry.dn, options.ldapPass);
        } catch (err) {
          return { error: new Meteor.Error(err.code, err.message) };
        }
      }

      return retObject;
    } catch (err) {
      return { error: err };
    } finally {
      await client.unbind().catch(() => {});
    }

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
