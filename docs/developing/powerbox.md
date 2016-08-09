Grains begin life completely isolated from the outside world.
To gain access to external capabilities, they need to go through the *powerbox*,
which allows users to mediate and audit any connections that are made.

The definitive reference for the powerbox's interfaces
is the Cap'n Proto schema files where they are defined. The main relevant schemas are
[powerbox.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/powerbox.capnp),
[grain.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/grain.capnp),
and
[identity.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/identity.capnp).

A common thing that a grain might want to request is network access, the
corresponding interfaces for which are defined in
[ip.capnp](https://github.com/sandstorm-io/sandstorm/blob/master/src/sandstorm/ip.capnp).
[Here is an example app in Python](https://github.com/sandstorm-io/sandstorm-test-python)
which (among other things) knows how to request an `IpNetwork`.

One app that heavily depends on the powerbox is the
[Collections app](https://github.com/sandstorm-io/collections-app).
Here's a brief outline of how the it interacts with the powerbox:

  1. A collection makes a powerbox request for a UiView capability: https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/main.jsx#L118

  2. The collection calls `claimRequest()` on the returned token, and then calls `save()` on the returned capability: https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/src/server.rs#L746-L769

  3. When the collection wants to use the capability, it calls `restore()` to get a live reference: https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/src/server.rs#L263

  4. With this live reference, it can get grain metadata through `getViewInfo()`: https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/src/server.rs#L268

  5. The collection can also offer this live reference to the user through `offer()`, which opens the grain without opening a new browser tab: https://github.com/sandstorm-io/collections-app/blob/7129ce9ebb6cf9ed5fcbd3588cf98937557ebe28/src/server.rs#L683
