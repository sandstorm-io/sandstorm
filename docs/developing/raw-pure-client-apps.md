# Porting pure client apps

Apps which are designed to do all work on the client side (in the
browser) are particularly easy to port to Sandstorm. Apps written in
the [Unhosted](https://unhosted.org) style or using
[remoteStorage](http://remotestorage.io/) generally fall into this
category.

For such apps, we recommend basing your server on our [Raw API
Example](https://github.com/sandstorm-io/sandstorm-rawapi-example). In
fact, you can likely fork that code and use it nearly verbatim; just
drop your client-side HTML, CSS, and Javascript into the `client`
directory and adjust your code to do storage via HTTP GET/PUT/DELETE
requests under `/var`.

Keep in mind that each Sandstorm app instance should represent a
single "document", or otherwise the minimal unit of data that a user
might want to share independently. So, if your app currently features
"save" and "load" actions that ask for a location, remove that, and
instead automatically save to a hard-coded location under `/var`.

## Caveat: Collaboration

The downside of pure-client apps is that they are hard to make
collaborative. If multiple users open a file at once, they will likely
clobber each other's changes. Once your app is on Sandstorm, you may
want to consider extending it for collaboration by implementing a
WebSocket connection that receives an event stream from other
clients. In the server code, you will need to extend `WebSessionImpl`
to override the `openWebSocket()` method of `WebSession`. Feel free to
ask [sandstorm-dev](https://groups.google.com/group/sandstorm-dev) if
you need help.