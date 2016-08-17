A Sandstorm app delegates authentication to the Sandstorm
platform. This page explains how to identify human visitors to an app
via HTTP(S). For information on authenticating mobile apps, native
clients, and other automated agents, see [Exporting HTTP
APIs](http-apis.md).

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
[current implementation](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/sandstorm-http-bridge.c%2B%2B)
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

* `X-Sandstorm-Tab-Id`: Unique identifier for the grain tab in which
  this request is taking place. This can be used to correlate multiple
  requests being performed in the same tab even when the user is
  anonymous. Also, for HTTP APIs, requests using the same API token
  will have the same tab ID, to allow you to correlate requests from
  the same client.

* `X-Sandstorm-Permissions`: This contains a list of the permissions
  held by the current user, joined with a comma such as `edit,admin` or
  just `edit`. Permissions are defined in the package's
  `sandstorm-pkgdef.capnp`. The grain's owner holds every permission
  and can use the "Share access" button to authorize other users.

* `X-Sandstorm-Preferred-Handle`: The user's preferred "handle". A
  handle is like a Unix username. It contains only lower-case ASCII
  letters, digits, and underscores, and it never starts with a digit.
  The user can set their preferred handle in their account settings.
  This handle is NOT UNIQUE; it is only a hint from the user. Apps
  that use handles must decide for themselves whether they need
  unique handles and, if so, implement some mechanism to deal with
  duplicates (such as prompting the user to choose a different one,
  or just appending some digits). Apps should strongly consider
  using display names (`X-Sandstorm-Username`) instead of handles.
  **WARNING: A user can change their preferred handle at any time.
  Two users can have the same preferred handle. The preferred handle
  is just another form of display name. Do not use preferred handles
  as primary keys or for security; use `X-Sandstorm-User-Id`
  instead.**

* `X-Sandstorm-User-Picture`: The URL of the user's profile picture.
  The exact resolution of the picture is not specified, but assume
  it is optimized for a 64x64 or smaller viewport (i.e. the actual
  size is around 128x128 for high-DPI displays). Although profile
  pictures are normally square, it is recommended to use CSS `max-width` and
  `max-height` instead of `width` and `height` in order to avoid
  distorting a non-square picture. For logged-in users, this field is
  always present. The default value is an identicon generated from the
  user's ID.

* `X-Sandstorm-User-Pronouns`: Indicates by which pronouns the user
  prefers to be referred. Possible values are `neutral` (English:
  "they"), `male` (English: "he/him"), `female` (English: "she/her"),
  and `robot` (English: "it"). If the header is not present, assume
  `neutral`. The purpose of this header is to allow cleaner text in
  user interfaces.

## Apps operating without sandstorm-http-bridge

It is possible to write a Sandstorm app that does not use
`sandstorm-http-bridge`! It can access authentication data by using
the Cap'n Proto raw Sandstorm API. We provide sample code for that in
the
[sandstorm-rawapi-example](https://github.com/sandstorm-io/sandstorm-rawapi-example)
repository on GitHub.


## Defining permissions and roles

Apps define permissions by providing a
[`UiView.ViewInfo`](https://github.com/sandstorm-io/sandstorm/blob/v0.177/src/sandstorm/grain.capnp#L160-L265) to Sandstorm.
Apps that use `sandstorm-http-bridge`
can specify a `ViewInfo` value in the `PackageDefinition.bridgeConfig` field
of their `sandstorm-pkgdef.capnp`.
Apps that do not use `sandstorm-http-bridge`
can directly provide a `ViewInfo` by implementing the
[`UiView.getViewInfo()`](https://github.com/sandstorm-io/sandstorm/blob/v0.177/src/sandstorm/grain.capnp#L157) Cap'n Proto method.

When sharing a grain, a user selects a bundle of permissions to grant.
Such a bundle of permissions is called a *role*.
Roles are intended to give users a more human-friendly
handle on permissions and to steer users away from
combinitions of permissions that might not make sense.
Like permissions, roles are defined in an app's `ViewInfo`.

From Sandstorm's perspective, the meanings of permissions are completely opaque.
Sandstorm merely tracks who is allowed to access which grain with which permissions.
Sandstorm represents those permissions as a bit vector and leaves it up to the app
to interpret those bits in an appropriate way.
When a share takes place, Sandstorm records the *role* that was shared, but not the
precise *permissions*, which are are computed on-the-fly every time the recipient
of the share opens the grain.
Therefore, if a later version of the app modifies the role definition,
existing shares will be affected.

In a `ViewInfo`, permissions and roles are defined in lists of
[`PermissionDef`](https://github.com/sandstorm-io/sandstorm/blob/v0.177/src/sandstorm/grain.capnp#L524-L545) and
[`RoleDef`](https://github.com/sandstorm-io/sandstorm/blob/v0.177/src/sandstorm/grain.capnp#L547-L579)
values. Later versions of an app can always add more permissions or
roles, but it is important to never remove any element from these lists.
Instead, you can set the `obsolete` field to `true`.

Here are some examples:

* A [sandstorm-pkgdef.capnp](https://github.com/kentonv/ssjekyll/blob/fd09dbdbd6644abe63c50060044b71556130c30d/sandstorm-pkgdef.capnp)
  with no permissions defined.

* A [sandstorm-pkgdef.capnp](https://github.com/jparyani/mediawiki-sandstorm/blob/8c7a7d10b6121cb5e94247f7ea27a46ebf8e84eb/sandstorm-pkgdef.capnp)
  with one permission defined.

* A [sandstorm-pkgdef.capnp](https://github.com/dwrensha/groovebasin/blob/c6a2cbda0b7a94971f9671a6b4955e1007470556/.sandstorm/sandstorm-pkgdef.capnp)
  with five permissions defined.
