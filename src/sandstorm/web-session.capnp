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
    # whenever possible.  Note that the URL can change from session to session and from user to user,
    # hence it is only valid for the current session.

    userAgent @1 :Text;
    acceptableLanguages @2 :List(Text);
    acceptableEncodings @3 :List(Text);
    # Content of User-Agent, Accept-Language, and Accept-Encoding headers.  The platform will start
    # a new session if any of these change.
  }

  get @0 (path :Text, context :Context) -> Response;
  post @1 (path :Text, content :PostContent, context :Context) -> Response;

  struct Context {
    # Additional per-request context.
    cookies @0 :List(Util.KeyValue);
  }

  struct PostContent {
    mimeType @0 :Text;
    content @1 :Data;
  }

  struct Response {
    setCookies @0 :List(Util.KeyValue);

    union {
      redirect @1 :Text;
      # Redirect to the given URL.

      content :group {
        # Return content (status code 200).

        encoding @2 :Text = "identity";  # Content-Encoding header.
        language @3 :Text;  # Content-Language header (optional).
        mimeType @4 :Text;  # Content-Type header.

        body :union {
          bytes @5 :Data;
          stream @6 :Stream;
        }
      }

      error :group {
        # Error.  The platform will generate a suitable error page.

        statusCode @7 :UInt16 = 500;
        # HTTP status code.  Must be 4xx or 5xx.
        # TODO(soon):  Some error codes have defined user-agent behavior.  Do we need to restrict
        #   to an enumerated list?

        statusText @8 :Text = "Internal Server Error";
        # Short error message, e.g. "Not found".

        descriptionHtml @9 :Text;
        # Optional extended description of the error.  If provided, should be an HTML fragment
        # containing one or more block-level elements (typically, `<p>`s).
      }

      # TODO(someday):  Return blob directly from storage, so data doesn't have to stream through
      #   the app?
    }
  }

  interface Stream {
    # TODO(someday):  Allow streaming responses.
  }
}
