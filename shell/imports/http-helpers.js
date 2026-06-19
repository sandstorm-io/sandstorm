import { HTTP } from "meteor/http";

function httpCallAsync(method, url, options) {
  return new Promise((resolve, reject) => {
    HTTP.call(method, url, options || {}, (err, response) => {
      if (err) reject(err);
      else resolve(response);
    });
  });
}

export { httpCallAsync };
