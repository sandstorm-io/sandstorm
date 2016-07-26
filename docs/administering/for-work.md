[Sandstorm for Work](https://sandstorm.io/business) is the name for a collection of features that
are typically used by companies. Customers can buy a _feature key_ to enable these features on a
Sandstorm server running at their own organization. Special pricing, sometimes including free
feature keys, are available to [non-profits and community groups](#special-pricing). For pricing,
please read the information on the [main website](https://sandstorm.io/business).

For now, feature keys are typically 90-day trial keys. This gives you time to evaluate Sandstorm for
Work, and it gives us time to finish testing the payments system.

## Sandstorm for Work in depth

### Authentication provider: LDAP

LDAP is a protocol for storing information of nearly any kind; it is typically used to store data
about people who work at a company, including login credentials.  Sandstorm's LDAP support allows
you to log into Sandstorm with a username and password that is checked against an LDAP store.
Sandstorm's LDAP support is compatible with Microsoft Active Directory, OpenLDAP, and many other
LDAP servers.

To enable LDAP login, take the following steps:

- Log into your Sandstorm server as an administrator.

- Make sure you have enabled [Sandstorm for Work on your server](#enabling-sandstorm-for-work).

- Click **Admin panel** within your Sandstorm server; this should take you to `/admin`.

- Under "Configuration", click on "Identity providers"; this should take you to `/admin/identity`.

- In the Identity providers table, click the "Configure" button in the LDAP row.

- Complete the form and enabled LDAP login.

Implementation notes for LDAP that may apply to your site:

- A typical LDAP configuration (e.g. Active Directory) will use an **Base DN** of
  `ou=People` followed by the LDAP version of your domain name. For `example.com`, this would be
  `ou=People,dc=example,dc=com`.

- When logging in with LDAP, you might run hit this error: `Exception while invoking method 'login'
  SizeLimitExceededError`. In our testing, this seems to occur with LDAP sites where multiple LDAP
  objects match the username. In this case, you probably need to add a custom **LDAP Search
  Filter** under "Additional LDAP filter criteria. Your search filter should typically take the form
  of `(&(something))` so that it is AND'd against the default Sandstorm LDAP query used when a user
  is logging in. Contact us at support@sandstorm.io if you need help.

- Some LDAP servers require authentication before permitting a search. In that case, you will need
  to configure an **Bind user DN** and **Bind user password**, a user and password for the search
  user.

- Typically LDAP servers use the `cn` field to store the name of the person who is successfully
  logging in. `cn` is short for common name. If your LDAP server is configured differently, please
  adjust the **LDAP given name attribute**.

### Authentication provider: SAML 2.0

SAML 2.0 is a passwordless single sign-on protocol. It allows a web application such as Sandstorm to
request the current user's credentials from a central service, typically administered by a
university or corporate IT team. Sandstorm's SAML support is compatible with Shibboleth, Okta,
Microsoft Active Directory, SimpleSAMLphp, and other SAML services.

To enable SAML login on your Sandstorm server, take the following steps:

- Log into your Sandstorm server as an administrator.

- Make sure you have enabled [Sandstorm for Work on your server](#enabling-sandstorm-for-work).

- Click **Admin panel** within your Sandstorm server; this should take you to `/admin`.

- Under "Configuration", click on "Identity providers"; this should take you to `/admin/identity`.

- In the Identity providers table, click the "Configure" button in the SAML row.

- Complete the form and enabled SAML login.

Your SAML IDP should be configured to return a persistent nameID. In addition, if you are not using
Active Directory, you **must** configure your IDP to provide two extra attributes, email and
displayName.

The easiest way to integrate with SAML is if your SAML IDP supports reading the service provider
metadata from a URL. If it does, you can point it to your Sandstorm base URL followed by
`/_saml/config/default`. For example: `https://sandstorm.example.com/_saml/config/default`

The Service URL of this server is displayed in the configuration dialog, and is always your server's
hostname plus `/_saml/validate/default`. For example:
`https://sandstorm.example.com/_saml/validate/default`

## Organization management

For users who are within your organization, Sandstorm for Work can automatically grant them a user
account. This feature can be enabled or disabled per login provider.

- **Google authentication.** All users who use a particular Google Apps domain of your choosing can
  receive user status in Sandstorm.

- **LDAP authentication.** All users who log in via LDAP can automatically receive user status in
  Sandstorm.

- **Passwordless email login.** All users who use a particular email address domain name
  (e.g. @example.com) can receive user status in Sandstorm.

To enable this feature:

- Log in to your server as an administrator.

- Click your name at the top right, then **Admin panel**; this should take you to `/admin`.

- Under the "Configuration" header, click "Organization settings"

- Enable and configure your organization membership on a per-login-provider basis.

This feature is important because, by default, when a user signs into a Sandstorm server for the
first time, Sandstorm creates a _Visitor_ account for them. Visitors can use grains that have been
shared with them but cannot create grains of their own. The setting **Disallow collaboration with
users outside the organization** can disable the ability for users not a part of your organization
to log in.

### Features coming soon

We're still working on the following features:

**Group management.** This will allow you to share a grain with everyone in a group, such as the
marketing department, using groups from Google or LDAP.

**Global access control.** Configure organization-wide access control policies, such as prohibiting
your employees from sharing grains outside of the organization.

**Global audit logging.** Monitor data across the whole organization to keep track of who has
accessed what.

If you're interested in these features, we'd love to hear from you. Please [contact
us](https://sandstorm.io/business)!

### All about feature keys

A feature key is a text file of this format:

```
--------------------- BEGIN SANDSTORM FEATURE KEY ----------------------
AAAAB3NzaC1yc2EAAAADAQABAAABAQC80vEoj2Mgpprswcj5WmWY4KLwU/SWb6UE+FVpHg6+
qwVpCggjJiPYH/WZX7d4tuqXtifx6uuQp1Pm8So86ke3AQODHFmAVgqt19QcWu1LkEFEL1c2
4RhL8gM8lxpzWBn/3eRZ+rdUNSaVJwrXHRetjetwksfyaByQwApSphip2+HGSMxlEqATg5uh
mxR0PzpfIwLxun8rc18j8JZQLHUim1njS8X/p7E3s9/6HeGz
---------------------- END SANDSTORM FEATURE KEY -----------------------
```

It is a text serialization of a [Cap'n Proto](https://capnproto.org/) structure, defined in
[feature-key.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/feature-key.capnp).
Feature keys are signed by an ed25519 signing key.

If you are developing Sandstorm, and you need to enable Sandstorm for Work features, you can get a
testing feature key by contacting Kenton Varda. You must also enable testing mode by setting
`IS_TESTING=yes` in `sandstorm.conf` for testing keys to be considered valid. Note that enabling
testing mode forfeits all security.

To switch back to Sandstorm Standard, you can **remove the feature key from your system.** You can
find this option within the admin settings area. This will disable Sandstorm for Work features. All
your data and user accounts will remain intact, although some users might no longer be able to log
in due to using LDAP or SAML to create their accounts. You can switch between Sandstorm Standard and
Sandstorm for Work at any time, so long as you have a valid feature key and are complying with the
[Sandstorm for Work terms of service](https://work.sandstorm.io/terms).

You are always permitted to **move a feature key between servers,** so long as the feature key is
not in use on multiple servers at once. You can read more in the [Sandstorm for Work Terms of
Service.](https://work.sandstorm.io/terms).

### Open source

The code for Sandstorm for Work is maintained in the Sandstorm open source project, under the Apache
License 2.0. Feel free to read [the code in GitHub](https://github.com/sandstorm-io/sandstorm).

## How to get Sandstorm for Work

### Installing Sandstorm for Work

Sandstorm comes bundled with the code needed to convert it into a Sandstorm for Work installation.

If you don't have Sandstorm yet, follow these steps first.

- [Install Sandstorm](https://sandstorm.io/install) via the usual directions.

- Obtain a feature key from our automated [feature key generator](https://sandstorm.io/get-feature-key).

Now that you have Sandstorm, enable Sandstorm for Work. These steps work properly on any up-to-date
Sandstorm install, even if you installed before Sandstorm for Work was avaiable.

- Log in as an administrator.

- Click on your name at the top right of the page, then click on **Admin panel** to visit `/admin`.

- Click on **Sandstorm for Work** to visit `/admin/feature-key`.

- Click **Choose File** to upload a feature key file. You can alternatively paste a feature key into
  the text area and click Verify.

Once you've done this, you will see information about your feature key on the **Sandstorm for Work**
page. All Sandstorm features enabled by your feature key will be available to you in the most
contextually-relevant location.

### Special pricing

We're grateful for all the work of volunteer-oriented and community groups. For that reason,
charities and small unincorporated community groups can often receive feature keys for free. Please
[contact us via the Sandstorm for Work page](https://sandstorm.io/business) and tell us one to two
sentences about your volunteer or community group. It'll be our honor to help.

Free feature keys don't come with priority support, but they do come with our standard
`support@sandstorm.io` best-effort email support, as well as community support via the sandstorm-dev
Google Group and GitHub issues.
