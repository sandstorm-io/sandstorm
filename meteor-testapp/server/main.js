import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";

// Staged alongside Node, using the same native module as the Sandstorm shell.
const capnp = Npm.require("/node_modules/capnp.js");
const { PersistentCallback, TestAppAppHooks } = capnp.importSystem("meteor-testapp.capnp");
const { SandstormHttpBridge } = capnp.importSystem("sandstorm/sandstorm-http-bridge.capnp");

function makeCallback(objectId) {
  return new capnp.Capability({
    save() {
      console.log("saving:", objectId);
      return { objectId };
    },
    run() {
      console.log("Running callback:", objectId);
      return { cancelFutureRuns: true };
    },
  }, PersistentCallback);
}

const connection = capnp.connect("unix:/tmp/sandstorm-api", new capnp.Capability({
  restore(objectId) {
    console.log("restoring:", objectId);
    return { cap: makeCallback(objectId) };
  },
}, TestAppAppHooks));
const bridge = connection.restore(null, SandstormHttpBridge);
const api = bridge.getSandstormApi().api;

Meteor.methods({
  getServerRuntime() {
    return process.env.SERVER_RUNTIME;
  },
  async schedule(objectId) {
    check(objectId, String);
    const callback = makeCallback(objectId);
    try {
      // The test must not shut down the grain until the callback has been saved.
      await api.schedule({ defaultText: "AppHooks test job" }, callback, { periodic: "hourly" });
    } finally {
      callback.close();
    }
  },
});
