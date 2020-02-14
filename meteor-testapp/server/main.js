import { Meteor } from 'meteor/meteor';

const capnp = Npm.require('capnp');
const { PersistentCallback, TestAppAppHooks } = capnp.importSystem('meteor-testapp.capnp');
const { SandstormHttpBridge } = capnp.importSystem('sandstorm/sandstorm-http-bridge.capnp');


const makeCallback = (objectId) => {
  const cb = {
    save() {
      console.log("saving:", objectId)
      return { objectId }
    },

    run() {
      console.log("Running callback:", objectId )
      return { cancelFutureRuns: true }
    }
  }
  return new capnp.Capability(cb, PersistentCallback);
}

const appHooks = {
  restore(objectId) {
    console.log("restoring:", objectId)
    return { cap: makeCallback(objectId) }
  },
};

const conn = capnp.connect(
  'unix:/tmp/sandstorm-api',
  new capnp.Capability(appHooks, TestAppAppHooks),
);

const bridge = conn.restore(null, SandstormHttpBridge);

Meteor.startup(() => {
  Meteor.methods({
    schedule(objectId) {
      bridge.getSandstormApi().api.schedule(
        { defaultText: 'test job' },
        makeCallback(objectId),
        { periodic: 'hourly' }
      );
    }
  })
});
