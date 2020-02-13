@0x95851df2c1773058;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "/sandstorm/grain.capnp";
using Bridge = import "/sandstorm/sandstorm-http-bridge.capnp";

interface PersistentCallback extends (Grain.ScheduledJob.Callback, Grain.AppPersistent(Text)) {}

interface TestAppAppHooks extends (Bridge.AppHooks(Text)) {}
