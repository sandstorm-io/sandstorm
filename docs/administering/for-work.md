[Sandstorm for Work](https://sandstorm.io/business) is the name for a collection of features that
are typically used by companies. Customers can buy a _feature key_ to enable these features on a
Sandstorm server running at their own organization. Special pricing, sometimes including free
feature keys, are available to [non-profits and community groups](#special-pricing). For pricing,
please read the information on the [main website](https://sandstorm.io/business). As an
implementation detail, Sandstorm is fully open-source software.

For now, feature keys are typically 60-day trial keys. This gives you time to evaluate Sandstorm for
Work, and it gives us time to finish testing the payments system.

## Sandstorm for Work features

### Authentication providers: LDAP and SAML

LDAP is a protocol for storing information of nearly any kind; it is typically used to store data
about people who work at a company, including login credentials.  Sandstorm's LDAP support allows
you to log into Sandstorm with a username and password that is checked against an LDAP store. We
expect Sandstorm's LDAP support to be compatible with Microsoft Active Directory, OpenLDAP, and many
other systems.

SAML is a protocol for exchanging information about access control. SAML support is coming soon. If
you need this feature, please feel free to [request a feature key
today][https://sandstorm.io/business]. SAML support should be compatible with Shibboleth and other
systems.

To enable either of these login providers, take the following steps:

- Log into your Sandstorm server.

- Make sure you have enabled [Sandstorm for Work on your server](#enabling-sandstorm-for-work).

- Click **Admin Settings** within your Sandstorm server; this should take you to `/admin/settings`.

You should now see a checkbox that allows you to enable LDAP login.

### Features coming soon

We're still working on the following features:

**Organization management.** Choose an LDAP group that, upon login, should automatically be given
_user_ status on this Sandstorm server.

**Group Management.** This will allow you to share a grain with everyone in an LDAP/Active Directory
group, such as the marketing department.

**Global Access Control.** Configure organization-wide access control policies, such as prohibiting
your employees from sharing grains outside of the organization.

**Global Audit Logging.** Monitor data across the whole organization to keep track of who has
accessed what.

If you're interested in these features, we'd love to hear from you. Please [contact
us](https://sandstorm.io/business)!

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

### Special pricing

We're grateful for all the work of non-profits and community groups. For that reason, non-profits,
charities, and small unincorporated community groups can often receive feature keys for free. Please
[contact us via the Sandstorm for Work page](https://sandstorm.io/business) and tell us one to two
sentences about your nonprofit or community group. It'll be our honor to help.
