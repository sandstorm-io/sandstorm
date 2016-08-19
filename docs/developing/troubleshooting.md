This page lists common problems and work-arounds.

This page needs expansion! If you encounter a new problem and solve it, feel
free to add it here. If you encounter a problem you don't know how to solve,
try asking on Stack Overflow, and be sure to add the "sandstorm.io" tag to your
question. Or, talk to us on IRC (#sandstorm on freenode) or
[sandstorm-dev](https://groups.google.com/group/sandstorm-dev).

Note that language-specific issues should be documented in the
language-specific guide pages, namely:

* [Python](raw-python.md)
* [Ruby on Rails](raw-ruby-on-rails.md)
* [Pure client apps](raw-pure-client-apps.md)

## Getting a shell in the context of the grain

`vagrant-spk enter-grain` allows you to run a shell (e.g. `bash`) in the context of a grain. This can
illuminate why an app is behaving in a particular way. For details and limitations, read [the
docs about the `vagrant-spk enter-grain` command](debugging.md).

## Clicking a link in the app does not open the link

Sandstorm apps cannot navigate the user away from the app. Therefore, app
authors should set `target="_blank"` on links within the app.

A convenient way to do this automatically for all links in the page is to add
the following HTML to your document's `<head>`:

```html
<base target="_blank">
```

## A blank white screen renders where the app should be

This can happen when a Sandstorm app in development doesn't know its
correct base URL and serves a HTTP redirect away from the Sandstorm
server. Sandstorm blocks that redirect, resulting in a white grain
frame.

To find out if you're running into this issue, open the Javascript
console in your browser and look for a `Content-Security-Policy`
violation. If you see a message about navigation being blocked, then
very likely you are seeing this error.

If possible, configure the app to use a base URL of `''`, literally
the empty string. Then it will send HTTP redirects without
specifying a base URL. If that isn't possible, Sandstorm apps should
look at the `Host:` header for a base URL.

## KeyError: 'getpwuid(): uid not found: 1000'

This is a Python bug. See
[the Python packaging guide](raw-python.md#keyerror-getpwuid-uid-not-found-1000)
for a work-around.

## `EROFS` or "Read-only filesystem"

Only the `/var` directory is writable; the rest of the filesystem (which
contains the contents of your app package) is read-only.

If your app wants to write to locations other than `/var`, and it's not easy to
change the app's code, one work-around is to create a symlink from the location
you app wants to modify to a location under `/var`.  This won't work for all
applications however.

## ETag data

Sandstorm normally allows valid `ETag` headers to pass through to the client. However, the HTTP
standard requires `ETag` values to take a specific form -- for example, they must be quoted. Many
applications incorrectly provide non-quoted values for this header. Sandstorm does not permit
invalid header values because ambiguity can lead to security problems. Therefore, Sandstorm will
drop invalid `ETag` headers and will write a warning to the grain's debug log. Usually, this does
not affect app functionality, other than to reduce the effectiveness of the browser's cache.

In versions v0.176 and earlier, the grain would crash, rather than log an error message, if an
invalid ETag header was emitted by the app.  In more-recent versions, Sandstorm drops the header and
logs a message.

Web apps often use the `ETag` HTTP header to control caching. In Sandstorm, this header is permitted
so long as it follows the HTTP specification's requirement that the header values are formatted with
double-quote marks, like: `ETag: "value"` or `ETag: W/"value"`.

Some apps use strings without quotation marks in their ETag headers, such as `ETag: value`, which
violates the HTTP standard. Sandstorm drops these headers because it is unable to understand the
app's intent.  The headers are dropped within the grain at the
[sandstorm-http-bridge](../using/how-it-works.md) layer.

If an ETag header is dropped, typically the worst-case behavior is that web browsers and other HTTP
clients will refuse to cache a resource and will therefore download the resource more often. This
can waste bandwidth but typically has no impact on app functionality.
