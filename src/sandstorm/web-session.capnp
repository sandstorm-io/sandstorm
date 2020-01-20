# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
# All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#   http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

@0xa8cb0f2f1a756b32;

using Cxx = import "/capnp/c++.capnp";
$Cxx.namespace("sandstorm");

using Grain = import "grain.capnp";
using Util = import "util.capnp";

struct HttpStatusDescriptor {
  id @0 :UInt16;
  title @1 :Text;
}
annotation httpStatus @0xaf480a0c6cab8887 (enumerant) :HttpStatusDescriptor;
const httpStatusAnnotationId :UInt64 = 0xaf480a0c6cab8887;

interface WebSession @0xa50711a14d35a8ce extends(Grain.UiSession) {
  # A UI session based on the web platform.  The user's browser communicates to the server through
  # HTTP requests.
  #
  # Many of the details of HTTP are implemented by the platform and thus not exposed here.  For
  # example, the platform may automatically set last-modified based on the last time the
  # application's storage was written and may automatically implement etags based on hashing the
  # content.

  struct Params {
    # Startup params for web sessions.  See `UiView.newSession()`.

    basePath @0 :Text;
    # HTTP URL of the application's root directory as seen by this user, e.g.
    # "https://ioa5fiu34sm4w.example.com/i7efqesOldepw".  Never includes the trailing '/'.  Useful
    # for constructing intra-app link URLs, although in general you should try to use relative URLs
    # whenever possible.  Note that the URL can change from session to session and from user to
    # user, hence it is only valid for the current session.

    userAgent @1 :Text;
    acceptableLanguages @2 :List(Text);
    # Content of User-Agent and Accept-Language headers.  The platform will start a new session if
    # any of these change.
    # TODO(soon):  Support utility factor (e.g. ";q=0.7").
  }

  get @0 (path :Text, context :Context, ignoreBody :Bool) -> Response;
  # GET or HEAD request.
  #
  # If `ignoreBody` is true, then the caller intends to ignore any content body returned. The
  # caller may choose to return an empty body. (This is used e.g. for HEAD requests.)

  post @1 (path :Text, content :PostContent, context :Context) -> Response;
  put @3 (path :Text, content :PutContent, context :Context) -> Response;
  delete @4 (path :Text, context :Context) -> Response;
  patch @17 (path :Text, content :PostContent, context :Context) -> Response;

  postStreaming @5 (path :Text, mimeType :Text, context :Context, encoding :Text)
      -> (stream :RequestStream);
  putStreaming @6 (path :Text, mimeType :Text, context :Context, encoding :Text)
      -> (stream :RequestStream);
  # Streaming post/put requests, useful when the input is large. If these throw `unimplemented`
  # exceptions, the caller should fall back to regular post() / put() on the assumption that the
  # app doesn't implement streaming.
  #
  # The optional `encoding` field represents the Content-Encoding header.

  openWebSocket @2 (path :Text, context :Context,
                    protocol :List(Text), clientStream :WebSocketStream)
                -> (protocol :List(Text), serverStream :WebSocketStream);
  # Open a new WebSocket.  `protocol` corresponds to the `Sec-WebSocket-Protocol` header.
  # `clientStream` is the capability which will receive server -> client messages, while
  # serverStream represents client -> server.

  propfind @7 (path :Text, xmlContent :Text, depth :PropfindDepth, context :Context) -> Response;
  proppatch @8 (path :Text, xmlContent :Text, context :Context) -> Response;
  mkcol @9 (path :Text, content :PostContent, context :Context) -> Response;
  copy @10 (path :Text, destination :Text, noOverwrite :Bool,
            shallow :Bool, context :Context) -> Response;
  move @11 (path :Text, destination :Text, noOverwrite :Bool, context :Context) -> Response;
  lock @12 (path :Text, xmlContent :Text, shallow :Bool, context :Context) -> Response;
  unlock @13 (path :Text, lockToken :Text, context :Context) -> Response;
  acl @14 (path :Text, xmlContent :Text, context :Context) -> Response;
  report @15 (path :Text, content :PostContent, context :Context) -> Response;
  # WebDAV methods
  #
  # "destination" is a *path*, but *not* a URI -- the origin is stripped, and there is no leading
  #   '/', just like with the `path` parameter.
  # "shallow = true" means "Depth: 0"
  # "noOverwrite = true" means "Overwrite: F"; note that this behaves a precondition -- if the
  #   destination already exists then a preconditionFailed response is returned.
  #
  # (These boolean flags were intentionally chosen so that the spec-defined default values are
  # false.)

  options @16 (path :Text, context :Context) -> Options;
  # OPTIONS request.

  struct Context {
    # Additional per-request context.

    cookies @0 :List(Util.KeyValue);

    responseStream @1 :Util.ByteStream;
    # Stream to which the app can optionally write the response body. This is only actually
    # used in the case of a `content` response where the `body` union is set to `stream`. In that
    # case, after returning from the HTTP method, the app begins writing bytes to `responseStream`.
    #
    # Since it's not guaranteed that `responseStream` will be used, and because it would be
    # confusing to start receiving `write()` calls on it before receiving the HTTP response,
    # callers should typically initialize this field with a promise. When the response indicates
    # streaming, the caller can then resolve that promise and start receiving the content.
    #
    # Callers are required to provide this capability; apps need not handle it being null.

    accept @2 :List(AcceptedType);
    # This corresponds to the Accept header

    acceptEncoding @9 :List(AcceptedEncoding);
    # This corresponds to the Accept-Encoding header

    eTagPrecondition :union {
      none @4 :Void;  # No precondition.
      exists @5 :Void;  # If-Match: *
      doesntExist @8 :Void;  # If-None-Match: *
      matchesOneOf @6 :List(ETag);  # If-Match
      matchesNoneOf @7 :List(ETag);  # If-None-Match
    }

    additionalHeaders @3 :List(Header);
    # Additional headers present in the request. Only whitelisted headers are
    # permitted.

    struct Header {
      name @0 :Text;  # lower-cased name
      value @1 :Text;
    }

    const headerWhitelist :List(Text) = [
      # Non-standard request headers which are whitelisted for backwards-compatibility
      # purposes. This whitelist exists to help avoid the need to modify code originally written
      # without Sandstorm in mind -- especially to avoid modifying client apps. Feel free
      # to send us pull requests adding additional headers.
      # Values in this list that end with '*' whitelist a prefix.

      "x-sandstorm-app-*",     # For new headers introduced by Sandstorm apps.

      "oc-total-length",       # Owncloud client
      "oc-chunk-size",         # Owncloud client
      "x-oc-mtime",            # Owncloud client
      "oc-fileid",             # Owncloud client
      "oc-chunked",            # Owncloud client
      "x-hgarg-*",             # Mercurial client
      "x-phabricator-*",       # Phabricator
      "x-requested-with",      # JQuery header used by Rails and other frameworks
    ];
  }

  struct PostContent {
    # TODO(apibump): Rename this to just `Content` or maybe `RequestContent`.

    mimeType @0 :Text;
    content @1 :Data;
    encoding @2 :Text;  # Content-Encoding header (optional).
  }

  struct PutContent {
    # TODO(apibump): Remove this and replace it with `PostContent` (renamed to `Content`).

    mimeType @0 :Text;
    content @1 :Data;
    encoding @2 :Text;  # Content-Encoding header (optional).
  }

  struct ETag {
    value @0 :Text;  # does not include quotes
    weak @1 :Bool;
    # denotes that the resource may not be byte-for-byte identical, but is
    # semantically equivalent
  }

  struct Cookie {
    # Strings here must not contain ';' nor ','. Also, `name` cannot contain '='.

    name @0 :Text;
    value @1 :Text;
    expires :union {
      none @2 :Void;
      absolute @3 :Int64;   # Unix timestamp.
      relative @4 :UInt64;  # Seconds relative to time of receipt.
    }
    httpOnly @5 :Bool;
    path @6 :Text;

    # We don't include "secure" because the platform automatically forces all cookies to be secure.
  }

  struct AcceptedType {
    # In the accept header, there is a list of these elements.
    # The qValue is optional and defaults to 1.
    #
    # For example, the Accept header with value 'text/javascript; q=0.01' would have a mimeType of
    # "text/javascript" and a qValue of .01.
    mimeType @0 :Text;
    qValue @1 :Float32 = 1;
  }

  struct AcceptedEncoding {
    # The Accept-Encoding header contains a list of valid content codings.
    # Each content coding could be "*", indicating an arbitrary encoding.
    # Each content coding comes with a qValue, defaulting to 1.
    # For example, gzip;q=0.5 indicates the "gzip" coding with qValue "0.5"

    contentCoding @0 :Text;
    qValue @1 :Float32 = 1;
  }

  struct Response {
    setCookies @0 :List(Cookie);
    cachePolicy @16 :CachePolicy;

    enum SuccessCode {
      # 2xx-level status codes that we allow an app to return.
      #
      # We do not permit arbitrary status codes because some have semantic meaning that could
      # cause browsers to do things we don't expect.  An unrecognized status code coming from a
      # sandboxed HTTP server will translate to 500, except for unrecognized 4xx codes which will
      # translate to 400.
      #
      # It's unclear how useful it is to even allow 201 or 202, but since a browser will certainly
      # treat them as equivalent to 200, we allow them.

      ok       @0 $httpStatus(id = 200, title = "OK");
      created  @1 $httpStatus(id = 201, title = "Created");
      accepted @2 $httpStatus(id = 202, title = "Accepted");

      noContent      @3 $httpStatus(id = 204, title = "No Content");
      partialContent @4 $httpStatus(id = 206, title = "Partial Content");
      multiStatus    @5 $httpStatus(id = 207, title = "Multi-Status");

      # This seems to fit better here than in the 3xx range
      notModified    @6 $httpStatus(id = 304, title = "Not Modified");

      # Not applicable:
      #   203 Non-Authoritative Information:  Only applicable to proxies?
      #   205 Reset Content:  Like 204, but even stranger.
      #   Others:  Not standard.
    }

    enum ClientErrorCode {
      # 4xx-level status codes that we allow an app to return.
      #
      # It's unclear whether status codes other than 400, 403, and 404 have any real utility;
      # arguably, all client errors should just use code 400 with an accompanying human-readable
      # error description.  But, since browsers presumably treat them all equivalently to 400, it
      # seems harmless enough to allow them through.
      #
      # An unrecognized 4xx error code coming from a sandboxed HTTP server will translate to 400.

      badRequest            @0 $httpStatus(id = 400, title = "Bad Request");
      forbidden             @1 $httpStatus(id = 403, title = "Forbidden");
      notFound              @2 $httpStatus(id = 404, title = "Not Found");
      methodNotAllowed      @3 $httpStatus(id = 405, title = "Method Not Allowed");
      notAcceptable         @4 $httpStatus(id = 406, title = "Not Acceptable");
      conflict              @5 $httpStatus(id = 409, title = "Conflict");
      gone                  @6 $httpStatus(id = 410, title = "Gone");
      preconditionFailed   @11 $httpStatus(id = 412, title = "Precondition Failed");
      requestEntityTooLarge @7 $httpStatus(id = 413, title = "Request Entity Too Large");
      requestUriTooLong     @8 $httpStatus(id = 414, title = "Request-URI Too Long");
      unsupportedMediaType  @9 $httpStatus(id = 415, title = "Unsupported Media Type");
      imATeapot            @10 $httpStatus(id = 418, title = "I'm a teapot");
      unprocessableEntity  @12 $httpStatus(id = 422, title = "Unprocessable Entity");

      # Not applicable:
      #   401 Unauthorized:  We don't do HTTP authentication.
      #   402 Payment Required:  LOL
      #   407 Proxy Authentication Required:  Not a proxy.
      #   408 Request Timeout:  Not possible; the entire request is provided with the call.
      #   411 Length Required:  Request is framed using Cap'n Proto.
      #   412 Precondition Failed:  If we implement preconditions, they should be handled
      #     separately from errors.
      #   416 Requested Range Not Satisfiable:  Ranges not implemented (might be later).
      #   417 Expectation Failed:  Like 412.
      #   Others:  Not standard.
    }

    union {
      content :group {
        # Return content (status code 200, or perhaps 201 or 202).

        statusCode @10 :SuccessCode;

        encoding @2 :Text;  # Content-Encoding header (optional).
        language @3 :Text;  # Content-Language header (optional).
        mimeType @4 :Text;  # Content-Type header.

        eTag @17 :ETag;
        # Optional entity tag for this content. This can be used to express preconditions on future
        # requests, useful for implementing, for example, cache validation (on GETs) and optimistic
        # concurrency (on PUTs). See `eTagPrecondition` in `WebSession.Context`.

        body :union {
          bytes @5 :Data;

          stream @6 :Util.Handle;
          # Indicates that the content will be streamed to the `responseStream` offered in the
          # call's `Context`. The caller may cancel the stream by dropping the Handle.
          #
          # Note that to prevent a grain from being shut down in the middle of a large download,
          # it is necessary to call ping() on this handle every 60 seconds.
        }

        disposition :union {
          normal @13 :Void;
          download @14 :Text;  # Prompt user to save as given file name.
        }
      }

      noContent :group {
        # Return successful, but with no content (status codes 204 and 205)

        shouldResetForm @15 :Bool;
        # If this is the response to a form submission, should the form be reset to empty?
        # Distinguishes between HTTP response 204 (False) and 205 (True)

        eTag @19 :ETag;
        # Optional entity tag header. Server can send this in a response to a modifying request
        # to indicate for example the new version of the modified resource.
      }

      preconditionFailed :group {
        # One of the preconditions specified in the request context was not met.
        #
        # If the request was a GET or HEAD and the precodition was If-None-Match, then this response
        # corresponds to HTTP 304 "Not Modified". In all other ctases, this response corresponds to
        # HTTP 412 "Precondition Failed". (We unify these two HTTP status codes because they really
        # mean the same thing and should be implemented by the same code.)

        matchingETag @18 :ETag;
        # If the precondition failed because the etag matched a tag specified in `matchesNoneOf`,
        # this is the tag that it matched. For other types of preconditions, this is null.
        #
        # (This is in particular used for GET requests where the result is "304 not modified".)
      }

      redirect :group {
        # Redirect to the given URL.
        #
        # Note that 3xx-level HTTP responses have specific semantic meanings, therefore we actually
        # represent that meaning here rather than having a 3xx status code enum.  `redirect`
        # covers only 301, 302 (treated as 303), 303, 307, and 308.  Other 3xx status codes
        # need to be handled in a completely different way, since they are not redirects.

        isPermanent @1 :Bool;
        # Is this a permanent (cacheable) redirect?

        switchToGet @12 :Bool;
        # Should the user-agent change the method to GET when accessing the new location?
        # Otherwise, it should repeat the same method as was used for this request.

        location @11 :Text;
        # New URL to which to redirect.
        #
        # TODO(security):  Supervisor should prohibit locations outside the app's host.
      }

      clientError :group {
        # HTTP 4xx-level error.  The platform will generate a suitable error page.

        statusCode @7 :ClientErrorCode;

        descriptionHtml @8 :Text;
        # Optional extended description of the error, as an HTML document.
        #
        # If the response is not text/html, use nonHtmlContent.
        #
        # TODO(apibump): Get rid of this and use only nonHtmlContent.

        nonHtmlBody @21 :ErrorBody;
        # Response body, of a type that isn't text/html. If present, descriptionHtml should be
        # ignored. However, older programs only know about descriptionHtml.
      }

      serverError :group {
        # HTTP 5xx-level error.  The platform will generate a suitable error page.
        #
        # We don't support status codes here because basically none of them are applicable anyway
        # except 500.

        descriptionHtml @9 :Text;
        # Optional extended description of the error, as an HTML document.
        #
        # TODO(apibump): Get rid of this and use only nonHtmlContent.

        nonHtmlBody @22 :ErrorBody;
        # Response body, of a type that isn't text/html. If present, descriptionHtml should be
        # ignored. However, older programs only know about descriptionHtml.
      }

      # TODO(someday):  Return blob directly from storage, so data doesn't have to stream through
      #   the app?
    }

    additionalHeaders @20 :List(Header);
    # Additional headers present in the reponse. Only whitelisted headers are
    # permitted.

    struct Header {
      name @0 :Text;  # lower-cased name
      value @1 :Text;
    }

    struct ErrorBody {
      data @0 :Data;
      encoding @1 :Text;  # Content-Encoding header (optional).
      language @2 :Text;  # Content-Language header (optional).
      mimeType @3 :Text;  # Content-Type header.
    }

    const headerWhitelist :List(Text) = [
      # Non-standard response headers which are whitelisted for backwards-compatibility
      # purposes. This whitelist exists to help avoid the need to modify code originally written
      # without Sandstorm in mind -- especially to avoid modifying client apps.
      # Feel free to send us pull requests adding additional headers.
      # Values in this list that end with '*' whitelist a prefix.

      "x-sandstorm-app-*",     # For new headers introduced by Sandstorm apps.

      "x-oc-mtime",            # Owncloud protocol
    ];

  }

  interface RequestStream extends(Util.ByteStream) {
    # A streaming request. The request body is streamed in via the methods of ByteStream.

    getResponse @0 () -> Response;
    # Get the final HTTP response. The caller should call this immediately, before it has actually
    # written the request data.
    #
    # The method is allowed to return early, e.g. in order to start streaming the response while
    # the request is still uploading. Thus, full-duplex streaming is supported. This is useful in
    # some obscure cases. For example, an HTTP server that just encrypts the request could do so
    # by streaming back the response as the request comes in so that it does not need to buffer the
    # whole thing.
    #
    # If the response is completely transmitted before the request finishes uploading, the caller
    # may cancel the upload stream by simply dropping the RequestStream object (without calling
    # done()). Note that in the case of a streaming response, "completely transmitted" means that
    # the response stream's done() method has been called, or the response stream itself has been
    # dropped.
  }

  interface WebSocketStream {
    sendBytes @0 (message :Data);
    # Send some bytes.  WARNING:  At present, we just send the raw bytes of the WebSocket protocol.
    # In the future, this will be replaced with a `sendMessage()` method that sends one WebSocket
    # datagram at a time.
    #
    # TODO(apibump): Send whole WebSocket messages.
  }

  struct CachePolicy {
    enum Scope {
      # Defines the scope in which caching is allowed. For security reasons, the resource MUST NOT
      # be stored in a cache with a broader scope, even if it is never actually served from that
      # cache.

      none @0;
      # This resource must not be stored in any cache.

      perSession @1;
      # Caching is allowed on a per-session basis.

      perUser @2;
      # Caching is allowed on a per-user basis (across multiple sessions).

      perAppVersion @3;
      # Caching is allowed on a per-app-version basis (across all users). This is a
      # Sandstorm-specific notion.

      universal @4;
      # Caching is allowed universally, across all users and versions of the app.
    }

    withCheck @0 :Scope;
    # Within a cache serving this scope or a narrower scope, the resource may be stored in cache,
    # but if a non-negligible amount of time has gone by since the resource was last validated then
    # the client must check with the server that the resource hasn't changed (revalidate).
    #
    # "A non-negligible amount of time" means something on the order of the network latency between
    # the client and the server. For example, there is obviously no point in re-validating a cached
    # resource if it was last validated less than one network round trip ago. For optimization
    # reasons, we allow this to be expanded a bit -- something like a 15s timeout is OK. Ultimately
    # it is up to the infrastructure to decide, though; if an app is not OK with this, it should
    # specify `withCheck` = `none`.

    permanent @1 :Scope;
    # Within a cache serving this scope or a narrower scope, the resource may be assumed never to
    # change, and may be served directly from cache without checking with the server.
    #
    # Note that we do not allow specification of a cache duration other than "forever" because in
    # practice if the resource is mutable at all, you almost certainly don't know when it will next
    # change, and so setting a non-zero cache duration will lead to stale data bugs.

    variesOnCookie @2 :Bool;
    variesOnAccept @3 :Bool;
    # Indicates what inputs in `Context` would have caused a different response to be served.
    # If these are false and caching is enabled, it is assumed the resource is identical regardless
    # of these inputs.
  }

  struct Options {
    davClass1 @0 :Bool = false;
    davClass2 @1 :Bool = false;
    davClass3 @2 :Bool = false;
    davExtensions @3 :List(Text);
  }

  enum PropfindDepth {
    infinity @0 $Cxx.name("infinity_");  # INFINITY is a macro in C
    zero @1;
    one @2;
  }

  # Request headers that we will probably add later:
  # * Caching:
  #   * Cache-Control
  #   * If-*
  # * Range requests:
  #   * Range
  #
  # Request headers that could be added later, but don't seem terribly important:
  # * Accept
  # * Accept-Charset
  # * Accept-Encoding
  # * Content-MD5 (MD5 is dead; perhaps we could introduce a modern alternative)
  # * Date
  # * From
  # * Max-Forwards
  # * Warning
  # * Pragma
  #
  # Request headers which will NOT be added ever:
  # * Sandstorm handles authorization:
  #   * Authorization
  # * Sandstorm defines cross-origin request permissions:
  #   * Access-Control-Request-Headers
  #   * Access-Control-Request-Method
  #   * Origin
  # * Redundant or irrelevant to Cap'n Proto RPC:
  #   * Connection
  #   * Content-Length
  #   * Expect
  #   * Host
  #   * Keep-Alive
  #   * TE
  #   * Trailer
  #   * Transfer-Encoding
  #   * Upgrade
  # * Apps should not have this information:
  #   * Referer
  #   * Via
  #   * Proxy-*
  #   * Sec-*
  # * Sandstorm already prevents illicit tracking technically; no need for policy:
  #   * DNT

  # Response headers that we will probably add later:
  # * Caching:
  #   * Age
  #   * Cange-Control
  #   * ETag
  #   * Expires
  #   * Last-Modified
  #   * Vary (but Sandstorm will always add "Authorization")
  # * Range requests:
  #   * Accept-Ranges
  #   * Content-Range
  #
  # Response headers that could be added later, but don't seem terribly important:
  # * Allow
  # * Content-Location
  # * Content-MD5 - MD5 is dead; perhaps we could introduce a modern alternative.
  # * Content-Disposition (filename part only)
  # * Link
  # * Pragma
  # * Refresh
  # * Retry-After
  # * Server
  # * Via
  # * Warning
  #
  # Response headers which will NEVER be implemented:
  # * Sandstorm defines cross-origin request permissions:
  #   * Access-Control-*
  # * Sandstorm uses these for sandboxing:
  #   * Content-Security-Policy
  #   * X-Frame-Options
  # * Redundant or irrelevant to Cap'n Proto RPC:
  #   * Connection
  #   * Content-Length - Redundant.
  #   * Trailer
  #   * Transfer-Encoding
  #   * Upgrade
  # * These belong to the domain owner, not the app:
  #   * Public-Key-Pins
  #   * Strict-Transport-Security
  # * Sandstorm controls authentication:
  #   * WWW-Authenticate
  # * Irrelevant to servers:
  #   * Proxy-Authenticate
}
