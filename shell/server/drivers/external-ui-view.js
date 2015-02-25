// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

var Future = Npm.require("fibers/future");
var Promise = Npm.require("es6-promise").Promise;
var Capnp = Npm.require("capnp");
var Url = Npm.require("url");
var Http = Npm.require("http");
var Https = Npm.require("https");
var ApiSession = Capnp.importSystem("sandstorm/api-session.capnp").ApiSession;

var removeTrailingSlash = function (path) {
  if (path.indexOf("/", path.length - 1) === -1) {
    return path;
  }

  return path.slice(0, path.length - 1);
};

WrappedUiView = function (token, proxy, path) {
  // TODO(someday): handle the fact that these proxies will be garbage collected every 2 minutes,
  // even if it's in use.
  this.token = token;
  this.proxy = proxy;
  this.path = path;
};

WrappedUiView.prototype.newSession = function (userInfo, context, sessionType, sessionParams, retryCount) {
  if (sessionType !== ApiSession.typeId) {
    throw new Error("SessionType must be ApiSession.");
  }

  retryCount = retryCount || 0;
  var self = this;

  return this.proxy.keepAlive().then(function () {
    // ignore the passed userInfo and instead use the one associated with this token
    // TODO(someday): handle permissions from the viewInfo
    var session = self.proxy.uiView.newSession(
        self.proxy.userInfo, context, sessionType, sessionParams).session.castAs(ApiSession);
    return {session: new Capnp.Capability(new WrappedApiSession(session, self.path), ApiSession)};
  }).catch(function (error) {
    return self.proxy.maybeRetryAfterError(error, retryCount).then(function () {
      return self.newSession(userInfo, context, sessionType, sessionParams, retryCount + 1);
    });
  });
};

WrappedApiSession = function (session, path) {
  this.session = session;
  this.path = removeTrailingSlash(path);
};

WrappedApiSession.prototype._makePath = function (path) {
  return this.path + path;
};

WrappedApiSession.prototype.get = function (path, context) {
  return this.session.get(this._makePath(path), context);
};

WrappedApiSession.prototype.post = function (path, content, context) {
  return this.session.post(this._makePath(path), content, context);
};

WrappedApiSession.prototype.put = function (path, content, context) {
  return this.session.put(this._makePath(path), content, context);
};

WrappedApiSession.prototype.delete = function (path, context) {
  return this.session.delete(this._makePath(path), context);
};

getWrappedUiViewForToken = function (token, path) {
  var proxyPromise = getProxyForApiToken(token);

  return proxyPromise.then(function (proxy) {
    return {view: new WrappedUiView(token, proxy, path)};
  });
};

ExternalUiView = function (url, grainId, token) {
  this.url = url;
  this.grainId = grainId;
  this.token = token;
};

ExternalUiView.prototype.newSession = function (userInfo, context, sessionType, sessionParams) {
  if (sessionType !== ApiSession.typeId) {
    throw new Error("SessionType must be ApiSession.");
  }

  var options = {};

  if (this.token) {
    options.headers = {
      authorization: "Bearer " + this.token
    };
  }

  return {session: new Capnp.Capability(new ExternalWebSession(this.url, this.grainId, options), ApiSession)};
};

ExternalWebSession = function (url, grainId, options) {
  var parsedUrl = Url.parse(url);
  this.host = parsedUrl.hostname;
  this.port = parsedUrl.port;
  this.protocol = parsedUrl.protocol;
  this.path = removeTrailingSlash(parsedUrl.path);
  this.grainId = grainId;
  this.options = options || {};
};

var responseCodes = {
  200: {type: "content", code: "ok"},
  201: {type: "content", code: "created"},
  202: {type: "content", code: "accepted"},
  204: {type: "noContent", shouldResetForm: false},
  205: {type: "noContent", shouldResetForm: true},
  // 206: {type: "noContent"},
  // 300: {type: "redirect"},
  301: {type: "redirect", switchToGet: true, isPermanent: true},
  302: {type: "redirect", switchToGet: true, isPermanent: false},
  303: {type: "redirect", switchToGet: true, isPermanent: false},
  // 304: {type: "redirect"},
  // 305: {type: "redirect"},
  307: {type: "redirect", switchToGet: false, isPermanent: false},
  308: {type: "redirect", switchToGet: false, isPermanent: true},
  400: {type: "clientError", clientErrorCode: "badRequest", descriptionHtml: "Bad Request"},
  403: {type: "clientError", clientErrorCode: "forbidden", descriptionHtml: "Forbidden"},
  404: {type: "clientError", clientErrorCode: "notFound", descriptionHtml: "Not Found"},
  405: {type: "clientError", clientErrorCode: "methodNotAllowed", descriptionHtml: "Method Not Allowed"},
  406: {type: "clientError", clientErrorCode: "notAcceptable", descriptionHtml: "Not Acceptable"},
  409: {type: "clientError", clientErrorCode: "conflict", descriptionHtml: "Conflict"},
  410: {type: "clientError", clientErrorCode: "gone", descriptionHtml: "Gone"},
  413: {type: "clientError", clientErrorCode: "requestEntityTooLarge", descriptionHtml: "Request Entity Too Large"},
  414: {type: "clientError", clientErrorCode: "requestUriTooLong", descriptionHtml: "Request-URI Too Long"},
  415: {type: "clientError", clientErrorCode: "unsupportedMediaType", descriptionHtml: "Unsupported Media Type"},
  418: {type: "clientError", clientErrorCode: "imATeapot", descriptionHtml: "I'm a teapot"},
  500: {type: "serverError"},
  501: {type: "serverError"},
  502: {type: "serverError"},
  503: {type: "serverError"},
  504: {type: "serverError"},
  505: {type: "serverError"}
};

ExternalWebSession.prototype._makePath = function (path) {
  return this.path + path;
};

ExternalWebSession.prototype._requestHelper = function (method, path, context, content, contentType) {
  var session = this;
  return new Promise(function (resolve, reject) {
    var options = _.clone(session.options);
    options.headers = options.headers || {};
    options.path = session._makePath(path);
    options.method = method;
    if (contentType) {
      options.headers["content-type"] = contentType;
    }

    // set accept header
    if ("accept" in context) {
      options.headers.accept = context.accept.map(function (acceptedType) {
        return acceptedType.mimeType + "; " + acceptedType.qValue;
      }).join(", ");
    } else if (!("accept" in options.headers)) {
      options.headers.accept = "*/*";
    }

    // set cookies
    if (context.cookies && context.cookies.length > 0) {
      options.headers.cookies = options.headers.cookies || "";
      context.cookies.forEach(function (keyVal) {
        options.headers.cookies += keyVal.key + "=" + keyVal.val + ",";
      });
      options.headers.cookies = options.headers.cookies.slice(0, -1);
    }

    options.host = session.host;
    options.port = session.port;

    var requestMethod = Http.request;
    if (session.protocol === "https:") {
      requestMethod = Https.request;
    }

    req = requestMethod(options, function (resp) {
      var buffers = [];
      var statusInfo = responseCodes[resp.statusCode];

      var rpcResponse = {};

      switch (statusInfo.type) {
        case "content":
          resp.on("data", function (buf) {
            buffers.push(buf);
          });

          resp.on("end", function() {
            var content = {};
            rpcResponse.content = content;

            content.statusCode = statusInfo.code;
            if ("content-encoding" in resp.headers) content.encoding = resp.headers["content-encoding"];
            if ("content-language" in resp.headers) content.language = resp.headers["content-language"];
            if ("content-type" in resp.headers) content.language = resp.headers["content-type"];
            if ("content-disposition" in resp.headers) {
              var disposition = resp.headers["content-disposition"];
              var parts = disposition.split(";");
              if (parts[0].toLowerCase().trim() === "attachment") {
                parts.forEach(function (part) {
                  var splitPart = part.split("=");
                  if (splitPart[0].toLowerCase().trim() === "filename") {
                    content.disposition = {download: splitPart[1].trim()};
                  }
                });
              }
            }

            content.body = {};
            content.body.bytes = Buffer.concat(buffers);

            resolve(rpcResponse);
          });
          break;
        case "noContent":
          var noContent = {};
          rpcResponse.noContent = noContent;
          noContent.setShouldResetForm = statusInfo.shouldResetForm;
          resolve(rpcResponse);
          break;
        case "redirect":
          var redirect = {};
          rpcResponse.redirect = redirect;
          redirect.isPermanent = statusInfo.isPermanent;
          redirect.switchToGet = statusInfo.switchToGet;
          if ("location" in resp.headers) redirect.location = resp.headers.location;
          resolve(rpcResponse);
          break;
        case "clientError":
          var clientError = {};
          rpcResponse.clientError = clientError;
          clientError.statusCode = statusInfo.clientErrorCode;
          clientError.descriptionHtml = statusInfo.descriptionHtml;
          resolve(rpcResponse);
          break;
        case "serverError":
          var serverError = {};
          rpcResponse.serverError = serverError;
          clientError.descriptionHtml = statusInfo.descriptionHtml;
          resolve(rpcResponse);
          break;
        default:
          // ???
          err = new Error("Invalid status code " + resp.statusCode + " received in response.");
          reject(err);
          break;
      }
    });

    req.on("error", function (e) {
      reject(e);
    });

    req.setTimeout(15000, function () {
      req.abort();
      err = new Error("Request timed out.");
      err.type = "overloaded";
      reject(err);
    });

    if (content) {
      req.end(content);
    } else {
      req.end();
    }
  });
};

ExternalWebSession.prototype.get = function (path, context) {
  return this._requestHelper("GET", path, context);
};

ExternalWebSession.prototype.post = function (path, content, context) {
  return this._requestHelper("POST", path, context, content.content, content.mimeType);
};

ExternalWebSession.prototype.put = function (path, content, context) {
  return this._requestHelper("PUT", path, context, content.content, content.mimeType);
};

ExternalWebSession.prototype.delete = function (path, context) {
  return this._requestHelper("DELETE", path, context);
};

// TODO(someday): implement streaming and websockets for ExternalWebSession
// ExternalWebSession.prototype.postStreaming = function (path, mimeType, context) {
// }

// ExternalWebSession.prototype.putStreaming = function (path, mimeType, context) {
// }

// ExternalWebSession.prototype.openWebSocket = function (path, context, protocol, clientStream) {
// }
