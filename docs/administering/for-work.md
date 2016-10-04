[Sandstorm for Work](https://sandstorm.io/business) is the name for a collection of features that
are typically used by companies. Customers can buy a _feature key_ to enable these features on a
Sandstorm server running at their own organization. Special pricing, sometimes including free
feature keys, are available to [non-profits and community groups](#special-pricing). For pricing,
please read the information on the [main website](https://sandstorm.io/business).

For now, feature keys are typically 60-day trial keys. This gives you time to evaluate Sandstorm for
Work, and it gives us time to finish testing the payments system.

## Sandstorm for Work in depth

### Defining an organization, and its impact on permissions

Many features of Sandstorm for Work depend on a server administrator specifying the group of users that will
be working together using Sandstorm. We call this **organization management.** You can enable and disable
organization-related features via the `/admin/organization` settings area.

To apply settings to all users within an organization, you must use organization management settings to
configure the boundary of your organization with regard to at least one login provider. Users within the
organization will automatically be able to log in, install apps, and create grains.

To enable this feature:

- Log in to your server as an administrator.

- Click your name at the top right, then **Admin panel**; this should take you to `/admin`.

- Under the "Configuration" header, click "Organization settings"

- Enable and configure your organization membership on a per-login-provider basis.

Login providers have different settings that are used to define your organization. A user is
considered a member of your organization if the settings for **at least one** login provider
declare the user to be a member. You can enable/disable this on a per-login-provider basis.

- **Google authentication.** All users who use a particular Google Apps domain of your choosing can
  receive user status in Sandstorm. When you enable the use of Google Apps to define the boundary
  of your organization, you must specify which Google Apps domain represents your organization.

- **LDAP authentication.** All users who log in via LDAP can automatically receive user status in
  Sandstorm. When you use LDAP to define the boundary of your organization, all users who log in via
  LDAP are considered members of the organization.

- **SAML authentication.** All users who log in via LDAP can automatically receive user status in
  Sandstorm. When you use SAML to define the boundary of your organization, all users who log in via
  SAML are considered members of the organization.

- **Passwordless email login.** All users who use a particular email address domain name
  (e.g. @example.com) can receive user status in Sandstorm. To enable this, you must specify which
  Internet domain name represents your organization.

This feature is important because, by default, when a user signs into a Sandstorm server for the
first time, Sandstorm creates a _Visitor_ account for them. Visitors can use grains that have been
shared with them but cannot create grains of their own.

### Additional organization settings

Once you have defined your organization, you can optionally configure system-wide rules based on
organization membership. This can be done from `/admin/organization` within your Sandstorm server.

You can **disallow collaboration with users outside the organization.** If you enable this option,
grains can only be seen by users logged-in as a member of your organization. This means:

- Unauthenticated (aka anonymous) users cannot view grains, even if they have a sharing link.

- When a user attempts to create an account or sign in, Sandstorm validates that they are part
  of your organization. If not, then they may not create an account or sign in. This prevents
  [Visitors](guide.md) from using their accounts.

- Security note: at the moment, this setting only applies to new logins. If a user was already signed
  in when you first enabled this option, the user would be able to continue to use their account even
  if they're not a member of your organization.

You can **make all organization users visible to each other.** This setting automatically adds
users within the organization to each other's contact list so that they can share grains with each
other. The contact list is used for autocomplete when users are in the "Share access" dialog within
a grain. Disable this if you have some users whose identity should stay hidden from other users.

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

### How we calculate the number of users on your server

Sandstorm for Work's pricing counts monthly **active** users.

For the most flexible billing, choose monthly billing. In this mode, you will be charged each 30 days
according to the number of users who had actually logged in and opened a grain in the last 30 days.

For example, if you use monthly billing, if there are 2000 people who work with you, but only 100
are using Sandstorm, and all 100 use Sandstorm at least once a month, you would pay for 100 users
that month.

Alternatively, you can choose annual billing. Here, you specify a user limit at purchase
time. Sandstorm will not allow more than this many users to log in during any 30-day period.

### Whitelabeling

Sandstorm for Work adds server customization features that allow you to:

- Change the logo used when users sign in

- Hide the "Troubleshooting" button on the login page

- Hide the "Send feedback" link on the login page

- Change the title the server shows to all its users in the top-left

To do that, visit the **Admin settings** area, then click **Personalization** and look for the
**Whitelabeling** options.

These features are in addition to Sandstorm's existing customization options, enabling the
admin to:

- Set a server title

- Set a custom splash URL on home page, as you can see on [Oasis](https://oasis.sandstorm.io).

- Change the message that users see when they receive an invitation to the server.

- Set a URL for a terms of service.

- Set a URL for a privacy policy.

You can read about these features in the [Sandstorm administration
FAQ.](faq.md#can-i-customize-the-root-page-of-my-sandstorm-install)

### Features coming soon

We're still working on the following features:

**Group management.** This will allow you to share a grain with everyone in a group, such as the
marketing department, using groups from Google or LDAP. For now, you can use the
[Collections app](https://sandstorm.io/news/2016-08-09-collections-app) to create groups of grains
that you share with the people who need access.

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

**Billing period and renewal.** The Sandstorm for Work admin page on your own server will show a
renewal/expiration date for your feature key. Under normal operation, your Sandstorm server will
contact our billing server when your feature key expires and bill you at your own rate for your
Sandstorm for Work usage. Once that succeeds, your Sandstorm server will automatically download a
new feature key with an expiration date in the future. For that reason, the "Expires" or "Next
Renewal" date in the Sandstorm for Work admin page on your server will change over time. To account
for the fact that reaching the billing server can take some time, Sandstorm for Work has a small
grace period where an expired key will continue to work. For customers who chose monthly billing,
the new feature key will have a next renewal date one month in the future. For customers who chose
annual billing, the new feature key will have a next renewal date one year in the future. Customers
who use a free-of-cost key are typically use annual billing and the billing rate is $0/year,
allowing renewals to occur automatically.

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
