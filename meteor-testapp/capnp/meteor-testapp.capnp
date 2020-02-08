@0x95851df2c1773058;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "/sandstorm/grain.capnp";

interface PersistentCallback extends (Grain.ScheduledJob.Callback, Grain.AppPersistent(Text)) {}
