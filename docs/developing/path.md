Sandstorm apps live at ephemeral URLs. This page documents the
details.

## Web URLs

When a Sandstorm grain is running, Sandstorm uses a different URL for
each session. This means even for a single grain, each different user
visiting the site will have a different base URL. There isn't a stable
URL like `https://myapp.me.sandcats.io/` for an app to use.

Your app might need to use these URLs for:

* **Redirects**: the app might need to generate redirects, for example
  after a user POSTs some data.

* **Static assets**: the app might have CSS, images, Javascript, or
  other files that are required for a visitor to successfully load a
  page.

* **Links within the app**: If a user is on the home page (`/`) of an
  app, and the app wants to create a `href=` link to some other page,
  it needs to know what string to place into the `<a href>` tag.

### Recommendation: Use the empty string as your base path

The **easiest** way to handle Sandstorm's dynamic base path is to
use the empty string (`''`) as your app's base path. This way,
the app needs to make no decisions at runtime.

Many web frameworks support this.

If you can't use the empty string, you can detect the base path at
runtime for every request.

### Alternative: `X-Sandstorm-Base-Path`

`sandstorm-http-bridge` provides the base URL for this particular
request into the app as an HTTP header: `X-Sandstorm-Base-Path`.

For example, if the user requests the page
`http://7575abdec6caa44bb83df0e00d7d8605.me.sandcats.io:6080/party`,
the app will receive a header of:

```
X-Sandstorm-Base-Path: http://7575abdec6caa44bb83df0e00d7d8605.me.sandcats.io:6080
```

### Details

* **No trailing slash.** This way it is ready for you to add your own
  path e.g. `/party`.

* **Includes the URI scheme.** Therefore, if you need to check if the
  request is coming in over HTTP vs. HTTPS, you can use this header.

* **Can change with every request.** Recall that this value is unsafe
  to cache in a global settings object, since the next request to your
  grain might use a different value.

* **Not sent for API requests.** All app [API requests](http-apis.md)
  share the same HTTP base domain, and this can't be used for HTML
  sent to web browsers, so Sandstorm does not send this header on API
  requests. Additionally, for sandboxing reasons, the API token is
  kept secret from the app.

### Other headers available in Sandstorm

Sandstorm sends a `Host:` header and an `X-Forwarded-Proto` for
convenience when porting apps. A request to
`http://7575abdec6caa44bb83df0e00d7d8605.me.sandcats.io:6080/party`
would also cause an app to receive the following HTTP headers.

* `Host: 7575abdec6caa44bb83df0e00d7d8605.me.sandcats.io:6080`
* `X-Forwarded-Proto: http`

It is therefore OK to look for `X-Forwarded-Proto: https` to detect
HTTPS if needed.

**For API requests**: `sandstorm-http-bridge` does send a `Host` value
of `sandbox` since some apps crash in the absence of a host header. It
does not send a `X-Forwarded-Proto` however.

## Apps operating without sandstorm-http-bridge

`X-Sandstorm-Base-Path` is created from the `WebSession` attribute
called `basePath`. Read the [current
implementation](https://github.com/sandstorm-io/sandstorm/blob/71fd830f0f1ac9fd1b759e4492eb70dabe001c48/src/sandstorm/web-session.capnp)
for its Cap'n Proto documentation. Consider also reading the source of
[sandstorm-http-bridge](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/sandstorm-http-bridge.c++#L1033).

## Appendix: Impact on caching

The fact that Sandstorm apps must send their static assets (such as
CSS, Javascript, and images) on different URLs per session means that
a web browser can't make good use of its cache.

This can have a negative impact on app load time in Sandstorm and
mobile data use when compared to other hosting options. The Cap'n
Proto definition of `WebSession` attribute indicates some possible
future work in creating a shared space in Sandstorm that apps can push
these assets to.
