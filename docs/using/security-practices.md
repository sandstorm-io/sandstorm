**Sandstorm is a security product.**

We like to say that Sandstorm's priorities are Usability, Security,
and Freedom. In public, we tend to talk more about usability and
freedom, because those are the priorities users are most excited
about. However, within the team, we are just as passionate -- if not
more so -- about security.

Ultimately, our goal is that, to the maximum extent possible, users
need not worry about security, because using the system intuitively
will result in the desired security properties "by default". Moreover,
we aim to allow network administrators to be able to say: "As long as
it's on Sandstorm, you can run whatever apps you want, because we
trust Sandstorm to keep things secure."

## Threat models

Sandstorm defends against a wide variety of threats; too many to list
here. However, as a platform for apps, most of our energy goes into
the following:

### Mitigation of app bugs

Sandstorm's most important security goal is to ensure that security
bugs in applications are contained and mitigated to the maximum extent
possible. For example:

* A buggy app should not allow an attacker to compromise the rest of the system or network.
* A buggy app should not be able to grant attackers access even to itself.
* A buggy app should not be able to expose private data to the internet.

Obviously, Sandstorm cannot defend against every possible app bug,
especially when apps need access to sensitive resources in order to
function. However, security is about risk management, and there is
much that Sandstorm can and does do to greatly reduce the user's or
the network admin's overall risk.

### Defense against malicious apps

Sandstorm does not just aim to defend against buggy apps, but also
actively malicious apps. It is our goal that a user should be able to
install and run arbitrary applications from arbitrary authors without
serious consequence. This is important because Sandstorm is aimed at
allowing non-technical users to administer their own
server. Inevitably, such users will install malware.

Again, obviously, Sandstorm cannot prevent an app from misusing
permissions that a user has explicitly granted to it. But, making an
app explicitly request such permissions makes it much easier for users
to understand what is happening and defend themselves.

### Defense against surveillance and profiling

In the world of Software-as-a-Service, it is common practice for web
apps to collect information about individual users, commonly for the
purpose of building advertising profiles. We at Sandstorm feel that
any such collection is only ethical with the user's full knowledge and
consent. Unfortunately, in practice, profiling usually happens behind
the user's back.

Sandstorm aims to prevent apps from engaging in covert surveillance
while allowing statistics gathering when the user consents to it.

## Case Studies

By our analysis, Sandstorm automatically protected users from over 95% of the publicly disclosed
security vulnerabilities discovered in apps on the Sandstorm app market, before the vulnerabilities
were even disclosed. We also mitigated most Linux kernel security issues. See [Security
non-events](security-non-events) for examples of security problems which were mitigated by
Sandstorm.

## Strategies

Sandstorm's primary overarching security strategies are as follows.

### Platform-level authentication

Sandstorm implements authentication at the platform level, so that you
log into the platform once rather than to each application
separately. When you open an app, the platform informs the app of your
already-authenticated identity. This means that applications
themselves never handle sensitive authentication credentials like
passwords, which greatly reduces the damage possible if an
application's database is compromised.

More generally, Sandstorm aims to ensure that applications never store
sensitive secrets at all. For example, we plan to implement an
outgoing OAuth proxy such that applications do not directly engage in
OAuth requests but rather request the platform do so on their
behalf. Thus, the platform is able to store OAuth tokens securely.

### Fine-grained isolation

Sandstorm implements _fine-grained_ containers. This means that
Sandstorm does not just isolate apps from each other, but isolates
individual resources within an app. For example, with Etherpad (a
document editor), Sandstorm creates a new Etherpad instance in its own
isolated container for every Etherpad document you create.

Fine-grained isolation allows Sandstorm to implement access control at
the container level. When you share an Etherpad document, you are
telling _Sandstorm_ who should have access, not Etherpad. Thus, no bug
in Etherpad can allow someone to get access to a document to which
they should not have.

It's important to note that Sandstorm can only truly enforce a binary
has access / does not have access. Permission levels like read
vs. write are app-dependent and thus can only be implemented by the
app. To that end, when a user connects, Sandstorm computes (via the
[sharing
model](https://blog.sandstorm.io/news/2015-05-05-delegation-is-the-cornerstone-of-civilization.html))
which permissions the user has, and then asks the app to enforce those
permissions on the user's session. That is, when the app receives
requests, those requests are annotated with information like "this
user has read permission but not write". The app can then enforce said
permissions without ever needing to track any information about
specific users.

### True Confinement

A Sandstorm app, by default, is totally isolated from the network. It
cannot connect to anyone; it can only receive proxied HTTP requests
from the user. Thus, by default, an app cannot "phone home" to its
developers' servers, and cannot build an advertising profile on you,
unless you give it permission to do so.

It's worth noting that it may be possible for a malicious app to leak
small amounts of information through "covert channels". For example,
if the developer is able to run another app on the same server where
the user's instance of the app is running (perhaps because both are
running in a shared hosting environment), then the two app instances
may be able to communicate by varying their CPU usage and observing
the timing changes caused by those variations. Sandstorm ultimately
cannot prevent these kinds of attacks. However, since covert channels
are very obviously malicious, any developer caught using one would
risk serious PR and possibly legal consequences, which should
hopefully deter any large company from doing such a thing. Moreover,
covert channels are usually very limited in bandwidth. Sandstorm
ensures that it is not possible to bootstrap a normal communications
channel by leaking plain bits -- in technical terms, _capabilities_ in
Sandstorm are never just bits, and therefore you cannot leak
_capabilities_ via covert channels.

_**Beta Notice:** As of this writing (April 2016), Sandstorm is in
beta. Key features allowing a user to easily grant an application
access to external resources are still in development. In order to
make Sandstorm more useful to early adopters, we have temporarily
opened some intentional holes in our confinement model. For example,
we have allowed outgoing HTTP to arbitrary servers in order to permit
the TinyTiny RSS app to fetch RSS feeds, and we have allowed incoming
and outgoing SMTP (with certain restrictions) to allow email clients
to work. These holes will be closed as soon as the Powerbox UI and
drivers make them obsolete, but in the meantime Sandstorm does not yet
implement true confinement._

### Capability-based Usable Security

Sandstorm employs capability-based security in order to make security
_usable_.

Security without usability is, after all, trivial: just disconnect
your server from the network. Now it's secure, but useless. The real
challenge in security is making sure it does not get in way of getting
work done.

Since Sandstorm isolates and confines apps by default, we need a way
to allow the user to connect apps to each other easily and
securely. Capability-based security helps enable this by representing
permissions as "capabilities", objects which the user may pass around
between apps. A capability both identifies a resource (like an address)
and grants its bearer permission to _use_ that resource.

The advantage of capability-based security is that it effectively
infers _security_ from a separate action that the user had to do
anyway. Consider a traditional system based on access control lists
(ACLs). Normally, there are two steps required for a user to connect
app A to app B.

1. The user tells app A how to find app B, for example by specifying app B's hostname.
2. The user edits app B's access control list to indicate that app A has access.

Capability-based security combines these two into one step:

1. The user gives app A a capability to app B.

Notice that this one step is something the user would need to do _even
if there were no security_. App A always needs to be told which app B
to talk to.

**The Powerbox**

Sandstorm uses capability-based security at every level of the
platform. All intra-system communications are performed using [Cap'n
Proto](https://capnproto.org), a capability-based transport network
protocol. Sandstorm capabilities are literally Cap'n Proto
capabilities in implementation.

At the user interface level, the user interacts with capabilities
through "the powerbox". The basic functioning of the powerbox is as
follows:

1. As the user installs apps, each app tells the platform about what kinds of APIs (Cap'n Proto interfaces) it implements.
2. At some point, an app that the user is using makes a request to the platform saying "I need a capability implementing interface `Foo`".
3. The _platform_ renders a picker UI to the user, where the user can choose from among all their apps that implement API `Foo`.
4. The user chooses the app they want to satisfy the request.
5. The platform grants the requesting app a capability to the chosen API.

Thus, we've implemented a "service discovery" mechanism that is
user-friendly and automatically handles security.

The Powerbox is an excellent example of the intersection between
Sandstorm's promises of Usability, Security, and Freedom:

* **Usability:** The user does not need to understand concepts like IP
addresses, hostnames, access credentials, etc. in order to connect two
apps. The choice is presented in a way that non-technical users can
grasp.

* **Security:** The platform can automatically infer the proper
security settings from the user's choice: obviously, the user wants
the requesting app to have permission to access the target they chose,
and no others.

* **Freedom:** An app can never request permission to a _specific_
other app, but can only ask for something implementing the desired
_API_. The user can always substitute any compatible app. This helps
to prevent vendor lock-in, where all apps from a vendor integrate only
with each other and fail to give the user any ability to swap out one
app for a third party app.

_Note: As of this writing (May 2015), the powerbox is still in the
process of being implemented. This is why we have not yet implemented
full confinement, as mentioned above: without the powerbox, it would
be too limiting._

## Tactics

At a lower level, here are some of the techniques Sandstorm uses to provide security.

### Server Sandboxing

Every grain (fine-grained application instance) runs, on the server side, inside a secure sandbox. The sandbox is based on the same Linux kernel namespacing features commonly used to implement containers. However, unlike most container implementations, Sandstorm implements various measures to reduce the kernel's "attack surface". That is, Sandstorm disables many kernel APIs that apps don't need, in order to mitigate any security vulnerabilities found in those APIs. For example:

* We use seccomp-bpf to disable many exotic system calls, especially
  ones which have seen a lot of vulnerabilities in the past. For
  example, we do not allow apps to create new UID namespaces -- the
  source of a large number of recent kernel vulnerabilities.

* We do not mount `/proc` or `/sys` filesystems.

* The only devices exposed are `/dev/zero`, `/dev/null`, and
  `/dev/urandom` (with `/dev/random` symlinked to `urandom`, [as it
  should
  be](http://lists.randombit.net/pipermail/cryptography/2013-August/004983.html)).

Over time, Sandstorm plans to disable more and more system calls by
moving implementations to userspace, but even with the filter we
already have, Sandstorm has avoided dozens of kernel vulnerabilities
over the last few months.

Sandstorm's server container maps the app's package (libraries,
assets, etc.) read-only, and maps the per-grain writable storage at
`/var`. Thus, apps are stateful, yet assets can be shared between many
instances of the app.

An app's only communication to the outside world is done through a
single Cap'n Proto socket, inherited by the app's root process. For
example, HTTP requests are delivered to the app as Cap'n Proto
RPCs. The app may employ shims (such as `sandstorm-http-bridge`) to
bridge between Cap'n Proto and traditional protocols, e.g. to be able
to use a traditional HTTP server without modification. By using a
capability-based schema-driven protocol, it is easy to review exactly
what an app can do for security purposes. See for example Sandstorm's
[web-session.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/web-session.capnp)
which defines HTTP over Cap'n Proto: notice that this is far more
readable than the HTTP specification.

### Client Sandboxing

On the client side, Sandstorm isolates apps by requiring every app to
run on a separate, randomly-generated hostname. Because of this,
Sandstorm requires a [wildcard
host](../administering/wildcard.md).

Sandstorm not only hosts each grain at a separate origin, but actually
creates a new origin for every _session_. That is, every time a user
opens a document, it is hosted at a new one-off
cryptographically-random hostname which expires shortly after the
document is closed.

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

Sandstorm will soon employ the `Content-Security-Policy` header to
prevent an app from communicating with other origins without
permission, in order to implement full confinement. As of this writing
(May 2015), this has not yet been put in place, mostly because
server-side confinement is not complete (as described earlier) which
makes client-side confinement largely moot for the moment.
