# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

@0xbb368e3a12c66692;

$import "/capnp/c++.capnp".namespace("sandstorm::appindex");

using Package = import "/sandstorm/package.capnp";
using Util = import "/sandstorm/util.capnp";

interface AppIndex {
  upload @0 () -> (stream :UploadStream);

  interface UploadStream extends(Util.ByteStream) {
    getResult @0 ();
  }

  interface Submission {
    # Represents a particular package that has been submitted. Only given out to those who prove
    # they possess the app's private key.

    checkStatus @0 () -> (status :SubmissionStatus);
    setState @1 (state :SubmissionState);
  }
}

# ========================================================================================
# Temporary HTTP app request API
#
# Because we don't have cross-internet encrypted Cap'n Proto yet, currently the spk tool
# communicates with the app server over HTTPS. The interaction works like this:
#
#     POST /upload
#
# Uploads an app package. Must do this first. Returns status code 200 if successful or status
# 400 with a human-readable error explanation if the app was immediately rejected. Possible
# rejection reasons include:
# - The upload was not a Sandstorm package file.
# - The package signature was invalid.
# - The PGP signature was invalid.
# - No contact email was provided.
# - The package version was not greater than the last published version of the app.
#
#     POST /status
#
# Posts a capnp-encoded, signed SubmissionRequest. Returns a capnp-encoded SubmissionStatus.

enum SubmissionState {
  # The state of an app submission, as set by the author.

  ignore @0;    # Author wants app index to ignore this spk for now (default state).
  review @1;    # Author is ready for spk to be reviewed by admins, but not published.
  publish @2;   # Author wants spk to be published as soon as it has passed review.
}

struct SubmissionRequest {
  # Sent in a POST request after initial upload.
  #
  # The POST body is a packed-encoded SubmissionRequest, followed by an ed25519 detached signature
  # of the preceding bytes generated using libsodium's crypto_sign_detached() with the app's
  # private key. This proves that the request really came from the app author.
  #
  # WARNING: This protocol is probably BAD CRYPTO. It is intended as a stopgap until a Cap'n Proto
  # crypto transport exists, at which point we can do something better. Note that this crypto is
  # not intended to avoid the need for HTTPS with server authentication (though it is roughly
  # intended to avoid the need for HTTPS client authentication, since we'd rather authenticate
  # based on app key). If this crypto is totally broken, the worst case is someone can publish
  # or un-publish a package they don't build.

  packageId @0 :Package.PackageId;

  union {
    checkStatus @1 :Void;
    # Just check the status of this package.

    setState :group {
      newState @2 :SubmissionState;
      # Update the submission state of the package.

      sequenceNumber @4 :UInt64;
      # A number which must be monotonically increasing for each SubmissionRequest sent for the
      # same package to the same index. It is acceptable to skip numbers in the sequence, therefore
      # you can use a timestamp as a sequence number.
    }
  }

  appIndexWebkeyHash @3 :Data;
  # Blake2b hash prefix of the webkey (endpoint#token) to which this request was intended to be
  # submitted. Meant to prevent one app index from forwarding requests to some other app index
  # behind the developer's back. Preferably at least 16 bytes, but any prefix is accepted (more
  # bytes protects the client better).
}

struct SubmissionStatus {
  # The reply to HTTP PUT and POST requests to /submit/<packageId> is either a packed-encoded
  # SubmissionStatus or an error.

  requestState @0 :SubmissionState;

  union {
    pending @1 :Void;
    # The app submission is pending. Updates will be emailed to the contact address listed
    # in the package metadata. (However, if `requestState` is `ignore`, no updates will be sent
    # as no review will occur.)

    needsUpdate @2 :Text;
    # Human reviewers decided that the app cannot be published yet for reasons described in the
    # text. Generally these are cosmetic issues, e.g. "the description text is incomplete" or
    # "this submission appears to be a duplicate". Sandstorm does not outright reject apps and
    # does not place any restrictions on what functionality apps may implement, other than the
    # technical restrictions implemented by the platform and a general "no exploits" policy.
    #
    # The author must upload a new package resolving the issues. Therefore, once a submission hits
    # the "needsUpdate" state, it is permanent.

    approved @3 :Text;
    # The app is approved for publishing. If `requestState` is `publish`, then the app has been
    # published. The text is the URL where the app is / will be published.

    notUploaded @5 :Void;
    # The requested package is not present on the server. You must upload it first.
  }

  publishDate @4 :Int64 = 0;
  # Unix time at which app was first published -- i.e. the first time `requestState` was `publish`
  # *and* `approved` was set. If zero, this has never happened.

  nextSequenceNumber @6 :UInt64 = 0;
  # The next SubmissionRequest that modifies the status must use a sequenceNumber of at least this.
}
