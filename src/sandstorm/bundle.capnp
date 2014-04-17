# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
# All rights reserved.
#
# This file is part of the Sandstorm platform implementation.
#
# Sandstorm is free software: you can redistribute it and/or modify
# it under the terms of the GNU Affero General Public License as
# published by the Free Software Foundation, either version 3 of the
# License, or (at your option) any later version.
#
# Sandstorm is distributed in the hope that it will be useful, but
# WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
# Affero General Public License for more details.
#
# You should have received a copy of the GNU Affero General Public
# License along with Sandstorm.  If not, see
# <http:#www.gnu.org/licenses/>.

@0x96ab0544301c79c2;

$import "/capnp/c++.capnp".namespace("sandstorm::bundle");

enum Channel {
  custom @0;
  # A custom, local build.  Does not get updates.

  dev @1;
  # Dev channel.  Updated frequently, but updates are not well-tested.

  # TODO(someday):  beta, stable
}

struct UpdateInfo {
  # Returned in response to an update request.
  #
  # To avoid the need for SSL certificate chain checking in the updater, UpdateInfos are
  # distributed over HTTP but are cryptographically signed using libsodium.  In this scenario, the
  # client must be wary of attacks in which the attacker intercepts the HTTP request and returns
  # some other UpdateInfo which happens to have the right signature, such as an UpdateInfo from
  # a past version.
  #
  # Note that an attacker with the ability to intercept traffic can always prevent the client from
  # talking to the update server.  There is currently no way for the client to distinguish this
  # from a regular network failure.  Therefore we can't prevent such an attacker from holding a
  # client to a broken version.
  #
  # TODO(security):  In the future, we could consider adding timestamps to UpdateInfo such that
  #   the client can detect if it is being fed stale info.  However, this requires the signing
  #   key to be kept online, which may hurt security more than it helps.  Probably, the better
  #   answer is to bite the bullet and bring in SSL with all its PKI pain.

  channel @0 :Channel;
  # The requested channel.  Client should reject the UpdateInfo if the channel doesn't match, as
  # this indicates an attacker is trying to trick the client into switching channels by returning
  # the UpdateInfo meant for a different channel.

  build @1 :UInt32;
  # The build number of the new version.  Client should reject the UpdateInfo if this build
  # number is not greater than the client's existing build number, as this indicates an attacker
  # is trying to trick the clienti into downgrading to a past version by returning a past
  # UpdateInfo.

  fromMinBuild @2 :UInt32;
  # The minimum build number which can safely accept this update info.  Client should reject the
  # UpdateInfo if the client's current build number is less than this, as the update may break the
  # client.

  size @3 :UInt32;
  # Size of the bundle file.  Mainly here so that we know to cancel a download if it goes over
  # (which could be a resource exhaustion attack).

  hash @4 :Data;
  # Hash of the update tarball, which can be downloaded from:
  #   dl.sandstorm.io/sandstorm-$build.tar.xz
}
