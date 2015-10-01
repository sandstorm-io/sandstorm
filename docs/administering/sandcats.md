# About Sandcats.io

Sandcats.io is a free-of-cost dynamic DNS service and HTTPS
certificate service run by the Sandstorm development team. In a
nutshell:

* Sandstorm users can have a free domain name of the form
  `example.sandcats.io`.

* Sandstorm can automatically set up that domain, including a valid
  HTTPS certificate for it.

* It's an official part of Sandstorm and we recommend people use it!

In more detail:

* Users host their own servers. A hostname like `example.sandcats.io`
  points at the IP address of someone's server, and that server holds
  its own private keys.

* It assumes your server should be reachable from the global Internet.

* It's an optional service. Keep reading this page to learn how to
  stop using it.

The purpose is to help people who run their own server have a working
hostname and HTTPS (TLS/SSL) certificate without having to think hard
about the domain name system or public key infrastructure.

# Features

Sandcats is **integrated into the Sandstorm installer** so that when
you install Sandstorm, you get working DNS, including wildcard DNS,
as well as working HTTPS for the main Sandstorm interface.

The Sandcats backend is **free, open source software** under the
Apache License 2.0; you can [view and participate in the
project](https://github.com/sandstorm-io/sandcats).

The Sandcats DNS service provides **60-second** latency for IP address
updates via a custom UDP protocol to detect address changes. To
achieve this low latency, when Sandcats integration is enabled, your
Sandstorm server sends a UDP ping message to the central Sandcats
service every 60 seconds.

The Sandcats certificate service (for providing users with valid
HTTPS) provides seven-day certificates and an API for automatic
renewal.

Sandcats uses **HTTPS client certificates** for authentication, which
Sandstorm (and the install script) manage for users. You can find
these certificates under `/opt/sandstorm/var/sandcats` by
default. Please save these somewhere safe so you can hold onto your
domain.

# How the HTTPS service works

The Sandstorm install script, when it runs on your server, generates a
private key and certificate signing request that it sends to the
Sandcats.io service (via the `/getcertificate` JSON-RPC endpoint).

Sandcats verifies that the request is coming from the owner of this
particular `example.sandcats.io` domain name, and if so, passes the
request along to GlobalSign for signing. The install script receives
the signed certificate and places it in places it in
`/opt/sandstorm/var/sandcats/https/example.sandcats.io/`.

When Sandstorm starts, it looks in the above directory for keys &
certificates and uses the first certificate that is valid.

These certificates expire weekly, so Sandstorm also checks every
(approximately) 2 hours if the certificate it is using is on the last
3 days of its lifetime. If so, Sandstorm takes the same action as the
install script: generate new key, generate certificate signing
request, send that to Sandcats.io, store the response. (As an
implementation detail, these certs technically last 9 days, but we
renew them every 7 days.)

Sandstorm automatically starts using new certificates without needing
intervention from the server operator. You can read the code that
powers that in `meteor-bundle-main.js` in the `sandstorm` git
repository.

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

If you want to run Sandstorm without the Sandcats service, remove the

```bash
SANDCATS_BASE_DOMAIN=...
```

line from your `/opt/sandstorm/sandstorm.conf`. That will disable the
functionality. Note that this does not delete any domains you
registered. It does cause them to stop updating.

# Contact us for help

If you have more questions, or are having trouble, email:

support@sandstorm.io
