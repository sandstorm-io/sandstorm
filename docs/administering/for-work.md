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
you to log into Sandstorm with a username and password that is checked against an LDAP store. We
expect Sandstorm's LDAP support to be compatible with Microsoft Active Directory, OpenLDAP, and many
other systems.

To enable either of these login providers, take the following steps:

- Log into your Sandstorm server.

- Make sure you have enabled [Sandstorm for Work on your server](#enabling-sandstorm-for-work).

- Click **Admin Settings** within your Sandstorm server; this should take you to `/admin/settings`.

You should now see a checkbox that allows you to enable LDAP login.

Implementation notes for LDAP that may apply to your site:

- A typical LDAP configuration (e.g. Active Directory) will use an **LDAP Base Search Dn** of
  `ou=People` followed by the LDAP version of your domain name. For `example.com`, this would be
  `ou=People,dc=example,dc=com`.

- When logging in with LDAP, you might run hit this error: `Exception while invoking method 'login'
  SizeLimitExceededError`. In our testing, this seems to occur with LDAP sites where multiple LDAP
  objects match the username. In this case, you probably need to add a custom **LDAP Search
  Filter**. Your search filter should typically take the form of `(&(something))` so that it is
  AND'd against the default Sandstorm LDAP query used when a user is logging in. Contact us at
  support@sandstorm.io if you need help.

- Some LDAP servers require authentication before permitting a search. In that case, you will need
  to configure an **LDAP Search Bind Dn** and **LDAP Search Bind Password**.

- Typically LDAP servers use the `cn` field to store the name of the person who is successfully
  logging in. `cn` is short for common name. If your LDAP server is configured differently, please
  adjust the **LDAP Name Field**.

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

- Click **Admin Settings** within your Sandstorm server; this should take you to `/admin/settings`.

- Scroll to the bottom to find **Define organization**.

- Enable and configure your organization on a per-login-provider basis.

This feature is important because, by default, when a user signs into a Sandstorm server for the
first time, Sandstorm creates a _guest_ account for them. Guest users can see grains that have been
shared with them but cannot create grains of their own.

At the moment, this feature does not actively synchronize status; it checks for organization
membership at the time the user's account is created. Therefore, when a person leaves your
organization, you will need to visit the **Users** tab within admin settings and adjust their
account level.

### Features coming soon

We're still working on the following features:

**SAML login.** SAML is a protocol for exchanging information about access control, typically used
for single sign-on. If you need this feature, please feel free to [request a feature key
today][https://sandstorm.io/business]. SAML support should be compatible with Shibboleth and other
systems.

**Group Management.** This will allow you to share a grain with everyone in a group, such as the
marketing department, using groups from Google or LDAP.

**Global Access Control.** Configure organization-wide access control policies, such as prohibiting
your employees from sharing grains outside of the organization.

**Global Audit Logging.** Monitor data across the whole organization to keep track of who has
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
testing feature key by contacting Kenton Varda. You must also can enable testing mode by setting
`IS_TESTING=yes` in `sandstorm.conf` for testing keys to be considered valid. Note that enabling
testing mode forfeits all security.

### Open source

The code for Sandstorm for Work is maintained in the Sandstorm open source project, under the Apache
License 2.0. Feel free to read [the code in GitHub](https://github.com/sandstorm-io/sandstorm).

## How to get Sandstorm for Work

### Installing Sandstorm for Work

Sandstorm comes bundled with the code needed to convert it into a Sandstorm for Work installation.

If you don't have Sandstorm yet, follow these steps first.

- [Install Sandstorm](https://sandstorm.io/install) via the usual directions.

- Obtain a feature key. At the moment, we send all feature keys by email to you. To request a key,
  visit the [Sandstorm for Work page on our website](https://sandstorm.io/business), click **Contact
  Us**, fill out the form, and mention that you want to unlock Sandstorm for Work.

Now that you have Sandstorm, enable Sandstorm for Work. These steps work properly on any up-to-date
Sandstorm install, even if you installed before Sandstorm for Work was avaiable.

- Log in as an administrator.

- Click on your name, then click on **Admin Settings** to visit `/admin/settings`.

- Click on **For Work** to visit `/admin/features`.

- Click **Choose File** to upload a feature key file. You can alternatively paste a feature key into
  the text area and click Verify.

Once you've done this, you will see information about your feature key on the **For Work** tab. All
Sandstorm features enabled by your feature key will be available to you in the most
contextually-relevant location.

### Special pricing

We're grateful for all the work of non-profits and community groups. For that reason, non-profits,
charities, and small unincorporated community groups can often receive feature keys for free. Please
[contact us via the Sandstorm for Work page](https://sandstorm.io/business) and tell us one to two
sentences about your nonprofit or community group. It'll be our honor to help.

Free feature keys don't come with priority support, but they do come with our standard
`support@sandstorm.io` best-effort email support, as well as community support via the sandstorm-dev
Google Group and GitHub issues.
