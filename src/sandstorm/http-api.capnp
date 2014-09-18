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

@0xbcc6c2b9aee4dc3e;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";
using Util = import "util.capnp";

interface HttpApi {
  # Apps may implement this interface to export an HTTP API.
  #
  # This differs from WebSession in that APIs are not intended to be directly accessed from a
  # browser, but rather used by client applications (including web applications via XMLHttpRequest).
  # Sandstorm APIs actually _cannot_ be viewed directly in a browser window by design. Because of
  # this, the security implications of HTTP when used for APIs is different from HTTP when used
  # for user interfaces, thus warranting a different Cap'n Proto interface. For example, APIs are
  # permitted to return an arbitrary status code (in the range [200,599]) rather than being
  # restricted to a certain set of codes, because we do not need to worry about browsers acting
  # on those codes in unexpected ways, and because HTTP APIs commonly use custom status codes.
  #
  # A Sandstorm instance exports all HTTP APIs for all apps and all users on a single hostname.
  # The specific app to which the request is addressed is determined via the `Authorization` header,
  # which contains a capability token. Sandstorm checks this header itself and does not forward
  # it to the application. Note that this allows Sandstorm itself to be responsible for OAuth.

  get @0 (responseStream :Util.ByteStream, path :Text) -> Response;
  post @1 (responseStream :Util.ByteStream, path :Text, bodyMetadata :EntityMetadata)
      -> (stream :RequestStream);
  put @2 (responseStream :Util.ByteStream, path :Text, bodyMetadata :EntityMetadata)
      -> (stream :RequestStream);
  delete @3 (responseStream :Util.ByteStream, path :Text) -> Response;

  # TODO(someday): WebSockets. Perhaps add after web-session.capnp's WebSocket interface has been
  #   updated to be datagram-oriented.

  # TODO(someday): Add WebDAV and CalDAV methods?

  struct EntityMetadata {
    encoding @0 :Text;  # Content-Encoding header (optional).
    language @1 :Text;  # Content-Language header (optional).
    mimeType @2 :Text;  # Content-Type header.
  }

  interface RequestStream extends(Util.ByteStream) {
    # Methods that take a request body start by returning this. The body is then written to this
    # stream.

    getResponse @0 () -> Response;
    # Get the final HTTP response. The caller should call this immediately, before it has actually
    # written the request data. The method is allowed to return early, if the app decides it doesn't
    # actually care about the remaining request bytes, in which case the caller should stop writing
    # them and simply drop the RequestStream capability.
  }

  struct Response {
    statusCode @0 :UInt16;
    # HTTP status code number. Must be in the range [200, 599].

    statusMessage @1 :Text;
    # Brief description of the status code, e.g. "Not found". Used in the first line of the HTTP
    # response. Meant for consumption by humans, not machines. The allowed characters and length of
    # this message are restricted for security reasons. No application should actually depend on
    # the content of the message; extended error information should be placed in the response body.

    location @2 :Text;
    # Location header. In 3xx responses, this normally indicates the redirection location. In
    # 2xx responses, it is used to indicate the location of a newly-created resource. The content
    # is a path; it may be relative to the request location.

    bodyMetadata @3 :EntityMetadata;
    # Metadata about the content, e.g. its MIME type.

    streamHandle @4 :Util.Handle;
    # Handle for the object which is writing the response body to the `responseStream` passed as a
    # method parameter. Drop this capability to cancel the stream.
  }

  # Request headers that we will probably add later:
  # * (Caching)
  #   * Cache-Control
  #   * If-*
  # * (Range requests)
  #   * Range
  #
  # Request headers that could be added later, but don't seem terribly important or relevant
  # for APIs:
  # * Accept
  # * Accept-Language
  # * Content-MD5 (MD5 is dead; perhaps we could introduce a modern alternative)
  # * From
  # * Max-Forwards
  # * Warning
  # * Pragma
  #
  # Request headers which will NOT be added ever, in part because browser-based clients are not
  # allowed to set them in XMLHttpRequest and thus depending on these headers could make your API
  # hard to use from a browser (though many of these are problematic for other reasons as well):
  # * Accept-Charset
  # * Accept-Encoding
  # * Access-Control-Request-Headers
  # * Access-Control-Request-Method
  # * Connection
  # * Content-Length
  # * Cookie
  # * Cookie2
  # * Date
  # * DNT
  # * Expect
  # * Host
  # * Keep-Alive
  # * Origin
  # * Referer
  # * TE
  # * Trailer
  # * Transfer-Encoding
  # * Upgrade
  # * User-Agent
  # * Via
  # * Proxy-*
  # * Sec-*
  #
  # This list comes from:
  #   http://www.w3.org/TR/XMLHttpRequest/#the-setrequestheader()-method
  #
  # Headers which will NOT be added ever, because Sandstorm interprets them:
  # * Authorization

  # Response headers that we will probably add later:
  # * (Caching)
  #   * Age
  #   * Cange-Control
  #   * ETag
  #   * Expires
  #   * Last-Modified
  #   * Vary (but Sandstorm will always add "Authorization")
  # * (Range requests)
  #   * Accept-Ranges
  #   * Content-Range
  #
  # Response headers that could be added later, but don't seem terribly important or relevant
  # for APIs:
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
  # * Set-Cookie, Set-Cookie2 - You cannot use cookies.
  # * Access-Control-* - Sandstorm will always set "Access-Control-Allow-Origin: *".
  # * Content-Security-Policy - Sandstorm will always set this to be highly restrictive.
  # * Content-Disposition - Sandstorm will always set disposition to "attachment" for extra
  #     security, but we may allow you to set the filename someday.
  # * Connection - Not applicable.
  # * Content-Length - Redundant.
  # * Proxy-Authenticate
  # * Public-Key-Pins
  # * Strict-Transport-Security
  # * Trailer
  # * Transfer-Encoding
  # * Upgrade
  # * WWW-Authenticate
  # * X-Frame-Options - Framing is always denied.
}
