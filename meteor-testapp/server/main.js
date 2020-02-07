import { Meteor } from 'meteor/meteor';

const capnp = Npm.require('capnp');
const { SandstormHttpBridge, AppHooks } =
  capnp.import('/usr/include/sandstorm/sandstorm-http-bridge.capnp');

const appHooks = {
};

const conn = capnp.connect(
  'unix:/tmp/sandstorm-api',
  new capnp.Capability(appHooks, AppHooks),
);

const bridge = conn.restore('', SandstormHttpBridge);

Meteor.startup(() => {
  // code to run on server at startup
});
