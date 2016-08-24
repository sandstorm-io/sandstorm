# Tips on running a Sandstorm hosting provider

This documentation explains how to a hosting provider can provide Sandstorm as a service to its
customers.

For a consumer-focused hosting provider, Sandstorm can offer each customer a personal workspace with
collaboration, productivity, and publishing tools.

For a corporation/enterprise/organization-focused hosting provider, Sandstorm can offer each
customer a private productivity suite for their organization, optionally integrating with the
organization's single sign-on via Google For Work, ActiveDirectory, or SAML/LDAP login.

There are three typical forms this can take.

- **One Sandstorm server per customer.** The hosting provider creates a Linux virtual machine for
  each customer, installs Sandstorm, and gives the customer access to that one server. The customer
  enjoys full admin access to their Sandstorm server, including the ability to enable enterprise
  single sign-on by purchasing [Sandstorm for Work](for-work.md); Sandstorm.io shares revenue with
  the hosting provider.

- **Selling accounts on a Sandstorm server.** The hosting provider installs Sandstorm and each
  customer receives an account on this Sandstorm server, giving the customer easy access to all the
  productivity and collaboration apps in the [Sandstorm App Market](https://apps.sandstorm.io/). To
  enforce storage quota limits, the hosting provider requests a feature key and enters into a
  revenue-sharing agreement with Sandstorm.io.

- **Selling accounts on a Sandstorm server, plus auto-scaling.** Sandstorm itself runs on only one
  machine, and if you are serving many thousands of users, then you would need a clustering
  solution. Our [oasis.sandstorm.io](https://oasis.sandstorm.io/) service uses proprietary scaling
  technology that we built for this purpose that is still in beta testing. If you need that
  technology, please email [sales@sandstorm.io](mailto:sales@sandstorm.io).

## One Sandstorm server per customer

In this approach, the hosting provider creates one Linux virtual machine with Sandstorm
pre-installed for each customer.  When the customer enables [for-pay features within
Sandstorm](for-work.md), the hosting provider earns a portion of this revenue. This is the best
approach for enterprise/organization-oriented hosting providers because it allows the customer the
ability to enable enterprise single sign-on and other organization-oriented features as part of
Sandstorm for Work, and allows the hosting provider to earn revenue via Sandstorm for Work
revenue-sharing.

When setting up one Sandstorm server per customer, consider the following tips.

- Use [sandcats.io](sandcats.md) to provide free-of-cost HTTPS and dynamic DNS for your customers.

- Use the [unattended installation features of
  install.sh](../install.md#option-5-integrating-with-configuration-management-systems-like-ansiblepuppet)
  to install Sandstorm when the system boots.

- Enable swap, and give users at least 1 GB of RAM, preferably at least 2 GB of RAM so that your
  users have a good experience.

- Sandstorm works best with an outbound email gateway. Consider providing SMTP service to these
  customers as part of the Sandstorm product. You can provision outbound email via a service like
  Mailgun for free, or you can integrate with your own existing SMTP infrastructure.

- Typical deals with hosting providers include some engineering support from the Sandstorm.io team
  and a per-customer revenue-share deal for each VM that the hosting provider sells. The hosting
  provider can also re-sell [Sandstorm for Work](for-work.md) and earn further revenue via rev-share
  with the Sandstorm.io team.

## Selling accounts on a Sandstorm server

In this approach, the hosting provider maintains one Sandstorm server. Each customer gets an account
on the Sandstorm server. A tool like WHM is used to handle payment and configure storage quota
levels.

This section discusses enforcing disk quota within Sandstorm and showing customizable error
messages, which is **currently in beta.** Please contact sales@sandstorm.io if you need access to
these features. It currently assumes you use SAML for login and store quota information in an LDAP
service. Once enabled, you can access the features via the `/admin/hosting-management` URL on your
Sandstorm server.

**Account lifecycle.** Use a tool like [Web Host
Manager](http://support.hostgator.com/articles/what-is-whm-web-host-manager) to create accounts for
each customer. Configure the account management tool to write user data to LDAP, and create a SAML
login provider. You can use [SimpleSAMLphp](https://simplesamlphp.org/) as a SAML login
provider. Use the [Sandstorm for Work](for-work.md) features to enable SAML login.

**Synchronizing accounts between SAML and LDAP.** Currently, the quota enforcement code assumes that
the user's email address is unique, and that the LDAP user uses the same email address as the SAML
provider provides. The LDAP field name can be configured via `/admin/hosting-management`.

**Quota enforcement and billing prompt.** When the user has run out of disk storage quota, Sandstorm
shows a billing prompt page. In order to enable quota enforcement, you must obtain a "feature key"
from the Sandstorm.io team, which typically comes with a revenue-sharing agreement for a percentage
of the revenue from your hosting service. The billing prompt is a page of your choosing, shown to
the user via an IFRAME within Sandstorm. You should be sure to configure `target=_blank` in your `A
HREF` links so that any links open in a new window. At the moment, Sandstorm only checks the user's
disk quota when the user attempts to launch a grain.

**Single-machine only.** Sandstorm runs on a single server, due to its architecture. Therefore, to
increase the number of users that can be supported by a Sandstorm server, you need to scale up the
amount of RAM the server has. Disk space and CPU can be increased to support more users, but RAM is
the primary bottleneck.

**Customizable pre-installed apps.** By default, every new user on a Sandstorm server has
Rocket.Chat, Etherpad, Davros, and Wekan available. You can customize which apps are available by
default to your users.

**Customizable app market.** By default, Sandstorm servers use the global Sandstorm app marketplace.
If your hosting service has a need to support specific apps for your users that aren't yet on the
global marketplace, you can create a custom app market.

## Selling accounts on a Sandstorm server, plus auto-scaling

A hosting company can provide a consumer-oriented service where each user can have access to the
apps within Sandstorm for a fee. When you find yourself with more than a few hundred users on a
Sandstorm server, you might need the ability to scale your Sandstorm service to run on multiple
machines.

The hosting service run by the Sandstorm.io team at
[oasis.sandstorm.io](https://oasis.sandstorm.io/) uses a scale-out software stack that we wrote for
this purpose. It is currently in beta, but if you are interested in licensing it, you can email us
at sales@sandstorm.io.
