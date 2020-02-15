Grains begin life completely isolated from the outside world.
To gain access to external capabilities (or to each other), they need to go through the *powerbox*,
which allows users to mediate and audit any connections that are made.

## Overview

In order to connect to other grains or the outside world, your grain will need to start by making a
"powerbox request". This happens on the client side (in the user's browser). When your grain makes a
request, the user is presented with the Powerbox UI, through which they can decide what to connect
your grain to.

When you make a request, you are not requesting a specific resource, but only a *type* of resource.
The user chooses what resource to use. For example, say you want to connect to the user's calendar
to add calendar events. You don't know the user's calendar's URL. You don't even know what app they
use for their calendar. They might even have multiple calendars. For all these reasons, there is no
way for your app to request access to the specific calendar! Instead, your app merely requests
"a calendar", and then the user chooses (through the Powerbox UI) which one to use. More precisely,
your app will request "an object implementing this particular calendar API".

As a result of this design, the user is never presented with a yes/no security dialog. Sandstorm
does NOT ask: "Is it OK for this app to access your calendar? yes/no" Instead, Sandstorm asks:
"Which calendar should the app use?" If the user chooses a calendar, they are obviously indicating
that they want to grant access, so there is no need for a separate security question.

## Powerbox Descriptors and Queries

When making a powerbox request, you must specify one or more `PowerboxDescriptor`s describing the
APIs / protocols which your application will accept. The user will be presented with a list of
options known to match at least one of the descriptors you specified.

The `PowerboxDescriptor` format -- and how to use it in queries -- is described in
[powerbox.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/powerbox.capnp).

Queries are made by sending a `postMessage()` to the grain's parent frame inside the browser. The
query itself is passed as one or more strings, each of which is a base64'd, serialize-packed,
Cap'n-Proto message of type `PowerboxDescriptor`.

Since there is currently no in-browser implementation of Cap'n Proto, typically the easiest way to
create a descriptor is to construct your query in advance and then embed the raw string directly
into your code. To construct a query, you might create a Cap'n Proto file like this:

```capnp
# my-query.capnp

@0x9759ad011d40ab4c;  # generated using `capnp id`

using Powerbox = import "/sandstorm/powerbox.capnp";
using ApiSession = import "/sandstorm/api-session.capnp".ApiSession;

# We're constructing a PowerboxDescriptor for an HTTP API, which uses the
# ApiSession interface. Hence, our descriptor will have one tag. The tag's
# ID is the Cap'n Proto type ID for `ApiSession` (as declared in
# api-session.capnp using the @-sign after the type name). The tag's value
# is a struct of type `ApiSession.PowerboxTag`, since `ApiSession` documents
# that this is the appropriate tag value type to use when requesting an
# `ApiSession`.

const myTagValue :ApiSession.PowerboxTag = (
  canonicalUrl = "https://apidata.googleusercontent.com/caldav/v2",
  # We're requesting an API compatible with Google Calendar API version 2.
  #
  # (See the definition of `ApiSession.PowerboxTag` in `api-session.capnp`
  # for more about the meaning of `canonicalUrl`.)
);

const myDescriptor :Powerbox.PowerboxDescriptor = (
  # Our descriptor has one tag, whose ID is `ApiSession`'s type ID, and
  # whose value is the tag value defined above.
  tags = [
    (id = 0xc879e379c625cdc7, value = .myTagValue)
  ],
);
```

Once you've created a file like `my-query.capnp` (above), you can generate the powerbox descriptor
with a shell command like so:

```bash
capnp eval -I/opt/sandstorm/latest/usr/include -p \
    my-query.capnp myDescriptor | \
    base64 -w0
```

(Note that if you are using `vagrant-spk`, you will need to SSH into the VM to run this command.)

Let's break down what that command is doing:

* `capnp eval`: This says that we want to "evaluate" a constant declared in a `.capnp` file, and
  output its value.
* `-I/opt/sandstorm/latest/usr/include`: This tells the `capnp` tool to look for imports in the
  Sandstorm isntall location. This is needed to import `/sandstorm/powerbox.capnp`, etc.
* `-p`: Requests that the value be output in Cap'n Proto packed binary format.
* `my-query.capnp myDescriptor`: Specifies that the value we want to output is the constant named
  `myDescriptor` in the file `my-query.capnp`.
* `| base64 -w0`: Base64-encodes the output from `capnp eval`. `-w0` specifies no wrapping
  (otherwise, `base64` will insert line breaks every 76 characters).

The output, in this case, is:

```text
EA9QAQEAABEBF1EEAQH/x80lxnnjecgAQAMxCYIBAAH/aHR0cHM6Ly8FYXBpZGF0YS5nb29nbGV1c2VyY29udGVudC5jb20vY2FsZGF2L3YyAA==
```

This is your descriptor string, to use in your query.

## Making the request

You may initiate a powerbox request by `postMessage()` to the app's parent frame (which is Sandstorm).

```js
window.parent.postMessage({
  powerboxRequest: {
    rpcId: 1,
    query: [
      "EA9QAQEAABEBF1EEAQH/x80lxnnjecgAQAMxCYIBAAH/aHR0cHM6Ly8FYXBpZGF0YS5nb29nbGV1c2VyY29udGVudC5jb20vY2FsZGF2L3YyAA=="
    ],
    saveLabel: {defaultText: "your calendar, for adding events"},
  }
}, "*");
```

* `rpcId` should be different for every request, but can be any value you want.
* `query` is a list of descriptor strings, generated using the instructions in the previous section.
* `saveLabel` is some human-readable text which Sandstorm will show to the user later on, when they
  audit the grain's connections. If the grain is still connected to this API, then the user will be
  able to see this, see the label, and revoke the connection if desired.

Once the user completes the request, your app will receive a return `postMessage`. You will need to
listen for this like so:

```js
window.addEventListener("message", function (event) {
  if (event.source !== window.parent) {
    // SECURITY: ignore postMessages that didn't come from the parent frame.
    return;
  }

  var response = event.data;

  if (response.rpcId !== 1) {
    // Ignore RPC ID that dosen't match our request. (In real code you'd
    // probably have a table of outstanding RPCs so that you don't have to
    // register a separate handler for each one.)
    return;
  }

  if (response.error) {
    // Oops, something went wrong.
    alert(response.error);
    return;
  }

  if (response.canceled) {
    // The user closed the Powerbox without making a selection.
    return;
  }

  // We now have a claim token. We need to send this to our server
  // where we can exchange it for access to the remote API!
  doClaimToken(response.token);
});
```

At the end of the event handler above, we've received a claim token. This token can be
redeemed on the server side in order to get access to the API. You will need to send the token
to your app's server, e.g. using `XmlHTTPRequest`.

## Redeeming the claim token

Once the claim token has been sent to your app's server, you need to redeem it. In the general
case, you can use the raw Cap'n Proto APIs to do this, but sandstorm-http-bridge implements
special support for using http APIs obtained via the powerbox.

### Using sandstorm-http-bridge for HTTP APIs.

Most apps use sandstorm-http-bridge to avoid the need to use Sandstorm's raw Cap'n Proto
interfaces just to offer a web interface. If you aren't sure whether you are using http-bridge,
you probably are.

If you want to use the powerbox to access something *other than an HTTP API*, you will need to
use the raw Cap'n Proto APIs, see below.

HTTP APIs are represented by the `ApiSession` Cap'n Proto type.  (The query examples above
request this type.)

When using http-bridge, the bridge sets up a private HTTP proxy which your app can use to make
outgoing requests. http-bridge sets the `HTTP_PROXY` and `http_proxy` environment variables to
point at this proxy. Many HTTP client libraries respect these variables automatically, but you
will need to check the documentation for your HTTP library to be sure. (Beware: Some libraries
have been known to claim they respect this variable but not actually do so in practice; if you
have trouble, try explicitly telling your HTTP library to use a proxy.)

Once you have your claim token, the first step is to exchange it for an access token. The claim
token is only valid for the user's current session, but the access token is valid forever. In
order to redeem your claim token, you need to know the user's session ID, which is found in the
`X-Sandstorm-Session-Id` header on incoming requests.

You will need to make an HTTP request like:

```http
POST http://http-bridge/session/<session-id>/claim
Content-Type: application/json

{
  "requestToken": "<claim-token>",
  "requiredPermissions": [<permissions>]
}
```

Replace `<session-id>` with the user's session ID, and `<claim-token>` with the claim token sent
from the client.

`requiredPermissions` is a list of names of permissions (as defined in your
`sandstorm-pkgdef.capnp`) which the user is required to have in order to make this connection.
E.g. if you've defined permissions named `read` and `write`, then you might have
`"requiredPermissions": ["read"]` to require read permission but not write permission. If the
user who made the powerbox request ever loses one of the required permissions -- or has their
access to this grain revoked entirely -- then the connection to the remote API will be
automatically revoked. This ensures that revoked users cannot continue to manipulate the grain
through powerbox connections they created when they still had access.

The `/claim` request will return a JSON response like:

```json
{
  "cap": "YmpfV2g2VmhMMzM4eXZ5bTdwMWJzR0xvdHVqdHd2YmFTTGRiOFZzQ3BETA=="
}
```

The `cap` value is your access token.

Here's an example of using `/claim` in Node.js using the popular `request` NPM package:

```js
var claimToken = requestFromUser.body.claimToken;
var sessionId = requestFromUser.headers["x-sandstorm-session-id"];

request({
  proxy: process.env.HTTP_PROXY,
  method: "POST",
  url: "http://http-bridge/session/" + sessionId + "/claim",
  json: {
    requestToken: claimToken,
    requiredPermissions: ["read"]
  }
}, (err, httpResponse, body) => {
  if (err) {
    console.error(err);
  } else {
    saveAccessToken(body.cap);
  }
});
```

Once you have an access token, you can make HTTP requests to the remote API through the bridge
proxy. To do so, set the `Authorization` header:

```http
Authorization: Bearer <access-token>
```

When you set this header, your requests will be routed to the appropriate API. The hostname to
which you address your requests is ignored and can be anything; only the `Authorization` header
matters.

### Raw Cap'n Proto APIs

If your app uses raw Cap'n Proto APIs (not http-bridge), or you want to use something other than
an HTTP api, then the definitive reference for the powerbox's interfaces is the Cap'n Proto
schema files where they are defined. The main relevant schemas are
[powerbox.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/powerbox.capnp)
and [grain.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp).
If you are using the bridge, you will also want to read about the interfaces in
[sandstorm-http-bridge.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/sandstorm-http-bridge.capnp),
which allow bridge apps to access the resources otherwise accessed via the interfaces in
`grain.capnp`.

In order to exchange your claim token for a capability, you'll need to invoke
`SessionContext.claimRequest()` on the session context associated with the session where the
powerbox request took place. This will return a live capability, which will implement the interface
type you requested (in our example, `ApiSession`). You can start making calls on it, but usually,
you will want to first call `SandstormApi.save()` to obtain a token which you can use to restore
this capability later, e.g. during a future run of your app. You can't just hold on to the claim
token, because the claim token can only be redeemed against the specific session from which it
came. `save()` gives you a token that can be redeemed using `SandstormApi.restore()` at any time.

## Exporting an API

Your app can also export APIs for consumption by other apps. If you do so, then grains of your
app will appear as options in the user's powerbox when another app makes a request for an API
that your app provides.

How to export APIs depends on (1) whether your app uses sandstorm-http-bridge and (2)
whether you are exporting an HTTP API or some other Cap'n Proto interface.

### Using sandstorm-http-bridge

If you use sandstorm-http-bridge, then you can export HTTP APIs (which implement
the Cap'n Proto `ApiSession`) using the bridge's special handling, allowing you to use
a regular web server just like with the web UI for your app. You can declare APIs that
you export in your `sandstorm-pkgdef.capnp` file, in the `bridgeConfig` section, by
specifying a list of `powerboxApis`. Example:

```capnp
  bridgeConfig = (
    powerboxApis = [
      (
        name = "calendar-read",
        displayInfo = (
          title = (defaultText = "Read-only access to calendar"),
        ),
        path = "/calendar",
        tag = (
          canonicalUrl = "https://apidata.googleusercontent.com/caldav/v2"
        ),
        permissions = [true, false],  # read, not write
      ),
      (
        name = "calendar-modify",
        displayInfo = (
          title = (defaultText = "Full access to calendar"),
        ),
        path = "/calendar",
        tag = (
          canonicalUrl = "https://apidata.googleusercontent.com/caldav/v2"
        ),
        permissions = [true, true],  # read and write
      ),
    ],

    saveIdentityCaps = true,
    # You must enable this option when exporting APIs.
  )
```

Complete details of the `powerboxApis` config setting are documented under
`BridgeConfig.PowerboxApi` in
[package.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/package.capnp).

Your app can export multiple APIs. These may be entirely different APIs or they may be different
permissions levels of the same API. If a powerbox request matches multiple APIs, and the user
chooses a grain of your app to satisfy the request, then they will be presented with a choice of
which API to use, with options labeled using `displayInfo`.

It is also possible to export Cap'n Proto interfaces other than HTTP APIs when
using the bridge. The process is the same as discussed for "Raw Cap'n Proto APIs," below, except
that:

1. You need to use the interfaces in `sandstorm-http-bridge.capnp` to access the session context,
   provide the view info for your app, etc.
2. Rather than implementing separate methods for `newSession`, `newRequestSession`, and so on,
   you should look at the `X-Sandstorm-Session-Type` header to determine what kind of session
   you are in.
   - If the header's value is `normal`, then you are not in any kind of powerbox session; this
     is just a regular UI session.
   - If the header's value is `request`, then you are in a request session. You should display
     a UI for picking which resource to provide, and use the methods described in
     `sandstorm-http-bridge.capnp` to fetch info about the powerbox request and fulfill it.
   - If the value is `offer`, this is an offer session; your app is being offered a capability by
     another app, based on the information in your view info's `matchOffers` field. You can
     display a UI to decide what to do with it, and use the bridge's methods to access the
     capability itself.

### Raw Cap'n Proto APIs

When implementing an app against raw Cap'n Proto APIs, you have much more freedom. Not only can you
export any Cap'n Proto interface, but you can implement an arbitrary picker UI which will be
embedded into the Powerbox UI and displayed when your app is chosen.

To advertise that your app implements a powerbox API, the `ViewInfo` returned by your
`UiView.getViewInfo()` must fill in the `matchRequests` field to indicate what queries it should
match. If a powerbox query matches one of the descirptors you specify, your grain will be displayed
as an option in the powerbox UI. See `UiView.ViewInfo` in
[grain.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp).

When a grain of your app is chosen, the powerbox will display your app's UI embedded inside the
powerbox UI. For this context, Sandstorm invokes your app's `UiView.newRequestSession()` instead
of the usual `UiView.newSession()`. Thus, your app can display a completely different UI in this
case.

Your powerbox request UI should implement a picker or configuration dialog which allows the user
to specify exactly what they want your app to return. Once the user has made their choice, your
app calls `SessionContext.fulfillRequest()` on the user's session object, passing it a capability
that fulfills the request.

The capability that you pass to `fulfillRequest()` MUST implement the `AppPersistent` interface
(defined in [grain.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp)),
which allows it to be saved persistently and restored again later.

## Special powerbox request types

Sandstorm special-cases several APIs which you can request through the powerbox, such that the
user is given additional choices not implemented by any other grain.

Currently, all of these require you to use the raw Cap'n Proto interfaces (although apps that
use sandstorm-http-bridge can access raw Cap'n Proto APIs too; see
[sandstorm-http-bridge.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/sandstorm-http-bridge.capnp)).

A common thing that a grain might want to request is network access, the
corresponding interfaces for which are defined in
[ip.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/ip.capnp).
[Here is an example app in Python](https://github.com/sandstorm-io/sandstorm-test-python)
which (among other things) knows how to request an `IpNetwork`.

One app that heavily depends on the powerbox is the [Collections
app](https://github.com/sandstorm-io/collections-app).  Here's a brief
outline of how the app interacts with the powerbox:

1. A collection makes a powerbox request for a UiView capability. ([code link](https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/main.jsx#L118))

2. The collection calls `claimRequest()` on the returned token, and then calls `save()` on the returned capability. ([code link](https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/src/server.rs#L746-L769))

3. When the collection wants to use the capability, it calls `restore()` to get a live reference. ([code link](https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/src/server.rs#L263))

4. With this live reference, it can get grain metadata through `getViewInfo()`. ([code link](https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/src/server.rs#L268))

5. The collection can also offer this live reference to the user through `offer()`, which opens the grain without opening a new browser tab. ([code link](https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/src/server.rs#L683))

