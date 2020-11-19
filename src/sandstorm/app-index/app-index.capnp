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

@0xe16c039c931f2a8a;
# The app index is designed to run inside a Sandstorm grain, where it maintains the following
# directory structure:
#
# /var/
#   packages/
#     <packageId>/   Info about a specific package.
#       spk          Raw SPK file (immutable).
#       metadata     Serialized Package.VerifiedInfo (immutable).
#       status       Serialized SubmissionStatus (mutable).
#   apps/
#     <appId>        Symlink to latest approved package version.
#   keybase/
#     <keyId>        Serialized KeybaseIdentity for a person.
#   descriptions     Serialized ShortDescriptionOverrides
#   www/
#     apps/
#       index.json   JSON of AppIndexForMatker.
#       <appId>.json JSON of AppDetailsForMarket for given app.
#     images/
#       <imageId>    An image.
#     packages/
#       <packageId>  Hard link to released SPK.
#   tmp/             Temp files staged to be moved elsewhere or deleted.
#
# TODO(cleanup): Currently we actually append file extensions like .json, .svg, and .png to the
#   stuff under www, because Sandstorm web publishing depends on it. Eventually we should fix
#   web publishing then remove the unnecessary extensions. Note that to keep code changes minimal,
#   the JSON files list imageIds that include the extensions. The client must know to add ".json",
#   though. Note also that we do NOT add ".spk" to packages currently, because there's no
#   particular need.

$import "/capnp/c++.capnp".namespace("sandstorm::appindex");

using Package = import "/sandstorm/package.capnp";
using Grain = import "/sandstorm/grain.capnp";
using Util = import "/sandstorm/util.capnp";

struct AppIndexForMarket {
  # Type containing the index of all apps, downloaded by the market at startup.

  apps @0 :List(App);

  struct App {
    appId @0 :Package.AppId;
    name @1 :Text;      # title
    version @2 :Text;   # marketing version
    packageId @3 :Package.PackageId;
    imageId @4 :Text;   # Image found at: /images/<imageId>
    webLink @5 :Text;
    codeLink @6 :Text;
    isOpenSource @7 :Bool;
    categories @8 :List(Text);
    author @9 :Identity;
    struct Identity {
      name @0 :Text;
      keybaseUsername @1 :Text;
      picture @2 :Text;
      githubUsername @3 :Text;
      twitterUsername @4 :Text;
      hackernewsUsername @5 :Text;
      redditUsername @6 :Text;
    }
    upstreamAuthor @11 :Text;
    shortDescription @10 :Text;
    createdAt @12 :Text;   # date like "2014-08-21T09:19:29.761Z"
    versionNumber @13 :UInt32;
  }
}

struct AppDetailsForMarket {
  # Type containing detailed information downloaded by the app market when the user browses to a
  # specific app page.

  description @0 :Text;

  screenshots @1 :List(Screenshot);
  struct Screenshot {
    imageId @0 :Text;      # Image found at: /images/<imageId>
    width @1 :UInt32;
    height @2 :UInt32;
  }

  license @2 :Text;     # name only
}

struct KeybaseIdentity {
  # Social identities verified using Keybase.
  #
  # Unfortunately, Keybase apparently verifies handles and not user IDs for Github, Twitter, etc.
  # These services allow users to change their handles. Hopefully, Keybase users will not change
  # their handles.

  keybaseHandle @0 :Text;
  name @1 :Text;
  picture @2 :Text;

  websites @3 :List(Text);
  githubHandles @4 :List(Text);
  twitterHandles @5 :List(Text);
  hackernewsHandles @6 :List(Text);
  redditHandles @7 :List(Text);
}

struct ShortDescriptionOverrides {
  # Definition of a file which can be used to override short descriptions. We mainly have this
  # because a number of apps were first submitted before short descriptions became required.

  items @0 :List(Item);
  struct Item {
    appId @0 :Text;
    shortDescription @1 :Text;
  }
}

# ========================================================================================

struct CategoryTable {
  categories @0 :List(Package.Category);
}

const appIndexViewInfo :Grain.UiView.ViewInfo = (
  permissions = [(name = "approve", title = (defaultText = "approve"),
                  description = (defaultText = "allows approving apps")),
                 (name = "review", title = (defaultText = "review"),
                  description = (defaultText = "allows viewing the submission queue")),
                 (name = "submit", title = (defaultText = "submit"),
                  description = (defaultText = "allows submitting apps"))],
  roles = [(title = (defaultText = "approver"),
            permissions = [true, true, false],
            verbPhrase = (defaultText = "can approve"),
            default = true),
           (title = (defaultText = "reviewer"),
            permissions = [false, true, false],
            verbPhrase = (defaultText = "can review")),
           (title = (defaultText = "submitter"),
            permissions = [false, false, true],
            verbPhrase = (defaultText = "can submit"))]
);

const approvePermission :UInt32 = 0;
const reviewPermission :UInt32 = 1;
const submitPermission :UInt32 = 2;

const reviewAppHtml :Text = embed "review.html";

const pkgdef :Package.PackageDefinition = (
  id = "ghze43a24vg5rck3w5kegeuhu1hy52nh17j8qm7vf40ekc3r5z3h",

  manifest = (
    appTitle = (defaultText = "Sandstorm App Index"),
    appVersion = 5,
    appMarketingVersion = (defaultText = "2020-09-17"),

    actions = [
      ( title = (defaultText = "New Sandstorm App Index"),
        command = (argv = ["/app-index", "--init"])
      )
    ],
    continueCommand = (argv = ["/app-index"]),

    metadata = (
      author = (contactEmail = "support@sandstorm.io"),
      categories = [developerTools],
      license = (openSource = apache2),
      shortDescription = (defaultText = "App Market")
    )
  ),

  fileList = "app-index-sandstorm-files.list",

  sourceMap = (
    searchPath = [
      ( packagePath = "app-index", sourcePath = "app-index" ),
      ( sourcePath = "/",    # Then search the system root directory.
        hidePaths = [ "home", "proc", "sys" ]
      )
    ]
  ),

  alwaysInclude = ["app-index"]
);
