When visitors interact with a Sandstorm grain, they typically see a URL like
https://sandstorm.example.com**/grain/{{grainId}}**. This URL is automatically
provisioned by Sandstorm, and Sandstorm routes requests to this URL to a
specific grain. This document explains how that routing works, how an app author
can control what URL gets displayed, and other ways to route requests to your
app's content.

## Overview: the grain URL (/grain/...) & ephemeral subdomains

When a visitor views a grain, the Sandstorm shell loads and checks if this user
is allowed to view the grain. If the request is authorized, the shell creates an
`IFRAME` that shows the grain's content to the user. Sandstorm adds
[authentication information](auth.md) to the HTTP request before sending it to
the app.

The URL of the IFRAME uses a **random per-session subdomain**. This subdomain is
generated according to this Sandstorm install's `WILDCARD_HOST` configuration
option.

* Example grain URL: https://sandstorm.example.com/grain/TPeYUde5rioE5keWM

* Example ephemeral domain URL: https://96cab9109791f1254002ac1f857ecee7.sandstorm.example.com/

**[Try it now](https://oasis.sandstorm.io/)** by creating a grain and using your
browser's _Inspect Element_ feature to look at the URL of the `IFRAME` element.

**If you need a stable domain name**: the app can **expose static HTML content
to a stable domain name** by using the [static web
publishing](web-publishing.md) feature of Sandstorm. The app can also **[expose
HTTP APIs](http-apis.md)** on a fixed hostname.

Sharing links operate the same way, except they use a `/shared/{{sharingToken}}`
URL pattern.

## Navigating to paths within a grain

Sandstorm respects paths within grains. If a user visits a grain URL with a path appended, or a
fragment (e.g. `#foo`, also known as `location.hash`) appended, Sandstorm passes this through to the
grain.  To be specific:

* Example URL: https://sandstorm.example.com/grain/TPeYUde5rioE5keWM/awesomeinfo#section3

* Example ephemeral domain URL: https://96cab9109791f1254002ac1f857ecee7.sandstorm.example.com/awesomeinfo#section3

The grain user's web browser will show the grain URL (with the path and fragment) in the address
bar. By default, this URL will not change, even as the user clicks around within the app. To address
that, the app can update this URL.

## Updating the URL & page title from your app

By default, when someone interacts with a grain, **the URL and page title stay
fixed** at the grain URL and default grain title. This is because Sandstorm apps
runs in an IFRAME, so the top-level URL and title are not automatically
synchronized as the user navigates within your app. You can `postMessage` to the
Sandstorm shell to ask it to update the URL in the address bar with the
following code snippet:

```js
window.parent.postMessage({'setPath': location.pathname + location.hash}, '*');
```

This will copy the path and fragment from the grain into the browser's address bar.

* Example ephemeral domain URL: https://96cab9109791f1254002ac1f857ecee7.sandstorm.example.com/foo#bar

* URL: https://sandstorm.example.com/grain/TPeYUde5rioE5keWM/foo#bar

The `IFRAME` also prevents the page title from propagating up into the web
browser. You can push the current page's title into the browser's TITLE with
the following Javascript code:

```js
window.parent.postMessage({'setTitle': document.title}, '*');
```

If you're using Meteor or another client-side routing framework, consider
reactively watching the current route and pushing a `postMessage` event on every
navigation. See this [reactive code
sample](https://github.com/Azeirah/brainstorm/blob/ca01c7d2b0ae7f0480b93d7e37e19c82e37c2223/client/routes.js#L73)
and [per-page-load code
sample](https://github.com/paulproteus/semantic-mediawiki-sandstorm/blob/445151c033a85da5e586d1a401abea8179b599b2/resources/src/startup.js#L64).

If you wish to incorporate the grain's title into the page's title, you
can obtain this information by making a postMessage request.

```js
var getGrainTitleRpcId = 0;

// Sandstorm will reply via postMessage, so we need to set up a handler:
window.addEventListener('message', function(event) {
  if(event.source !== window.parent) {
    // SECURITY: ignore messages not from the parent.
    return;
  }
  if(event.data.rpcId === getGrainTtileRpcId) {
    // Set the page title here.
  }
})

// Now make the request:
window.postMessage({
  getGrainTitle: {},
  rpcId: getGrainTitleRpcId,
  // If subscribe is true, sandstorm will push future updates to the
  // grain's title. If it is false or absent, the app will not be
  // notified of updates.
  subscribe: true,
}, '*')
```


## Helping the user share access

If your app wants to **create a link to itself that anyone can use**, you can
trigger Sandstorm's "Share..." dialog with this Javascript code:

```js
window.parent.postMessage({'startSharing': {}}, '*');
```

This shares at the app's default permission level. In the future, we may extend
this API to permit the app to choose a permission level.

If your app wants Sandstorm to display a list of users who have access to the grain, you can
ask Sandstorm to show who has access with this Javascript code:

```js
window.parent.postMessage({'showConnectionGraph': {}}, '*');
```

In the future, as the Powerbox matures, this dialog will likely also show connections between
grains.

## Embedding references to in-app resources, despite the ephemeral domain name

Your app might need to use its current domain name (also known as base URL) for:

* **Redirects**, for example after a user POSTs some data.

* **Static assets** like CSS, images, Javascript.

* **Links within the app**: If a user is on the home page (`/`) of an
  app, and the app wants to create a `href=` link to some other page,
  it needs to know what string to place into the `<a href>` tag.

However, the Sandstorm ephemeral domain only applies to one particular user session of one
particular grain of the app. Given that, your can either use the empty string as the base URL, or it
can generate these URLs as needed, on each request.

### Recommendation: Use the empty string as your base URL

The **easiest** way to handle Sandstorm's dynamic base URL is to use the empty
string (`''`) as your app's base URL. This way, the app needs to make no
decisions at runtime. Many web frameworks support this.

### Detecting the base URL at runtime with `X-Sandstorm-Base-Path`

If your app can't use the empty string as a base URL, you can detect the base URL at runtime during
every request by looking at a HTTP header.

`sandstorm-http-bridge` provides the base URL for this particular request into
the app as an HTTP header: `X-Sandstorm-Base-Path`.

For example, if the user requests the page
`http://7575abdec6caa44bb83df0e00d7d8605.me.sandcats.io:6080/party`, the app
will receive a header of:

```
X-Sandstorm-Base-Path: http://7575abdec6caa44bb83df0e00d7d8605.me.sandcats.io:6080
```

### Details

* **No trailing slash.** This way it is ready for you to add your own path
  e.g. `/party`.

* **Includes the URI scheme.** Therefore, if you need to check if the request is
  coming in over HTTP vs. HTTPS, you can use this header.

* **Can change with every request.** Recall that this value is unsafe to cache
  in a global settings object, since the next request to your grain might use a
  different value.

* **Not sent for API requests.** All app [API requests](http-apis.md) share the
  same base URL, and this can't be used for HTML sent to web browsers, so
  Sandstorm does not send this header on API requests. Additionally, for
  sandboxing reasons, the API token is kept secret from the app.

### Other headers available in Sandstorm

Sandstorm sends a `Host:` header and an `X-Forwarded-Proto` for convenience when
porting apps. A request to
`http://7575abdec6caa44bb83df0e00d7d8605.me.sandcats.io:6080/party` would also
cause an app to receive the following HTTP headers.

* `Host: 7575abdec6caa44bb83df0e00d7d8605.me.sandcats.io:6080`
* `X-Forwarded-Proto: http`

It is therefore OK to look for `X-Forwarded-Proto: https` to detect HTTPS if
being used.

**For API requests**: `sandstorm-http-bridge` does send a `Host` value of
`sandbox` since some apps crash in the absence of a host header. It does not
send a `X-Forwarded-Proto` however.

### Apps operating without sandstorm-http-bridge

`X-Sandstorm-Base-Path` is created from the `WebSession` attribute called
`basePath`. Read the [current
implementation](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/web-session.capnp)
for its Cap'n Proto documentation. Consider also reading the source of
[sandstorm-http-bridge](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/sandstorm-http-bridge.c++#L1033).

### Impact on caching

The fact that Sandstorm apps must send their static assets (such as CSS,
Javascript, and images) on different URLs per session means that a web browser
can't make good use of its cache.

This can have a negative impact on app load time in Sandstorm and mobile data
use when compared to other hosting options. The Cap'n Proto definition of
`WebSession` attribute indicates some possible future work in creating a shared
space in Sandstorm that apps can push these assets to.
