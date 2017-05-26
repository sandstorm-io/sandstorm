# App Developer Handbook

This document provides a conceptual overview of Sandstorm along with a
style guide for Sandstorm package maintainers.

A great Sandstorm app:

* Provides a personal network service
* Works immediately
* Is granular
* Does _not_ implement user accounts or access control
* Is isolated
* Is maintained in Sandstorm by the community that develops it

This document explains the basic concepts of the Sandstorm platform by
example and introduces the goals of the platform. The purpose is to
enable you, a person interested in making a web application run on
Sandstorm, understand the platform and provide the best experience
possible. Before reading this document, we encourage you try
Sandstorm, perhaps by visiting https://demo.sandstorm.io/.

The platform is always evolving, so this document is likely to
change. We will keep old versions of this document online, and we hope
that you will watch this document over time to update your app as the
platform updates. There will eventually be API deprecations and
backwards-incompatible breakage, though we aim to keep that to a
minimum.

This document serves as a conceptual overview but is not the
authoritative source of technical documentation. Within each section,
we typically link to more detailed documentation. Those detailed
documents provide further context on how stable each API is.

# Change history

* 2015-02-08: Some clarifications, particularly around access control.
* 2015-02-06: Initial version.

# A great Sandstorm app

This section explains each brief bullet-point above in more depth.

## Provides a personal network service

Every Sandstorm app provides a service to the person who creates an
instance of it. It is initially available to the person who started
the instance. It is only available to people with whom the owner can
shared the instance. By focusing on enabling personal computing on the
web, Sandstorm aims to enable people to get creative with small apps
created for a single purpose, with security provided by the platform.

To provide some examples of the kinds of services an app might
provide:

* Some apps create the experience of an online editor for personal
  documents, like spreadsheets or text documents. An example of this
  is EtherCalc, a real-time collaborative spreadsheet.

* Other apps give the user the ability to produce and edit online
  publications, such as blogs, photo galleries, or an informational
  website. An example of this is GNU MediaGoblin, a media gallery
  application.

* An app might help you share data with other programs. For example,
  the GitWeb creates a git repository you can clone from your laptop.

* A user might use a Sandstorm app for personal communication. An
  example is email; right now, there is one email app in the
  Sandstorm app market, Roundcube.

These categories are just examples; there are surely other kinds of
apps that people will dream up.

The Sandstorm paradigm of app instances being primarily used by the
person who created the instance may require rethinking your app. For
example, the administration and editing interface of a blog is a great
Sandstorm app, and the person who creates the instance can share it
with others, allowing multiple people to edit the blog. Meanwhile,
however, the _public_ view of the blog is a completely separate facet
of the application accessed through different means. The public site
may simply be mapped to a domain separate from the Sandstorm shell,
whereas the edit interface is accessed exclusively within the
Sandstorm shell. (See more below on how apps can publish content to
the public web.)

## Works immediately

When the user creates a new instance of an app, the first screen the
user sees should empower the user to start using the software.

To enable this, the platform handles authentication so the app can
automatically log the user in; see below about that.

A great example of an app working immediately is EtherCalc. When you
enter a new instance of EtherCalc, you find yourself staring at the
familiar grid of a spreadsheet. The interface acts as a prompt to can
start entering formulas and data. ([Try it on the
demo](https://demo.sandstorm.io/appdemo/a0n6hwm32zjsrzes8gnjg734dh6jwt7x83xdgytspe761pe2asw0).)

Although we want users of every app to start using the app
immediately, some apps are not as familiar as a spreadsheet. For
those, the app should provide a clear visual hint as to how to start
using it. For example, with the gitweb port, we adjusted the home
screen so it tells you exactly how to start pushing to the repository
it created. ([Try it on the
demo](https://demo.sandstorm.io/appdemo/6va4cjamc21j0znf5h5rrgnv0rpyvh1vaxurkrgknefvj0x63ash).)

A note about service dependencies: many web applications rely on a
separate database, for example. The Sandstorm approach is that each
app package is responsible for making sure the app works, which could
mean embedding these dependencies. This way, users of an app do not
have to think about the complexity of "provisioning a database" or
similar issues, and a compromise of one instance of an app does not
lead to other apps' data stores being compromised.

## Is granular

Users can always create multiple instances of an app; we call these
instances "grains".

Each grain should refer to a discrete collection of data. For example,
one grain should contain one blog, or one spreadsheet, or one photo
album. The grain has a unique URL which contains a grain ID (a random
identifier for the instance) intended to be unguessable.

Choosing the right granularity is an editorial decision made by the
person porting the app.

For a document or spreadsheet editor, the answer is easy: a grain
should contain one document. It could be that for a media gallery
application, the best granularity is a photo album or a collection of
photo albums, rather than one photo itself. For a web-based image
editor, the best granularity might be a single image. As a general
rule of thumb, a grain should usually represent a "unit of sharing" --
the smallest item that a user may want to share independently of other
items. Choosing the finest granularity allows the app author to defer
more access control to Sandstorm's code and its user interface. At the
extreme end, an app can choose to implement no access control at all,
and the data can remain safely behind the grain URL and Sandstorm's
other protections. For example, this is how the EtherCalc port works.

## Does _not_ implement user accounts or access control

When a user visits an instance of an app, the Sandstorm platform adds
a `X-Sandstorm-User-Id` header to the HTTP request. This header
contains a large hex string identifying the user, so that the app can
tell when the same user visits again later.

A second header, `X-Sandstorm-Username`, contains the user's "display
name", suitable for identifying this user to other users (but this
name can change over time). (Eventually, Sandstorm may also offer
other user profile information, like a photo.)

A third header, `X-Sandstorm-Permissions`, specifies the permissions
this user has on the particular app instance, such as "read" or
"write". These permissions are set through the Sandstorm sharing UI,
outside of the app itself, although the app defines what permissions
are available in its package definition.

With these headers in hand, a Sandstorm app can and should avoid
implementing any internal user model. An app should not ask users to
log in and should not implement any notion of ACLs (access control
lists) or other ways of assigning permissions internally.

For apps which were originally developed outside of Sandstorm where
they needed an internal notion of users, the app might already have a
"users" table and lots of code built around this. That's OK! In this
case, under Sandstorm, the app should automatically do whatever
preparatory work is required to log the user in, such as creating a
new row in that table. The app should examine
`X-Sandstorm-Permissions` to detect the "admin" user, who should
receive full control over the data the app creates. You can see an
example of that in the Sandstorm plugin for GNU MediaGoblin. (See the
[source
code](https://github.com/jparyani/mediagoblin/blob/sandstorm-master/mediagoblin/plugins/sandstorm/views.py#L29).)

A Sandstorm user can create a **sharing link** which grants access to
the grain to anyone with the link. For those with a security
background, grain URLs are [capability
URLs](http://www.w3.org/TR/capability-urls/).

A different user can visit the grain if the owner of the grain sends
them a sharing link. If the user is logged in to Sandstorm, the app
will see an `X-Sandstorm-User-Id` that it has not seen before. It
should typically create an account in its user model, whatever that
means for the app, and automatically log the user into that account.

When the sharing link was created, Sandstorm asked the user what
permissions to grant to someone who visits a grain with the link.
Your app needs to make its own decisions about what permission levels exist.
[Read more about how to define permissions](/developing/auth#defining-permissions-and-roles).

A totally logged-out user can also visit a sharing link. They should
be granted the same permission level as a logged-in user with the
same sharing link. In Sandstorm, logging in just means telling the server who
you are. Sharing links should work no matter who you are.

For those with a security background, the app enforces permissions but
does not handle authorization (i.e. deciding which permissions to
grant) nor authentication. As an implementation detail, these headers
are provided by the `sandstorm-http-bridge` tool. Apps can use a Cap'n
Proto interface instead of HTTP and run more efficiently; we will
document that here later.

## Is isolated

A large number of web applications can work properly without
interacting with other instances of the app and without access to the
network.  Some examples are document editors or media organizing
tools. However, many apps do need network access to function.

For outbound network access for now, apps can request various specific
network protocols like HTTP and SMTP using a short-term hack called
`HackSessionContext`. To learn about that, look at its [capnp
file](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/hack-session.capnp). We're
actively working on replacing this, but it will take a few
months. We'll do our best to help you transition a package away from
`HackSessionContext` when the time comes.

For inbound communication, see the discussion below on public API
endpoints.

In the future, we plan to mediate this network access through
"drivers" for each protocol. Rather than providing a raw interface for
underlying protocols like SMTP, we will provide a more abstract
representation that allows apps to get their work done very
simply. The drivers will respect object-capability discipline, which
we hope will make network code easier to write and also make it more
secure. The generic [TCP/IP networking interface
definition](https://github.com/sandstorm-io/sandstorm/blob/5758eeeae1f0e9fd918156687a101339065e4e4d/src/sandstorm/ip.capnp)
will be part of how we implement more drivers.

In the future, when an app wishes to connect to another app or to an
external resource through a driver, the app will make a "powerbox"
request. The app essentially tells the platform: "I need an endpoint
which implements the XYZ API." Sandstorm itself will then display a
dialog to the user which helps them choose which endpoint to use. The
user may choose another one of their apps on the same server, or may
choose to connect to external resources through a driver. Either way,
the requesting app will receive a Cap'n Proto object reference
representing the endpoint, with which they can then communicate. The
platform automatically arranges for the right permissions to be
granted on the endpoint the user chooses, so apps do not need to make
a separate "permission" request.

## Is maintained in Sandstorm by the community that develops it

Over the course of 2014, volunteers and Sandstorm staff ported a
number of existing open source web applications to Sandstorm to test
out the platform, show that it can run a variety of software, and
identify changes we need to make to support a wide range of apps.

In the long run, we believe that the person/people maintaining the
software itself should maintain the Sandstorm port, too. (We sometimes
refer to the software's authors as the "upstream" author of the
Sandstorm port.) If you want to port something to Sandstorm, but
aren't part of the the main project's community yet, it's OK to go
ahead! Do it, and then tell both the upstream community and the
Sandstorm community about your work. You should join up with the
broader community so that the whole community around the project is
interested in the Sandstorm port being successful. We're very happy to
help connect you with the upstream authors.

# Platform features that enable publishing

As you have seen, the core of the Sandstorm platform is about how
people interact with applications they have installed. Many web
applications exist to help people publish content for others, and this
section covers platform features that enable that.

Our goals are:

* Apps should be able to publish content for the world to see.

* Apps should be able to take input from external services on the
  Internet. Two example uses cases are (1) federated publishing
  systems like the Pump protocol used by GNU MediaGoblin and (2) apps
  that respond to external events, like a tool to update software
  documentation based on a GitHub web hook.

* External people visiting this content should not be able to disturb
  the app's functionality for the owner. Three classic ways that
  external visitors disturb app functionality are cross-site request
  forgery attacks, cross-site scripting attacks, and denial of
  service. Sandstorm should enable app authors to rely on the platform
  to protect them from these problems.

* External people visiting this content should preferably not be able
  to disturb the content for other visitors. Two classic ways people
  attempt to do this are denial of service and stored cross-site
  scripting. Sandstorm should enable app authors to rely on the
  platform to protect them from these problems, although there are
  some limitations on how well the platform can protect against these
  problems.

## Apps can publish static HTML to the world

Many web apps exist to help people publish websites that the world can
see. For example, Sandstorm has a number of blogging packages
available.

The key things to know here is that the app should write an HTML tree
to /var/www, and then call "publish static" from the
"HackSessionContext". You can [read more](web-publishing.md).

## Apps can expose an external API for authorized users

Sandstorm apps can export HTTP APIs for consumption by other servers
or client apps, authorized using API keys. These API keys are bound to
a specific user, so when you receive a request via this API, the
platform has populated the `X-Sandstorm-User-Id` and related headers.

You can [read more](http-apis.md).

## Apps can expose an external API for the world

Apps should be able to use external APIs so that non-Sandstorm users
can do dynamic things. For example, the static HTML view of a blog
might need an AJAX comments API. We are thinking through the best way
to support this.

# Platform security philosophy

As a Sandstorm app developer, it is worth understanding the general
security philosophy of the platform. They are:

* A goal of Sandstorm is to allow people to run arbitrarily-vulnerable
  web applications safely.

* A Sandstorm user should be able to use software privately, without
  third parties being able to discover what software the person uses
  or leverage this knowledge to mount an attack.

* An app knows who you are, just like a UNIX program knows the current
  user ID.

* Permission to access a user's data is always explicit, never
  implicit. A compromised app should only be able to read or destroy
  the data it created or that the user explicitly authorized it to
  access.

* Sandstorm favors object capabilities as the unit of
  authorization. You can [read more about object
  capabilities](http://zesty.ca/capmyths/usenix.pdf). We believe that
  discrete object capabilities can improve both security and
  usability.

* Access to the network is always explicit, never implicit. A
  compromised app should not be able to leak the user's data to a
  third party. This will include browser-based protections as well as
  backend protections. Only the administrator of a server will be able
  to grant general network access; general network access exists so to
  enable installing "drivers" to expose particular protocols (like
  outbound email) for use by apps. The driver concept is still in
  development. We hope that it simplifies app development and
  deployment by automating configuration and allowing some security
  decisions to be automatically made by the platform.

* Sandstorm limits apps' access to the Linux platform to protect users
  from malicious or vulnerable apps. For example, we don't support all
  Linux system calls. Legitimate apps don't need all of them, and they
  create a huge attack surface. Through syscall filtering, Sandstorm
  apps have avoided being vulnerable to many [real Linux security
  issues](https://blog.sandstorm.io/news/2014-08-13-sandbox-security.html).

* When apps display information in a browser context, they have to use
  our sandbox. This prevents the app from leaking its private data and
  prevents other sites from attacking the app.

# Platform protocol philosophy

Sandstorm is based on Cap'n Proto, a system for efficiently
transferring data and capabilities between programs. We focus on
designing secure, convenient interfaces between applications first,
and second on building compatibility bridges so that the existing base
of web applications can work.

* We are most excited about "native" Sandstorm applications. These use
  pure Cap'n Proto to speak to Sandstorm, rather than relying on
  text-based protocols like SMTP or HTTP. The advantage of native
  Sandstorm applications is that they can run efficiently, quickly
  take advantage of new platform features, and have native support for
  sharing data with other apps via capabilities.

* We will support apps that know nothing of the Sandstorm-specific
  Cap'n Proto APIs. We call these "legacy" applications. One example
  of a Sandstorm-developed tool for legacy app support is the
  `sandstorm-http-bridge`, which enables apps that speak HTTP to
  communicate with the Sandstorm supervisor. Each "legacy" app ported
  to Sandstorm needs to bundle any legacy support tools inside its app
  package.

# Conclusions: how to learn more and get involved

Thanks for reading this far!

Sandstorm is continuously evolving, and we are continuously developing
it, so some of these details may change. We hope this has been a useful
overview of the platform and helps you understand the platform's
goals. We're always eager for feedback; email us at
community@sandstorm.io. This handbook is very abbreviated; consider
following the links in each section for more detail.

To dig into the design of Sandstorm, read through the [Cap'n Proto
protocols that govern how it
communicates](https://github.com/sandstorm-io/sandstorm/search?l=cap%27n-proto).

As a developer or app packager, we hope Sandstorm lets you build and
share great web-based software. There is lots of great software out
there already, and if you port it to Sandstorm, you'll make it easier
and safer for others to use. See the [5 minute packaging
tutorial](../vagrant-spk/packaging-tutorial.md) for details.

Some existing apps are not a 100% perfect fit for Sandstorm, but a
port could make a huge difference in helping people use it
conveniently and safely. For example, it is OK to disable some
features if the app still would be valuable to Sandstorm users. It's
also OK to create a "monolithic" port if you believe it would be
useful.

Please check out our [Getting Involved
page](https://github.com/sandstorm-io/sandstorm/wiki/Get-Involved), or
send us an email at community@sandstorm.io!
