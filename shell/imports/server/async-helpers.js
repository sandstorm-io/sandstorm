import { Meteor } from "meteor/meteor";

const Future = Npm.require("fibers/future");

// Meteor context <-> Async Node.js context adapters
const inMeteorInternal = Meteor.bindEnvironment((callback) => {
  callback();
});

const inMeteor = (callback) => {
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
};

const promiseToFuture = (promise) => {
  const result = new Future();
  promise.then(result.return.bind(result), result.throw.bind(result));
  return result;
};

const waitPromise = (promise) => {
  return promiseToFuture(promise).wait();
};

export { inMeteor, promiseToFuture, waitPromise };
