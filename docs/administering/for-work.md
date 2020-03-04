Sandstorm offers [a variety of features](https://sandstorm.io/business) intended for use by
organizations (e.g., companies) that make Sandstorm available to their members (e.g., employees).
These features used to be a part of a product called "Sandstorm for Work", but have since been
merged into the standard Sandstorm build, available to everyone.

## Organizational features in depth

### Defining an organization, and its impact on permissions

Many of Sandstorm's organization features depend on a server administrator specifying the group of users
that will be working together using Sandstorm. We call this **organization management.** You can enable
and disable organization-related features via the `/admin/organization` settings area.

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

- **SAML authentication, including Active Directory.** All users who log in via SAML can
  automatically receive user status in Sandstorm. When you use SAML to define the boundary of your
  organization, all users who log in via SAML are considered members of the organization. Sandstorm
  supports logging in via Active Directory via support for SAML 2.0 and provides a [step-by-step
  tutorial.](active-directory.md)

- **LDAP authentication.** All users who log in via LDAP can automatically receive user status in
  Sandstorm. When you use LDAP to define the boundary of your organization, all users who log in via
  LDAP are considered members of the organization.

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

### Authentication provider: SAML 2.0

SAML 2.0 is a passwordless single sign-on protocol. It allows a web application such as Sandstorm to
request the current user's credentials from a central service, typically administered by a
university or corporate IT team. Sandstorm's SAML support is compatible with Shibboleth, Okta,
Microsoft Active Directory, SimpleSAMLphp, and other SAML services. We have special documentation
for [single sign-on with Active Directory.](active-directory.md)

To enable SAML login on your Sandstorm server, take the following steps:

- Log into your Sandstorm server as an administrator.

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

### Authentication provider: LDAP

LDAP is a protocol for storing information of nearly any kind; it is typically used to store data
about people who work at a company, including login credentials.  Sandstorm's LDAP support allows
you to log into Sandstorm with a username and password that is checked against an LDAP store.
Sandstorm's LDAP support is compatible with Microsoft Active Directory, OpenLDAP, and many other
LDAP servers.

To enable LDAP login, take the following steps:

- Log into your Sandstorm server as an administrator.

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
  is logging in.

- Some LDAP servers require authentication before permitting a search. In that case, you will need
  to configure an **Bind user DN** and **Bind user password**, a user and password for the search
  user.

- Typically LDAP servers use the `cn` field to store the name of the person who is successfully
  logging in. `cn` is short for common name. If your LDAP server is configured differently, please
  adjust the **LDAP given name attribute**.

### Whitelabeling

You may customize Sandstorm's appearance to make it appear more like a service of your organization.
For instance, you can:

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
