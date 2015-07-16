# About Sandcats.io

Sandcats.io is a free-of-cost dynamic DNS service run by the Sandstorm
development team.

The purpose is to help people who run their own server have a working
hostname so they can run a server without having to think hard about
DNS. People who use Sandcats get a free domain name like
_username.sandcats.io_ that points at the Sandstorm install that they
control.

Sandcats is a totally optional part of running your own Sandstorm
instance.

# Features

Sandcats is **integrated into the Sandstorm installer** so that when
you install Sandstorm, you get working DNS, including wildcard DNS.

The Sandcats backend is **free, open source software** under the
Apache License 2.0; you can [view and participate in the
project](https://github.com/sandstorm-io/sandcats).

Sandcats integrates **60-second** latency for dynamic DNS
configuration via a custom UDP protocol to detect IP address
changes. To achieve this low latency, when Sandcats integration is
enabled, your Sandstorm server sends a UDP ping message to the central
Sandcats service every 60 seconds.

Sandcats uses **HTTPS client certificates** for authentication, which
Sandstorm (and the install script) manage for users. You can find
these certificates under `/opt/sandstorm/var/sandcats` by
default. Please save these somewhere safe so you can hold onto your
domain.

# Recovering your domain

**Email-based recovery:**

If you have lost your three `id_rsa` files: When you are installing
Sandstorm on a new server, you can **recover a domain** automatically
by using the Sandstorm installer and typing `help` at the Sandcats
prompts.

**File-based recovery:** To manually recover a domain:

* Find your three three `id_rsa` certificate files (usually
  `/opt/sandstorm/var/sandcats`) and keep them safe somewhere.

* Do a new Sandstorm install, probably to `/opt/sandstorm`.

* Copy those three `id_rsa` certificate files into the Sandcats
  directory (usually `/opt/sandstorm/var/sandcats`).

* In your new Sandstorm install, ensure you have your `BASE_URL` and
  `WILDCARD_HOST` set properly in your `sandstorm.conf`.

* Edit `sandstorm.conf` to contain this line:
  `SANDCATS_BASE_DOMAIN=sandcats.io`

* Now restart Sandstorm `sandstorm stop ; sandstorm start`, and wait
  at least 60 seconds.

* Your DNS hostname should have auto-updated. Check that DNS is
  working with `nslookup <myname>.sandcats.io` from another
  machine. This will help eliminate DNS as an issue when trying to
  access your server.

# Disabling the sandcats service

If you want to run Sandstorm without the Sandstorm service, remove the

```bash
SANDCATS_BASE_DOMAIN=...
```

line from your `/opt/sandstorm/sandstorm.conf`. That will disable the functionality. Note that this does not delete any domains you registered. It does cause them to stop updating.

# Contact us for help

If you have more questions, or are having trouble, email:

support@sandstorm.io