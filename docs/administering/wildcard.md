To run Sandstorm, you must assign it a wildcard host, in which it can generate new hostnames
as-needed. For instance, you might set up Sandstorm to run at `example.com` and assign it the
wildcard `*.example.com`.

This page explains how to configure this and why it is needed.

## How to configure and test your own wildcard DNS record for Sandstorm

If your Sandstorm server is at `example.com` you might have the following lines in your
`/opt/sandstorm/sandstorm.conf`.

```
BASE_URL=https://example.com
WILDCARD_HOST=*.example.com
```

In order for Sandstorm grains to load, DNS lookups for domains within the `WILDCARD_HOST` need to
resolve to your Sandstorm server. You can manually test this on many systems. Open a terminal and
run this comand.

```
host arbitrary.example.com
```

You should see a message like:

```
arbitrary.example.com has address 93.184.216.34
```

This looks good: in the example, we see that a `WILDCARD_HOST` of `*.example.com` exists. The IP
address printed by the `host` command should match the IP address for your Sandstorm server. If
`host` tells you the domain is `not found: 3(NXDOMAIN)`, then you probably need to adjust your DNS
zone to create a wildcard record. If your system does not have `host`, you can try `dig` or `ping`
which serve similar functions.

To learn how to add a new wildcard DNS record, consider reading this [tutorial on setting up
Sandstorm using the DigitalOcean DNS control
panel](https://www.digitalocean.com/community/tutorials/how-to-install-sandstorm-on-ubuntu-14-04). Your
domain's DNS configuration tool might look different, but the fundamentals are probably the
same. Text-based DNS configuration systems might need a record like the following, for a Sandstorm
server running at 93.184.216.34.

```
* IN A 93.184.216.34
```

Once you add a wildcard record, you can re-run the test with `host` to see if your wildcard record
is working. You can try looking up other subdomains than `arbitrary`, such as `arbitrary2`, to make
sure that all subdomains resolve to the right IP address.

**Sandstorm can use a BASE_URL within a wildcard DNS record.** If `*.example.com` maps to the right
IP address, then you can configure Sandstorm to use a BASE_URL like `sandstorm.example.com` that is
part of a wildcard DNS record; you could set WILDCARD_HOST to `ss-*.example.com` or
`sandstorm-*.example.com`, etc.. This can be convenient if you already have one wildcard DNS
record. Note that the `WILDCARD_HOST` and the `BASE_URL` must be within the same domain name because
otherwise web browsers may prevent Sandstorm from setting a cookie with the wildcard subdomains, as
part of a web browser privacy protection feature (third-party cookies). One such configuration would
look like this.

```
BASE_URL=https://sandstorm.example.com
WILDCARD_HOST=sandstorm-*.example.com
```

**If you can't set up wildcard DNS, try xip.io.** If your Sandstorm BASE_URL needs to contain a
numeric IP address because you cannot configure wildcard DNS, consider reading about [how to use
Sandstorm with an internal IP address and
xip.io](faq.md#how-do-i-use-sandstorm-with-an-internal-ip-address).

## Testing wildcard HTTPS

If your server uses SSL or HTTPS, you will also need working HTTPS for all possible subdomains of
your server's domain name. This is also known as wildcard HTTPS.

If your server is at https://example.com/, you can visit https://testing.example.com/ and
https://testing2.example.com/ in your browser. If you see any kind of certificate warning or error,
then note that you need to adjust your configuration for Sandstorm to work properly. Read more in
our [SSL topic guide.](ssl.md)

## local.sandstorm.io and sandcats.io provide wildcard DNS

If you are using `vagrant-spk` to develop Sandstorm apps, or are developing Sandstorm itself, you
will likely use `local.sandstorm.io` as the `BASE_URL` for your Sandstorm server. Sandstorm.io (the
company behind Sandstorm) maintains `local.sandstorm.io` as a wildcard domain where both
`local.sandstorm.io` and all of its subdomains (`*.local.sandstorm.io`) point to `127.0.0.1`, the
same as `localhost`. This allows you to run Sandstorm for development without needing to own a
domain name or configure wildcard DNS for a subdomain.

Within the `sandcats.io` DNS service, each domain is also a wildcard domain. This allows a
self-hosted Sandstorm domain to operate correctly.

## Why Sandstorm needs wildcard DNS

Sandstorm is designed to implement strong sandboxing of apps, such
that users need not worry about the risk that a malicious -- or simply
buggy -- app might interfere with other apps or the rest of the
network. Our goal is for the network admins to be able to say: "As
long as it's on Sandstorm, you can run whatever apps you want, because
we trust Sandstorm to keep things secure."

Using a wildcard host is just one part of [Sandstorm's security
model](../using/security-practices.md).

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
