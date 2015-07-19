A Sandstorm app can export an HTTP-based API to the internet. This is
useful for:

* Allowing a mobile client app to connect to a Sandstorm server.

* Allowing static web pages to interact with Sandstorm servers. (For
  instance, this could be used to implement comments on a blog
  published via [Sandstorm's web
  publishing](https://github.com/sandstorm-io/sandstorm/wiki/Publishing-to-the-user%27s-domain)
  -- posting a comment would make an API request.)

* Federation between servers.

* Many other things!

All APIs for all apps on a particular Sandstorm server are served from
the same hostname -- for instance, the Sandstorm Alpha server serves
APIs from https://alpha-api.sandstorm.io. The specific API to which a
request is addressed is determined by examining the `Authorization`
header. The header must be of the form:

    Authorization: Bearer <token>

The specific value of `<token>` both determines the specific app
instance to which the request is addressed as well as authorizes the
caller to send requests to that app.

Because an `Authorization` header is required, it is impossible for a
web browser to open a Sandstorm HTTP API directly in a browser
window. This is intentional: this prevents Sandstorm apps from
executing arbitrary scripts from the API host.

There are various ways to obtain an API key:

* The user can click the key icon in the top bar when they have an app
  open.

* The app itself can make a call to
  `HackSessionContext.generateApiToken()`. See the [web publishing
  guide](https://github.com/sandstorm-io/sandstorm/wiki/Publishing-to-the-user%27s-domain)
  for more about how to access `HackSessionContext`.

* In the future, we will implement an OAuth flow allowing a third
  party to initiate a request for access to the user's apps.

Either approach results in a
[webkey](http://waterken.sourceforge.net/web-key/), which is a
combination of an endpoint URL and a key separated by a `#`, such as:

    https://alpha-api.sandstorm.io#49Np9sqkYV4g_FpOQk1p0j1yJlvoHrZm9SVhQt7H2-9

(This format is intentionally chosen to look like a valid URL that
could be opened in a browser. Eventually, when such a URL is loaded
directly in a browser, Sandstorm will show the user information about
the API and possibly offer the ability to explore the API and initiate
requests for debugging purposes. As of this writing, these features
are not yet implemented.)

The part of the webkey before the `#` is the API endpoint for the
server (in this case, for alpha.sandstorm.io). After the `#` is the
API token. So, to make a request to the webkey specified above, you
might use the following `curl` command:

    curl -H "Authorization: Bearer 49Np9sqkYV4g_FpOQk1p0j1yJlvoHrZm9SVhQt7H2-9" https://alpha-api.sandstorm.io

The HTTP request will then be forwarded to the app. Note that cookies
will NOT be forwarded, and any cookies returned by the app will be
dropped.

The API endpoint is set up to allow cross-origin requests from any
origin, which means you can access an API from `XMLHttpRequest` on any
domain.