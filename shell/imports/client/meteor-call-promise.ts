import { Meteor } from "meteor/meteor";


export function meteorCallPromise(method: string, arg: any): Promise<any> {
  // Thin wrapper around Meteor.call that returns a promise instead of accepting
  // a callback for the result.

  return new Promise((resolve, reject) => {
    Meteor.call(method, arg, (err: Error, result: any) => {
      if(err) {
        reject(err);
      } else {
        resolve(result);
      }
    });
  })
}
