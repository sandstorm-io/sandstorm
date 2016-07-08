# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

@0xc822108a5c3d7d25;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";

using PermissionSet = List(Bool);
# Set of permission IDs, represented as a bitfield.

interface Identity {
  # Represents a user identity.
  #
  # Things you can do:
  # - Mention the identity on activity events to send notifications. See ActivityEvent in
  #   activity.capnp.
  # - Powerbox-request an Identity to have the user choose from among their contacts. Note that the
  #   user will be prompted to share the grain with the target identity.
  # - offer() the identity to the user in order to let them see the identity's profile card and
  #   choose to add the identity to their contacts. You could do this e.g. when the user clicks
  #   on the identity's name in your app's UI. (TODO(someday): Not implemented yet.)
  #
  # This capability is always persistable.

  # TODO(someday): Public key info? Ability to seal messages / check signatures?
}

struct UserInfo @0x94b9d1efb35d11d3 {
  # Information about the user opening a new session.
  #
  # TODO(soon):  More details:
  # - Sharing/authority chain:  "Carol (via Bob, via Alice)"

  displayName @0 :Util.LocalizedText;
  # Name by which to identify this user within the user interface.  For example, if two users are
  # editing a document simultaneously, the application may display each user's cursor position to
  # the other, labeled with the respective display names.  As the users edit the document, the
  # document's history may be annotated with the display name of the user who made each change.
  # Display names are NOT unique nor stable:  two users could potentially have the same display
  # name and a user's display name could change.

  preferredHandle @4 :Text;
  # The user's preferred "handle", as set in their account settings. This is guaranteed to be
  # composed only of lowercase English letters, digits, and underscores, and will not start with
  # a digit. It is NOT guaranteed to be unique; if your app dislikes duplicate handles, it must
  # check for them and do something about them.

  pictureUrl @6 :Text;
  # URL of the user's profile picture, appropriate for displaying in a 64x64 context.
  #
  # TODO(security) TODO(apibump): If we allow UserInfo to come from untrusted sources then this
  #   field is XSS-prone. Currently UserInfo only comes from the front-end.

  pronouns @5 :Pronouns;
  # Indicates which pronouns the user prefers you use to refer to them.

  enum Pronouns {
    neutral @0;  # "they"
    male @1;     # "he" / "him"
    female @2;   # "she" / "her"
    robot @3;    # "it"
  }

  deprecatedPermissionsBlob @1 :Data;
  permissions @3 :PermissionSet;
  # Set of permissions which this user has.  The exact set might not correspond directly to any
  # particular role for a number of reasons:
  # - The sharer may have toggled individual permissions through the advanced settings.
  # - If two different users share different roles to a third user, and neither of the roles is a
  #   strict superset of the other, the user gets the union of the two permissions.
  # - If Alice shares role A to Bob, and Bob further delegates role B to Carol, then Carol's
  #   permissions are the intersection of those granted by roles A and B.
  #
  # That said, some combinations of permissions may not make sense.  For example, a document editor
  # probably has no reasonable way to implement write permission without read permission.  It is up
  # to the application to decide what to do in this case, but simply ignoring the nonsensical
  # permissions is often a fine strategy.
  #
  # If the user's permissions are reduced while the session is opened, the session will be closed
  # by the platform and the user forced to start a new one.  If the user's permissions are increased
  # while the session is opened, the system will prompt them to start a new session to use the new
  # permissions.  Either way, the application need not worry about permissions changing during a
  # session.

  identityId @2 :Data;
  # A unique, stable identifier for the calling user. This is computed such that a user's ID will
  # be the same across all Sandstorm servers, and will not collide with any other identity ID in the
  # world. Therefore, grains transferred between servers can still count on the user IDs being the
  # same and secure (unless the new host is itself malicious, of course, in which case all bets are
  # off).
  #
  # The ID is actually a SHA-256 hash, therefore it is always exactly 32 bytes and the app can
  # safely truncate it down to some shorter prefix according to its own security/storage trade-off
  # needs.
  #
  # If the user is not logged in, `userId` is null.

  identity @7 :Identity;
  # The identity capability for this user. null if the user is not logged in.
}
