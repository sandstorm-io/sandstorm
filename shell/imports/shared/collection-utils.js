// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2026 Sandstorm contributors
//
// Small collection helpers for operations that do not have a clear,
// intention-revealing native equivalent. Ordinary mapping, filtering, key
// enumeration, and set operations should continue to use native JavaScript.

import { EJSON } from "meteor/ejson";

function propertyAccessor(iteratee) {
  return typeof iteratee === "function" ? iteratee : (value) => value?.[iteratee];
}

function propertyMatches(value, attributes) {
  return Object.entries(attributes).every(([key, expected]) => value?.[key] === expected);
}

export function pick(object, ...requestedKeys) {
  const keys = requestedKeys.flat();
  return Object.fromEntries(
    keys.filter((key) => key in object)
      .map((key) => [key, object[key]]),
  );
}

export function omit(object, ...rejectedKeys) {
  const rejected = new Set(rejectedKeys.flat());
  const result = {};
  for (const key in object) {
    if (!rejected.has(key)) result[key] = object[key];
  }

  return result;
}

export function findWhere(collection, attributes) {
  return collection.find((value) => propertyMatches(value, attributes));
}

export function where(collection, attributes) {
  return collection.filter((value) => propertyMatches(value, attributes));
}

export function groupBy(collection, iteratee) {
  const getKey = propertyAccessor(iteratee);
  return collection.reduce((result, value, index) => {
    const key = getKey(value, index, collection);
    (result[key] ||= []).push(value);
    return result;
  }, {});
}

export function indexBy(collection, iteratee) {
  const getKey = propertyAccessor(iteratee);
  return collection.reduce((result, value, index) => {
    result[getKey(value, index, collection)] = value;
    return result;
  }, {});
}

export function countBy(collection, iteratee) {
  const getKey = propertyAccessor(iteratee);
  return collection.reduce((result, value, index) => {
    const key = getKey(value, index, collection);
    result[key] = (result[key] || 0) + 1;
    return result;
  }, {});
}

export function sortBy(collection, iteratee) {
  const getKey = propertyAccessor(iteratee);
  return collection.map((value, index) => ({ value, index, criterion: getKey(value) }))
    .sort((left, right) => {
      const leftCriterion = left.criterion;
      const rightCriterion = right.criterion;
      if (leftCriterion !== rightCriterion) {
        if (leftCriterion > rightCriterion || leftCriterion === undefined) return 1;
        if (leftCriterion < rightCriterion || rightCriterion === undefined) return -1;
      }

      return left.index - right.index;
    })
    .map(({ value }) => value);
}

export function difference(collection, excluded) {
  return collection.filter((value) => excluded.indexOf(value) === -1);
}

export function unique(collection) {
  const result = [];
  collection.forEach((value) => {
    if (!result.some(existing => existing === value)) result.push(value);
  });
  return result;
}

export const deepEqual = EJSON.equals;

export function throttle(callback, wait) {
  let previous = 0;
  let timeout;
  let context;
  let args;
  let result;

  const later = () => {
    previous = Date.now();
    timeout = undefined;
    result = callback.apply(context, args);
    context = undefined;
    args = undefined;
  };

  return function throttled(...nextArgs) {
    const now = Date.now();
    const remaining = wait - (now - previous);
    context = this;
    args = nextArgs;
    if (remaining <= 0 || remaining > wait) {
      if (timeout) {
        clearTimeout(timeout);
        timeout = undefined;
      }

      previous = now;
      result = callback.apply(context, args);
      context = undefined;
      args = undefined;
    } else if (!timeout) {
      timeout = setTimeout(later, remaining);
    }

    return result;
  };
}
