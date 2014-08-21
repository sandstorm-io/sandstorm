'use strict';

exports.command = function(callback) {
  if (typeof callback !== "function") {
    throw new Error("Must pass a callback");
  }
  if (this.sandstormAccount === 'demo') {
    return this.status(callback);
  } else {
    return this.status();
  }
};
