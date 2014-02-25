# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice, this
#    list of conditions and the following disclaimer.
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
# ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
# WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
# DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
# ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
# (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
# LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
# ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
# (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
# SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

@0xa8cb0f2f1a756b32;

$import "/capnp/c++.capnp".namespace("sandstorm");

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

  get @0 (path :Text, context :Context) -> Response;
  post @1 (path :Text, content :PostContent, context :Context) -> Response;

  openWebSocket @2 (path :Text, context :Context,
                    protocol :List(Text), clientStream :WebSocketStream)
                -> (protocol :List(Text), serverStream :WebSocketStream);
  # Open a new WebSocket.  `protocol` corresponds to the `Sec-WebSocket-Protocol` header.
  # `clientStream` is the capability which will receive server -> client messages, while
  # serverStream represents client -> server.

  struct Context {
    # Additional per-request context.
    cookies @0 :List(Util.KeyValue);
  }

  struct PostContent {
    mimeType @0 :Text;
    content @1 :Data;
  }

  struct Cookie {
    name @0 :Text;
    value @1 :Text;
    expires :union {
      none @2 :Void;
      absolute @3 :Int64;   # Unix timestamp.
      relative @4 :UInt64;  # Seconds relative to time of receipt.
    }
    httpOnly @5 :Bool;

    # We don't include "secure" because the platform automatically forces all cookies to be secure.
  }

  struct Response {
    setCookies @0 :List(Cookie);

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

      # Not applicable:
      #   203 Non-Authoritative Information:  Only applicable to proxies?
      #   204 No Content:  Meant for old form-based interaction.  Obsolete.  Seems like bad UX, too.
      #     If desired, should be handled differently because there should be no entity body.
      #   205 Reset Content:  Like 204, but even stranger.
      #   206 Partial Content:  Range requests not implemented yet.
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
      requestEntityTooLarge @7 $httpStatus(id = 413, title = "Request Entity Too Large");
      requestUriTooLong     @8 $httpStatus(id = 414, title = "Request-URI Too Long");
      unsupportedMediaType  @9 $httpStatus(id = 415, title = "Unsupported Media Type");
      imATeapot            @10 $httpStatus(id = 418, title = "I'm a teapot");

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

        body :union {
          bytes @5 :Data;
          stream @6 :Stream;
        }

        disposition :union {
          normal @13 :Void;
          download @14 :Text;  # Prompt user to save as given file name.
        }
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
      }

      serverError :group {
        # HTTP 5xx-level error.  The platform will generate a suitable error page.
        #
        # We don't support status codes here because basically none of them are applicable anyway
        # except 500.

        descriptionHtml @9 :Text;
        # Optional extended description of the error, as an HTML document.
      }

      # TODO(someday):  Return blob directly from storage, so data doesn't have to stream through
      #   the app?
    }
  }

  interface Stream {
    # TODO(someday):  Allow streaming responses.
  }

  interface WebSocketStream {
    sendBytes @0 (message :Data);
    # Send some bytes.  WARNING:  At present, we just send the raw bytes of the WebSocket protocol.
    # In the future, this will be replaced with a `sendMessage()` method that sends one WebSocket
    # datagram at a time.
    #
    # TODO(soon):  Send whole WebSocket datagrams.
  }
}
