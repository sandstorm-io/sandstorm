@0x95851df2c1773058;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "/sandstorm/grain.capnp";
using Bridge = import "/sandstorm/sandstorm-http-bridge.capnp";

interface PersistentCallback extends (Grain.ScheduledJob.Callback, Grain.AppPersistent(Text)) {}
# Joining interface so we can export an object that is both a Callback
# and AppPersistent (with Text as our ObjectId).

interface TestAppAppHooks extends (Bridge.AppHooks(Text)) {}
# Interface which specializes AppHooks's type parameter to Text, which is our
# ObjectId type.
