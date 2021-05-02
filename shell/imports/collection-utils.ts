// Misc. utilities for working with meteor collections.

import { Subscription } from "meteor/meteor";
import { Mongo } from "meteor/mongo";

export function subscriptionCallbacks<T extends {_id: string}>(
    name: string,
    sink: Subscription,
): Mongo.ObserveCallbacks<T> {
  // Return a set of observe callbacks that forward changes to a `Subscription`.
  return {
    added(item) {
      sink.added(name, item._id, item);
    },

    changed(next, _prev) {
      sink.changed(name, next._id, next);
    },

    removed(item) {
      sink.removed(name, item._id);
    },
  }
}

export function filterCallbacks<T extends {_id: string}>(
    sink: Mongo.ObserveCallbacks<T>,
    pred: (v: T) => boolean,
): Mongo.ObserveCallbacks<T> {
  // Return a set of observe callbacks that filters out items not satisfied
  // by `pred` before pushing them into `sink`.
  return {
    added(item) {
      if(!sink.added) return;

      if(pred(item)) {
        sink.added(item);
      }
    },

    changed(next, prev) {
      const predNext = pred(next);
      const predPrev = pred(prev);
      if(predNext && predPrev) {
        if(sink.changed) {
          sink.changed(next, prev)
        }
      } else if(predNext && !predPrev) {
        if(sink.added) {
          sink.added(next);
        }
      } else if(!predNext && predPrev) {
        if(sink.removed) {
          sink.removed(prev);
        }
      }
    },

    removed(item) {
      if(!sink.removed) return;

      if(pred(item)) {
        sink.removed(item);
      }
    },
  };
}
