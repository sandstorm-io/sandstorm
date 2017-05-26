# Using email from your Sandstorm app

Using e-mail in your Sandstorm app is accomplished through the Cap'n
Proto interfaces defined in
[hack-session.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/hack-session.capnp)
and
[email.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/email.capnp). This
becomes a little more complicated if you're using
sandstorm-http-bridge in your app (as most apps do), since you don't
have direct access to the HackSession/HackSessionContext. Below, we
will go over using either sandstorm-http-bridge or using the
HackSession directly.

## Note: Provisional API

The current implementation of e-mail is hacky and not intended to be
the long-term solution. In the long term, users will be able to
connect e-mail addresses to their Sandstorm account and then grant
them to apps as capabilities through the Powerbox UI. Since the
Powerbox and persistent capabilities are not yet implemented -- much
less the ability to connect e-mails -- we are providing a hack so that
developers can get started on such apps now. The hack involves
assigning a randomly-generated e-mail address to each app instance
that wants e-mail, but also allowing the "From" header to be set to
any e-mail address that the user has proven they own.

## Overview

When you launch an e-mail application on Sandstorm, it is assigned a
random e-mail address at your server, like
"JBuaKxjkwiJq7oksS@alpha.sandstorm.io". Any e-mail sent to that
address is delivered to the app. Moreover, your app will receive
any e-mail to an address with an arbitrary suffix, like
"JBuaKxjkwiJq7oksS+foobar@alpha.sandstorm.io". The idea is not
that you'd actually use this address publicly, but rather that you
should set up e-mail forwarding from your real address to this address.
For example, GMail allows you to set up such forwarding while still
keeping a copy in your GMail inbox, and even lets you do the forwarding
conditionally based on a filter.  Additionally, most domain registrars
have the ability to set up basic e-mail forwarding, so if you have your
own domain, it's easy to set up an address that redirects to a
Sandstorm app.

When you send e-mail from a Sandstorm app, we allow you to set the
"From" header either to your app's random address or to your verified
Sandstorm login address. Optionally, "From" e-mail address can include
a suffix as well. In the future, we'd like to add the ability to attach
additional verified addresses to your account. Either way, the
message's envelope return address is always the app's address. As a
result, the mail recipient may see that the message was sent "via"
your server.

In order to prevent abuse, E-mail usage is rate-limited
per-user. Currently, the limits default to 50 messages per day and no
more than 20 recipients on any one message. We'd like to loosen these
limits in the future by doing more careful abuse monitoring.

## Using sandstorm-http-bridge

### Receiving

To receive emails:

- Your app needs to create the [maildir](https://en.wikipedia.org/wiki/Maildir) directories within
  `/var/mail` - `/var/mail/new` and `/var/mail/cur` and `/var/mail/tmp`. You can do this in e.g.
  `launcher.sh`.

- Now when your app receives email at its publicId email address
  (e.g. JBuaKxjkwiJq7oksS@alpha.sandstorm.io), Sandstorm will pass the email to
  sandstorm-http-bridge, which will save it in `/var/mail` as a Maildir.

- Your app can process the Maildir using whatever tools are convenient for your app. This could take
  the form of a programming language library, or you could embed a Maildir-aware IMAP daemon into
  the app such as Dovecot.

### Sending

Sending e-mails is a bit more tricky. For now, you have to use the
Cap'n Proto
[`HackSessionContext`](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/hack-session.capnp)
interface that is re-exported by
sandstorm-http-bridge. sandstorm-http-bridge creates a socket at
`/tmp/sandstorm-api` and exports a bootstrap
[`SandstormHttpBridge`](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/sandstorm-http-bridge.capnp)
capability on it. You will need to call `getSessionContext()` with the
ID that sandstorm-http-bridge places in the `X-Sandstorm-Session-Id`
header. The result will be a `SessionContext` that can be cast to a
`HackSessionContext`. For example, using pycapnp, you can get the
`HackSessionContext` as follows:

```python
import socket
import sys
import capnp
import sandstorm_http_bridge_capnp
import hack_session_capnp

# Assume that we were passed the session ID as a commandline argument.
session_id = sys.argv[1]

s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.connect("/tmp/sandstorm-api")

client = capnp.TwoPartyClient(s)
bridge = client.ez_restore().cast_as(sandstorm_http_bridge_capnp.SandstormHttpBridge)
session_context = bridge.get_session_context({"id" : session_id}).wait().context
email_cap = session_context.cast_as(hack_session_capnp.HackSessionContext)
```

Now that you have a HackSessionContext, just follow the directions
below under [Sending with
HackSessionContext](#sending-with-hacksessioncontext).

## Using HackSession/HackSessionContext

### Receiving through HackSession

Your `UIView.newSession` method (refer to
[grain.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp)) must return a
HackEmailSession. In your HackEmailSession capability, you must
implement the `send` method, which will be called whenever an e-mail
is sent to the grain.

### Sending with HackSessionContext

A HackSessionContext is obtained upon call of `UIView.newSession`
(refer to
[grain.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp)). You will be
passed a HackSessionContext as the 2nd paramater, and it is up to your
app to store/use it.

Now that you have the HackSessionContext, sending e-mails is easy:

```python
req = email_cap.send_request()
email = req.email

# only getUserAddress() or the grain's public address are allowed here
# use setattr to deal with 'from' being a reserved keyword in Python
setattr(email, 'from', email_cap.getUserAddress().wait())
email.to = {address: 'example@example.com'}
email.subject = 'Example e-mail'
email.text = 'This is an example e-mail'

req.send().wait()
```
