To run Sandstorm, you must assign it a wildcard host, in which it can
generate new hostnames as-needed. For instance, you might set up
Sandstorm to run at `example.com` and assign it the wildcard
`*.example.com`.

Setting up wildcard DNS and especially SSL can be difficult and
costly, which commonly leads to the question: "Why does Sandstorm need
this?" This page seeks to answer the questions.

## It's all about security.

Sandstorm is designed to implement strong sandboxing of apps, such
that users need not worry about the risk that a malicious -- or simply
buggy -- app might interfere with other apps or the rest of the
network. Our goal is for the network admins to be able to say: "As
long as it's on Sandstorm, you can run whatever apps you want, because
we trust Sandstorm to keep things secure."

Using a wildcard host is just one part of [Sandstorm's security
model](https://github.com/sandstorm-io/sandstorm/wiki/Security-Practices-Overview).

## Sandstorm handles this for localhost + sandcats users

Sandstorm runs `local.sandstorm.io` as wildcard domain where all
subdomains point to `127.0.0.1`, the same as `localhost`. This
allows you to run Sandstorm on your own computer; since each
Sandstorm session

For the `sandcats.io` DNS service, each domain is also a wildcard
domain. This allows a self-hosted Sandstorm domain to operate
correctly.

## Frequently-asked questions about wildcards

Here are some common questions about Sandstorm's use of wildcards.

### How does Sandstorm use its wildcard?

Every time you open a grain (an instance of a Sandstorm app), you
begin a new "session" with that grain. Every session is assigned a
unique, cryptographically-random hostname. The session ends shortly
after you close the tab; after that, the hostname is disabled and is
never used again.

Each session -- and thus each hostname -- belongs to a single
user. Using a cookie, Sandstorm ensures that no other user can access
the session's hostname. This cookie is enforced by Sandstorm, not the
app; Sandstorm accomplishes this by acting as a proxy in front of the
app that checks the cookie.

### Why can't Sandstorm map every app under one domain, like `example.com/app-name`?

Due to "same-origin policy" as specified in web standards, it is
impossible to isolate apps hosted within the same "origin",
i.e. hostname. If two tabs or frames are in the same origin, then
Javascript in each is permitted to arbitrarily modify the contents of
the other, including executing arbitrary code. This makes it totally
impossible for these apps to defend themselves from each other even if
they tried. Hence, it is absolutely necessary for every app to be on a
separate host.

### Why can't Sandstorm use one hostname per app, like `app-name.example.com`? Then admins could configure specifically those hosts.

Multiple reasons:

* Sandstorm aims to make app installation a one-click process. If
  every time a new app is installed, the user must edit DNS records
  and issue a new SSL certificate, one of the platform's most valuable
  features is lost.

* Sandstorm does not just isolate apps from each other, but isolates
  individual resources within an app. For example, with Etherpad (a
  document editor), Sandstorm creates a new Etherpad instance in its
  own isolated container for every Etherpad document you create. This
  protects against potential security problems in Etherpad which may
  have allowed a user with access to one document to improperly obtain
  access to other documents -- Etherpad has in fact had several such
  bugs in the last few months, but none of them affected Etherpad on
  Sandstorm.

### Why a new hostname for every session, rather than for every document?

Randomized, unguessable hostnames can help mitigate certain common
security bugs in apps, such as **XSRF**, **reflected XSS**, and
**clickjacking** attacks. All of these attacks involve an attacker
tricking the user's browser into performing actions on another site
using the user's credentials. But for any of these attacks to work,
the attacker must know the address to attack. If every user gets a
different hostname, and indeed the hostnames change frequently, then
it is much harder to launch these kinds of attacks.

Note that because DNS requests are made in cleartext, random hostnames
will not defend against an attacker who has the ability to snoop
network traffic coming from the user's machine. Therefore, apps should
still implement their own defenses against these attacks as they
always have. But, when a bug slips through (as they commonly do),
randomized hostnames make an attack much, much more difficult to pull
off, which is still a big win.

### Can Sandstorm contact the DNS and SSL servers to request creation of each new host on-demand, rather than require a wildcard?

While theoretically possible, Sandstorm would need to do generate a
new hostname every time the user opens a document. This would lead to
undesirably high load on DNS and SSL systems.
