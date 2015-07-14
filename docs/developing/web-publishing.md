# Web Publishing

A Sandstorm app can publish static web content to a user's
domain. This is useful for e.g. content management systems and
blogging platforms. This guide is for application developers wishing
to access this functionality.

## Note: Provisional API

The current implementation of web publishing is hacky and not intended
to be the long-term solution. In the long term, users will be able to
connect domains to their Sandstorm account and then grant them to apps
as capabilities through the Powerbox UI. Since the Powerbox and
persistent capabilities are not yet implemented -- much less the
ability to connect domains -- we are providing a hack so that
developers can get started on such apps now. The hack allows a user to
designate a Sandstorm app to host their domain via a special TXT
record.

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

## How to publish

### 1. Place content under `/var/www`.

The app should store the published content under `/var/www`. Each
directory should contain a file called `index.html`.

### 2. Obtain a `HackSessionContext` capability.

[`HackSessionContext`](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/hack-session.capnp)
is a [Cap'n Proto](https://capnproto.org) interface. You must obtain
an instance of this capability. The way to do this depends on whether
your app uses `sandstorm-http-bridge` (check your
`sandstorm-pkgdef.capnp` to find out).

* If you are using the raw Cap'n Proto API without the HTTP Bridge,
then the `SessionContext` capability you receive as a parameter to the
`UiView.newSession()` method can be cast to `HackSessionContext`.  *
If you are using `sandstorm-http-bridge`, you must open a Cap'n Proto
connection to `unix:/tmp/sandstorm-api`, which will give you a
[SandstormHttpBridge](../blob/master/src/sandstorm/sandstorm-http-bridge.capnp)
capability. Call `getSessionContext()` on that capability, using the
ID that sandstorm-http-bridge places in the `X-Sandstorm-Session-Id`
header, and cast the result to a `HackSessionContext`.

Note that `HackSessionContext` is a temporary API. As described above,
we intend to replace this with a better API later.

### 3. Call `getPublicId()` on the context.

The first time you call this, the grain (app instance) is assigned a
"public ID", which is a random string that uniquely identifies the
grain, but which differs from the "private ID" which appears in the
grain's URL. The public ID is not a secret as it grants no authority
over the grain, whereas anyone who knows the private ID has full
control over the grain.

The method call returns the grain's public ID as well as the hostname
at which the server is hosted.

### 4. Instruct the user on how to set up DNS.

The user will need to set two DNS records:

    <user-host> IN CNAME <server-host>
    sandstorm-www.<user-host> IN TXT <public-id>

where:

* `<user-host>` is the hostname at which the user wishes to publish their site.
* `<server-host>` is the hostname of the Sandstorm server (as returned by `getPublicId()`).
* `<public-id>` is the grain's public ID.

## Example

See the Hacker CMS app, which can be installed from the [app
list](https://sandstorm.io/apps) or from [source
code](https://github.com/kentonv/ssjekyll).