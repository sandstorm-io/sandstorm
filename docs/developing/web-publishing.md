A Sandstorm app can publish **static web content** to **any domain**
of the user's choosing. This is useful for content management systems,
blogging platforms, and other apps. This guide helps app authors use
that feature of the Sandstorm platform.

## Overview

In Sandstorm, an app can publish **static HTML** and other files in a
way where Sandstorm will serve the content, rather than the app. This
saves on compute time and limits attack surface.

You can **[try it
now](https://oasis.sandstorm.io/appdemo/qn94a65er7m7s3zgwrsnv8hhh81dw5mc8zpt75a8su30dqhv9gt0)**
with this sample app ([full source
available](https://github.com/paulproteus/sandstorm-sample-static-publishing/)).

**Store static files in `/var/www`**. Each directory within `/var/www`
should contain a file called `index.html`.

The grain can ask Sandstorm to enable publishing by requesting the
creation of a unique `publicId`. Once that's done, the files are
**available on a special subdomain** of the Sandstorm install. The
subdomain takes the form `publicId.sandstorm.example.com`.

Users can also **make the content available at any domain**. To do
that, they need to configure **a CNAME record** pointing at the
Sandstorm install; this is how their domain's DNS will resolve to the
Sandstorm server. The user also needs **a TXT record**; this is how
Sandstorm determines what `publicId` this domain corresponds to.

This page explains how to generate a `publicId` and how to instruct a
user of your app to configure their DNS appropriately. This a
**provisional API**; see the note below about how we aim to make this
more usable and more secure.

## A helper program you can include, to enable publishing & request a publicId

The simplest way to enable static publishing is to embed a small C++
program with your app. The [Sample Static Publishing
App](https://github.com/paulproteus/sandstorm-sample-static-publishing/)
includes that C++ code.

To include the C++ code in your app, copy [these
files](https://github.com/paulproteus/sandstorm-sample-static-publishing/tree/master/sandstorm-integration)
into a directory of your app called `sandstorm-integration`.

If you are using `vagrant-spk`, also add the following to the end of your
`.sandstorm/setup.sh`:

```bash
### Download & compile capnproto and the Sandstorm getPublicId helper.

# First, get capnproto from master and install it to
# /usr/local/bin. This requires a C++ compiler. We opt for clang
# because that's what Sandstorm is typically compiled with.
if [ ! -e /usr/local/bin/capnp ] ; then
    sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q clang autoconf pkg-config libtool
    cd /tmp
    if [ ! -e capnproto ]; then git clone https://github.com/sandstorm-io/capnproto; fi
    cd capnproto
    git checkout master
    cd c++
    autoreconf -i
    ./configure
    make -j2
    sudo make install
fi

# Second, compile the small C++ program within
# /opt/app/sandstorm-integration.
if [ ! -e /opt/app/sandstorm-integration/getPublicId ] ; then
    pushd /opt/app/sandstorm-integration
    make
fi
### All done.
```

Now, run the improved `.sandstorm/setup.sh` script by doing:

```bash
vagrant-spk vm provision
```

This should result in a
`/opt/app/sandstorm-integration/bin/getPublicId` binary showing up in
your directory tree. When you run it and provide the current
`X-Sandstorm-Session-Id` header as a command-line parameter, it will
output a `publicId` (and other information, see below).

If you prefer to use your own build system, you can use the above as
inspiration. If you prefer to call Sandstorm's RPC directly, keep
reading.

**Note**: At the time of writing, some vagrant-spk stacks crash if you
run `vagrant-spk vm provision` a second time. We're [working on fixing
that.](https://github.com/sandstorm-io/vagrant-spk/issues/87)

## Show DNS instructions to the user

You should make sure the user knows how to configure their domain's
CNAME record (to point at the Sandstorm install) and TXT record (to
tell Sandstorm which grain the domain points at).

You can find sample text in the [Sandstorm sample app with static
publishing](https://github.com/paulproteus/sandstorm-sample-static-publishing/blob/master/after_publish.php). The essentials are:

* The user can preview their site at the `autoUrl` link. The `bin/getPublicId` program
  prints that as line #3 (`lines[2]` in 0-indexed programming languages).

* The user should set their CNAME value to the host component of the
  `autoUrl`, for example `publicId.sandstorm.example.com`. You can
  calculate this host component of the URL by parsing the `autoUrl`.

* The user should set up a TXT record at `sandstorm-www.example.com`
  containing just the `publicId`. The `bin/getPublicId` program prints
  that as line 1 (`lines[0]` in 0-indexed programming languages).

## Using the Sandstorm Cap'n Proto APIs directly

You can access the Sandstorm `HackSessionContext` capability directly
if you want more performance or prefer to use the Sandstorm APIs with
no overhead.

**Start by obtaining a `HackSessionContext` capability.**
[`HackSessionContext`](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/hack-session.capnp)
is a [Cap'n Proto](https://capnproto.org) interface. You must obtain
an instance of this capability. The way to do this depends on whether
your app uses `sandstorm-http-bridge` (check your
`sandstorm-pkgdef.capnp` to find out).

If you are using the raw Cap'n Proto API without the HTTP Bridge, then
the `SessionContext` capability you receive as a parameter to the
`UiView.newSession()` method can be cast to `HackSessionContext`.  *
If you are using `sandstorm-http-bridge`, you must open a Cap'n Proto
connection to `unix:/tmp/sandstorm-api`, which will give you a
[SandstormHttpBridge](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/sandstorm-http-bridge.capnp)
capability. Call `getSessionContext()` on that capability, using the
ID that sandstorm-http-bridge places in the `X-Sandstorm-Session-Id`
header, and cast the result to a `HackSessionContext`.

Note that `HackSessionContext` is a temporary API. As described below,
we intend to replace this with a better API later.

**Then call `getPublicId()` on the context.** The first time you call
this, the grain (app instance) is assigned a "public ID", which is a
random string that uniquely identifies the grain, but which differs
from the "private ID" which appears in the grain's URL. The public ID
is not a secret as it grants no authority over the grain, whereas
anyone who knows the private ID has full control over the grain.

The method call returns the grain's public ID as well as the hostname
at which the server is hosted.

Then, instruct the user on how to set up DNS.

The user will need to set two DNS records:

    <user-host> IN CNAME `<autoUrl>`
    sandstorm-www.<user-host> IN TXT <public-id>

where:

* `<user-host>` is the hostname at which the user wishes to publish their site.
* `<autoUrl>` is the `<public-id>` plus the Sandstorm server hostname (as returned by `getPublicId()`).
* `<server-host>` is the hostname of the Sandstorm server (as returned by `getPublicId()`).

## Raw API example

See the Hacker CMS app, which can be installed from the [app
list](https://sandstorm.io/apps) or from [source
code](https://github.com/kentonv/ssjekyll).

## Note: Provisional API

The current Cap'n Proto RPC for web publishing is hacky and not
intended to be the long-term solution. In the long term, users will be
able to connect domains to their Sandstorm account and then grant them
to apps as capabilities through the Powerbox UI. Since the Powerbox
and persistent capabilities are not yet implemented -- much less the
ability to connect domains -- we are providing a hack so that
developers can get started on such apps now. The hack allows a user to
designate a Sandstorm app to host their domain via a special TXT
record.

Also, the use of a C++ binary that you must embed might not be the
most convenient way to expose the Cap'n Proto API. We're considering
creating a pure-frontend Javascript API like [offer
templates](http-apis.md) or a `postMessage`-based API, and/or a
backend API that is part of `sandstorm-http-bridge`. Let us know if
you have a preference for what you would like to use.

## Why only static content?

In order to make per-user application instances cost-effective, a
Sandstorm application server normally only runs while a user has the
application open. This works very well for things like private
documents which have only one or maybe a few users. A public web site,
however, is intended to be viewed widely and at all hours of the
day. If we had to spin up the application sever for every visit, we'd
lose this key advantage.

By restricting web publishing to static content, we can avoid spinning
up the application server for regular visits. Only editing the content
requires the server to be active.

As of this writing, there is no way to publish dynamic web sites to a
custom domain via Sandstorm. In the future, this will become possible
via the use of APIs. Once an application can export a public API, then
it will be possible for "static" javascript published on a domain to
make calls to that API. Such calls will, of course, require spinning
up the server to handle, but a well-written app may be able to avoid
making API calls except under special circumstances (e.g. when a user
clicks to post a comment).
