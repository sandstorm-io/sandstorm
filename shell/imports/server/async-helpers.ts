import { Meteor } from "meteor/meteor";
import Future from "fibers/future";

let inMeteorListener: (() => void) | undefined = undefined;

function onInMeteor(callback: (() => void)) {
  inMeteorListener = callback;
}

// Meteor context <-> Async Node.js context adapters
const inMeteorInternal = Meteor.bindEnvironment((callback: () => void) => {
  callback();
});

function inMeteor<T>(callback: () => T): Promise<T> {
  if (inMeteorListener) {
    inMeteorListener();
  }

  // Calls the callback in a Meteor context.  Returns a Promise for its result.
  return new Promise((resolve, reject) => {
    inMeteorInternal(() => {
      try {
        resolve(callback());
      } catch (err) {
        reject(err);
      }
    });
  });
}

function promiseToFuture<T>(promise: Promise<T>): Future<T> {
  const result = new Future<T>();
  promise.then(result.return.bind(result), result.throw.bind(result));
  return result;
}

function waitPromise<T>(promise: Promise<T>): T {
  return promiseToFuture(promise).wait();
}

export { inMeteor, promiseToFuture, waitPromise, onInMeteor };
