import { Meteor } from 'meteor/meteor';

const capnp = Npm.require('capnp');
const { PersistentCallback } = capnp.importSystem('meteor-testapp.capnp');
const { SandstormHttpBridge, AppHooks } = capnp.importSystem('sandstorm/sandstorm-http-bridge.capnp');

class JobCallback {
  constructor(objectId) {
    this.objectId = objectId
  }

  save() {
    console.log("saving: ", this.objectId)
    return { objectId: this.objectId }
  }

  run() {
    console.log("Running callback: ", this.objectId )
    return { cancelFutureRuns: true }
  }
}

const appHooks = {
  restore: function({objectId}) {
    console.log("restoring: ", objectId)
    return { cap: new JobCallback(objectId) }
  },
};

const conn = capnp.connect(
  'unix:/tmp/sandstorm-api',
  new capnp.Capability(appHooks, AppHooks),
);

const bridge = conn.restore(null, SandstormHttpBridge);

Meteor.startup(() => {
  Meteor.methods({
    schedule(job) {
      const callback = new capnp.Capability(
        new JobCallback(job.objectId),
        PersistentCallback,
      );
      bridge.getSandstormApi().api.schedule(
        job.name,
        callback,
        job.schedule,
      );
    }
  })
});
