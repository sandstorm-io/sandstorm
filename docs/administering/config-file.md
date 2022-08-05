This document provides **detailed technical documentation**, also known as reference documentation,
on the available options within Sandstorm's configuration file, `sandstorm.conf`.

## Overview

At Sandstorm startup,
[run-bundle.c++](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/run-bundle.c%2B%2B)
parses the configuration file, using the information to adjust Sandstorm startup details. Typically
this takes the form of passing the config options to the Sandstorm shell as Meteor settings, but it
includes choosing what user ID to switch to, what environment variables to set, and other startup
details.

Most Sandstorm installations use `/opt/sandstorm` as the main directory. In that case, you can find
sandstorm.conf in `/opt/sandstorm/sandstorm.conf`.

## List of all sandstorm.conf settings and their effects

### SERVER_USER

If Sandstorm is started as root, Sandstorm will switch to the user ID named by this configuration parameter.
On a default install, this is `sandstorm`. Example:

```bash
SERVER_USER=sandstorm
```

### PORT

A comma-separated list of port numbers on which Sandstorm will bind, listening for inbound HTTP.
By default, 80 if that port was available; otherwise, 6080.

If Sandstorm is started as root, Sandstorm binds to this port as root, allowing it to use
low-numbered ports. The socket is passed-through to code that does not run as root.

Example:

```bash
PORT=80,6080
```

Sandstorm treats the first PORT value differently from the other ones, which we call alternate ports.

**First port.** When a request reaches Sandstorm via first PORT, if the request is for a URL within
the WILDCARD_HOST pattern, then serve a response. If the request is for a URL that is **not** within
the WILDCARD_HOST pattern, typically a static publishing website, then also serve a response.

**Alternate ports.** When a request arrives and it is for a URL within the WILDCARD_HOST pattern,
Sandstorm serves a HTTP redirect to a canonicalized version of the requested URL, with the intent
of serving the request using the primary port. If the request is outside the WILDCARD_HOST pattern,
typically a static publishing website, then serve a normal response.

### HTTPS_PORT

A port number for Sandstorm to bind on and listen for HTTPS. On a default install, if port 443
was available and the user chose to use Sandcats, this is 443. However, this may be set for any
Sandstorm-managed TLS configuration, including automated renewals of certificates with Let's Encrypt
with a supported DNS provider or a manually-uploaded certificate. If this config option is missing,
Sandstorm's built-in HTTPS server is disabled.

If Sandstorm is started as root, Sandstorm binds to this port as root, allowing it to use
low-numbered ports. The socket is passed-through to code that does not run as root.

Example:

```bash
HTTPS_PORT=443
```

A HTTPS_PORT is automatically treated as the first port, in the context of "first port" vs.
"alternate ports."

### SMTP_LISTEN_PORT

A port number on which Sandstorm will bind, listening for inbound email. By default, 30025; if
missing, the Sandstorm shell uses 30025. You can choose port 25 if you like.

If Sandstorm is started as root, Sandstorm binds to this port as root, allowing it to use
low-numbered ports. The socket is passed-through to code that does not run as root.

Example:

```bash
SMTP_LISTEN_PORT=25
```

### BIND_IP

The IP address on which Sandstorm will listen for HTTP (via PORT), HTTPS (via HTTPS_PORT), and SMTP
(via SMTP_LISTEN_PORT). Supports IPv4 or IPv6 addresses. Example:

```bash
BIND_IP=0.0.0.0
```

### MONGO_PORT

A port number that Sandstorm will bind to for its built-in MongoDB service. By default,
6081.

Example:

```
MONGO_PORT=6081
```

### BASE_URL

The URL you expect people to type into their browser address bar to reach your sandstorm server, like `https://alpha.sandstorm.io` or `http://local.sandstorm.io:6080`. It should include protocol (http:// or https://), host, and port (if non-default), but no path. Note that if you have a reverse proxy in front of your web site, BASE_URL points at the proxy, not directly at the Sandstorm server -- again, it's the URL people type into the address bar, not necessarily the physical address of the Sandstorm server itself.

Example:

```
BASE_URL=http://sandstorm.example.com:6080
```

### WILDCARD_HOST

This specifies a pattern of addresses all of which also end up at your Sandstorm server. Unlike BASE_URL, WILDCARD_HOST should not include a protocol, only hostname and optionally port. The hostname must have a * somewhere in it. If this * is replaced by any alphanumeric string, and the value is prefixed with the same protocol used in BASE_URL, the result should be a URL which, if entered in the browser, would resolve to your Sandstorm server. So, for example, `alpha-*.sandstorm.io` is the WILDCARD_HOST for Sandstorm Alpha, while `*.oasis.sandstorm.io` is the WILDCARD_HOST for Oasis, and `*.local.sandstorm.io:6080` might be the WILDCARD_HOST for a local server. Notice that you can put the * anywhere you want in the URL, but most DNS servers only support a leading *. in a wildcard entry.

Example:

```
WILDCARD_HOST=*.sandstorm.example.com:6080
```

### UPDATE_CHANNEL

The path within `install.sandstorm.io` that Sandstorm automatically checks for downloads. The term
is borrowed from [Google Chrome](https://www.chromium.org/getting-involved/dev-channel). By default,
`dev`. Set it to `none` to disable updates. Note that at the time of writing, there is only one
channel, `dev`.

Example:

```
UPDATE_CHANNEL=dev
```

### SANDCATS_BASE_DOMAIN

A hostname that is used as the API host for the built-in
[sandcats dynamic DNS and free HTTPS certificates](sandcats.md) service. By default, `sandcats.io`
if the user chooses to use sandcats; otherwise, missing. The presence/absence of this setting
controls if Sandstorm will connect to the sandcats service. By setting it to a different hostname,
you can use a different implementation of the sandcats protocol.

Example:

```
SANDCATS_BASE_DOMAIN=sandcats.io
```

### ALLOW_DEMO_ACCOUNTS

A boolean (true/false or yes/no) that controls if this Sandstorm server has [demo mode](demo.md) enabled.
By default, absent (which is the same as false).

Example:

```
ALLOW_DEMO_ACCOUNTS=false
```

### ALLOW_DEV_ACCOUNTS

A boolean (true/false or yes/no) that controls if this Sandstorm server allows any visitor to sign in and have
admin privileges or a user account. This feature is quite dangerous; it is enabled by default for
dev accounts (including within vagrant-spk). By default, false.

Example:

```
ALLOW_DEV_ACCOUNTS=false
```

### USE_EXPERIMENTAL_SECCOMP_FILTER

A boolean (true/false or yes/no) that controls whether to use
Sandstorm's experimental new seccomp filter (as opposed to the old one).
The new filter is stricter, and is disabled by default. Once it is
deemed sufficiently mature the new filter will become the default.

### LOG_SECCOMP_VIOLATIONS

A boolean (true/false or yes/no) that controls whether violations of the
seccomp filter should be logged to the kernel's message log, when using
the new experimental seccomp filter. Defaults to false.

### ALLOW_LEGACY_RELAXED_CSP

A boolean (true/false or yes/no) that controls whether to allow apps to
load client-side scripts from third-party servers. Several apps are not
yet compatible with the new Content Security Policy, so the legacy one is
currently enabled by default. Once app support is deemed sufficiently
adequate, the new CSP will become the default.

### IS_TESTING

**Used rarely.** A boolean (true/false or yes/no) that adjusts internal settings for Sandstorm's
integration test suite.

### DDP_DEFAULT_CONNECTION_URL

**Used rarely.** Alternate URL for Meteor DDP. Useful in the unusual case that you use a CDN for
your BASE_URL.

### HIDE_TROUBLESHOOTING

**Deprecated.** A boolean (true/false or yes/no) that hides the "Troubleshooting" link on
the login areas within Sandstorm. Works at present, but may be removed in the future. Use the
Personalization section of the admin panel to configure this and other related options.

### WILDCARD_PARENT_URL

**Deprecated.** Historic alternative to WILDCARD_HOST.

### MAIL_URL

**Deprecated.** URL for outbound SMTP. Configure SMTP using the admin area within Sandstorm
instead.
