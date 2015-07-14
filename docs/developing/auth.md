A Sandstorm app delegates authentication to the Sandstorm
platform. This page documents the details.

## About sandstorm-http-bridge

When a web app runs within Sandstorm, Sandstorm sanitizes all HTTP
requests. By default, it passes requests to your app via a tool called
`sandstorm-http-bridge`. This results in a few interesting properties:

* Sandstorm knows *which user* is making the request, so it can add
  headers indicating the currently logged-in user's name
  ("authentication").

* Sandstorm knows *which permissions the user has* -- for example, it
  knows if the user owns this grain -- so it can add headers
  indicating what permissions the user has ("authorization").

* When your app receives HTTP requests, `sandstorm-http-bridge` has
  normalized them. If a user's browser is speaking some non-compliant
  dialect of HTTP, your app doesn't have to handle it.

### Headers that an app receives

Per the
[current implementation](https://github.com/sandstorm-io/sandstorm/blob/411b344f3acb151693036f3c061b153a2fd91d68/src/sandstorm/sandstorm-http-bridge.c%2B%2B)
of `sandstorm-http-bridge`, an app receives the following headers
related to user identity and permissions:

* `X-Sandstorm-Username`: This is set to the user's full name, in
  [percent-encoded](http://en.wikipedia.org/wiki/Percent-encoding)
  UTF-8. For example, the username `"Kurt Friedrich Gödel"` will
  appear as `"Kurt%20Friedrich%20G%C3%B6del"`.  For anonymous users,
  this header will simply contain "Anonymous%20User".

* `X-Sandstorm-User-Id`: If the user is logged in, this is set to the
  user's current user ID, which is the first 128 bits of a
  SHA-256. For example: `0ba26e59c64ec75dedbc11679f267a40`.  This
  header is **not sent at all for anonymous users**.

* `X-Sandstorm-Permissions`: This contains a list of the permissions
  held by the current user. Permissions are defined in the package's
  `sandstorm-pkgdef.capnp`. The grain's owner holds every permission
  and can use the "Share" button to authorize other users.

## Apps operating without sandstorm-http-bridge

It is possible to write a Sandstorm app that does not use
`sandstorm-http-bridge`! It can access authentication data by using
the Cap'n Proto raw Sandstorm API. We provide sample code for that in
the
[sandstorm-rawapi-example](https://github.com/sandstorm-io/sandstorm-rawapi-example)
repository on GitHub.

## Further reading

You might be interested in looking at:

* A [sandstorm-pkgdef.capnp](https://github.com/kentonv/ssjekyll/blob/fd09dbdbd6644abe63c50060044b71556130c30d/sandstorm-pkgdef.capnp)
  with no permissions defined.

* A [sandstorm-pkgdef.capnp](https://github.com/jparyani/mediawiki-sandstorm/blob/8c7a7d10b6121cb5e94247f7ea27a46ebf8e84eb/sandstorm-pkgdef.capnp)
  with one permission defined.

* The [implementation of
  sandstorm-http-bridge](https://github.com/sandstorm-io/sandstorm/blob/411b344f3acb151693036f3c061b153a2fd91d68/src/sandstorm/sandstorm-http-bridge.c%2B%2B).