# About Sandcats.io

Sandcats.io is a free-of-cost dynamic DNS service and HTTPS certificate service run by the Sandstorm
development team. In a nutshell:

* Sandstorm users can have a free domain name of the form `example.sandcats.io`.

* Sandstorm can automatically set up that domain, including a valid HTTPS certificate for it.

* It's an official part of Sandstorm and we recommend people use it!

In more detail:

* Users host their own servers. A hostname like `example.sandcats.io` points at the IP address of
  someone's server, and that server holds its own private keys.

* It assumes your server should be reachable from the global Internet.

* It's an optional service. Keep reading this page to learn how to stop using it.

* It points at your server's public (globally routable) IP address, which it auto-detects. Read
  elsewhere about setting up Sandstorm to use an [internal IP address](faq.md#how-do-i-use-sandstorm-with-an-internal-ip-address).

The purpose is to help people who run their own server have a working hostname and HTTPS (TLS/SSL)
certificate without having to think hard about the domain name system or public key infrastructure.

# Features

Sandcats is **integrated into the Sandstorm installer** so that when you install Sandstorm, you get
working DNS, including wildcard DNS, as well as working HTTPS for the main Sandstorm interface.

The Sandcats backend is **free, open source software** under the Apache License 2.0; you can [view
and participate in the project](https://github.com/sandstorm-io/sandcats).

The Sandcats DNS service provides **60-second** latency for IP address updates via a custom UDP
protocol to detect address changes. To achieve this low latency, when Sandcats integration is
enabled, your Sandstorm server sends a UDP ping message to the central Sandcats service every 60
seconds.

The Sandcats certificate service (for providing users with valid HTTPS) provides seven-day
certificates and an API for automatic renewal.

Sandcats uses **HTTPS client certificates** for authentication, which Sandstorm and the install
script manage for users. You can find these certificates under `/opt/sandstorm/var/sandcats` by
default. Please save these somewhere safe so you can hold onto your domain.

# How the HTTPS service works

The Sandstorm install script, when it runs on your server, generates a private key and certificate
signing request that it sends to the Sandcats.io service (via the `/getcertificate` JSON-RPC
endpoint).

Sandcats verifies that the request is coming from the owner of this particular `example.sandcats.io`
domain name, and if so, passes the request along to GlobalSign for signing. The install script
receives the signed certificate and places it in
`/opt/sandstorm/var/sandcats/https/example.sandcats.io/`.

When Sandstorm starts, it looks in the above directory for keys & certificates and uses the first
certificate that is valid.

These certificates expire weekly, so Sandstorm also checks every (approximately) 2 hours if the
certificate it is using is on the last 3 days of its lifetime. If so, Sandstorm takes the same
action as the install script: generate new key, generate certificate signing request, send that to
Sandcats.io, store the response. (As an implementation detail, these certs technically last 9 days,
but we renew them every 7 days.)

Sandstorm automatically starts using new certificates without needing intervention from the server
operator. You can read the code that powers that in `meteor-bundle-main.js` in the `sandstorm` git
repository.

# Administering your sandcats.io subdomain

## Finding debugging information

By default, Sandstorm stores a log in a text file at `/opt/sandstorm/var/log/sandstorm.log`. You can
read it by running this command:

```bash
sudo less /opt/sandstorm/var/log/sandstorm.log
```

This launches a tool called `less`; for help using `less`, read [this
tutorial](http://www.networkredux.com/answers/linux-in-general/working-with-files/how-do-i-use-the-less-command-in-linux).

## Disabling the sandcats service

If your Sandstorm server used to use `sandcats.io` but you want to transition to
your own domain name (with wildcard DNS), you can disable the sandcats-related code
in your Sandstorm install.

To do that, open your `/opt/sandstorm/sandstorm.conf` file in a text editor and notice this line:

```bash
SANDCATS_BASE_DOMAIN=sandcats.io
```

Remove that line entirely, then save and quit your editor. Run `sudo service sandstorm restart` to
cause Sandstorm to notice your changes to its configuration file.

That will disable the sandcats-related functionality in your Sandstorm server on your system. This
means your domain will stop automatically updating its IP address.

Note that this does not delete any domains you registered. That's OK with us; from our perspective,
there's no need to email us to delete your domain.

## Re-installing Sandstorm and keeping your sandcats domain

If you have already registered a domain like `example.sandcats.io` as part of installing Sandstorm,
but you find yourself doing a fresh install of Sandstorm, you can use our **email-based recovery**
system.

You won't need any files from the old Sandstorm install. Instead, run the Sandstorm install script
(which we call `install.sh`) on a new server; follow the prompts to **recover a domain** by typing
`help` at the Sandcats prompts.

**Overview.** This process will:

- Ask you what `sandcats.io` subdomain you use.

- Send you an email with a short-term token.

- Ask you for the token, then pass it to the sandcats.io service.

The install will continue and your new Sandstorm install will be bound to `example.sandcats.io`.

**Full details** for those who are curious.

- When you run the `install.sh` script, if you choose mode `1` for a full server, and you say `yes`
  to the defaults, `install.sh` prepares to enable `sandcats.io` (even if you end up not using the
  `sandcats.io` service).

- Specifically, `install.sh` looks for an existing client certificate on your system in
  `/opt/sandstorm/var/sandcats/id_rsa.private.combined`. `sandcats.io` uses client certificates to
  identify a Sandstorm server as controlling a specific domain like `example.sandcats.io`.  If
  `install.sh` does not find one, it generates one using `openssl`.

- `install.sh` asks via the console what sandcats domain you want to **register.** At this point,
  you can type `help`. This changes the question - `install.sh` now asks what domain you want to
  **recover.** Provide your sandcats hostname.

- `install.sh` then uses `curl` to ask `sandcats.io` to send an email to the address that you
  provided when first registering the domain. The email contains a small bit of text that serves as
  a one-time-use recovery token.

- `install.sh` waits for you to receive the email and asks via the console for your recovery token.

- `install.sh` sends that recovery token to `sandcats.io` using `curl`, while also providing the
  client certificate currently on your system (`/opt/sandstorm/var/sandcats`). If the recovery token
  matches what the server expects, then the server updates your user registration to trust the
  client certificate on your system.

## Manually moving sandcats client certificates to a new Sandstorm install

If you prefer, you can move your `sandcats.io` credentials to a new Sandstorm install without
running the `install.sh` script. We call that **file-based recovery.** Here are the steps.

* Find your three three `id_rsa` certificate files (usually `/opt/sandstorm/var/sandcats`) and keep
  them safe somewhere. Also keep a copy of `/opt/sandstorm/var/sandcats/https` if it exists.

* Do a new Sandstorm install, presumably on a new server somewhere. It will install to
  `/opt/sandstorm`. You should choose a non-sandcats.io host name during this process, such as using
  literally `example.com`.

* Copy those three `id_rsa` certificate files from the old server to the new server's Sandcats
  directory, `/opt/sandstorm/var/sandcats`. Do the same for `/opt/sandstorm/var/sandcats/https` if
  you backed it up.

* In your new Sandstorm install, ensure you have your `BASE_URL` and `WILDCARD_HOST` set properly.
  If your sandcats.io subdomain is `example`, then you'll need `BASE_URL=example.sandcats.io` and
  `WILDCARD_HOST=*.example.sandcats.io`. Consider copying these values from the old server's
  `sandstorm.conf`.

* Edit the new server's `sandstorm.conf` to contain this line: `SANDCATS_BASE_DOMAIN=sandcats.io`

* Now restart Sandstorm by running `sudo service sandstorm stop ; sudo service sandstorm start`, and
  wait at least 60 seconds.

* Your DNS hostname should have auto-updated. Check that DNS is working with `nslookup
  <myname>.sandcats.io` from another machine. This will help eliminate DNS as an issue when trying
  to access your server.

Note that if you are using sandcats.io free HTTPS certificates, we suggest also backing up and
restoring the contents of `/opt/sandstorm/var/sandcats/https`. This is a suggestion rather than a
hard requirement; Sandstorm will request new certificates at startup. However, if your server makes
lots of requests, you will run afoul of the sandcats.io anti-abuse protections. See the [Diagnosing
"Not Authorized" problems](#diagnosing-not-authorized-problems) section for details.

## Diagnosing "Not Authorized" problems

If you see `Not Authorized` in your log files, the sandcats.io service is returning HTTP code 403
for at least one request from your server.

One reason this occurs is if you have the wrong `id_rsa*` certificate files in
`/opt/sandstorm/var/sandcats`. You can fix this problem using the email-based recovery system; for
now, this requires using `install.sh` on a throwaway VM. Once your new certificate files are
registered with `sandcats.io`, you can move them to whichever server you want using file-based
recovery.

Another reason you might see `Not Authorized` in the log files is if your server has run afoul of
sandcats.io's defense in depth against Sandstorm bugs. The HTTPS certificate service within
`sandcats.io` will reject new certificate requests if your server has more than approximately 5
active certificates per week; this code exists to prevent a Sandstorm bug from requesting many
thousands of certificates. If you are constantly requesting new certificates, you can request only
about 5 before being automatically blocked in this way.  Typically, your server will keep retrying
and the sandcats.io service will permit it to get certificates again when one of your certificates
expire.

In either case, if you need further help, please email support@sandstorm.io!

# Terms of service, privacy policy, & contact information

Sandcats.io has the following formal documents:

* [Sandcats.io privacy policy](https://sandcats.io/privacy)
* [Sandcats.io terms of service](https://sandcats.io/terms)

If you have more questions, or are having trouble, email:

[support@sandstorm.io](mailto:support@sandstorm.io)
