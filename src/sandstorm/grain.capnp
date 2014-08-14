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

@0xc8d91463cfc4fb4a;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";

# ========================================================================================
# Powerbox
#
# TODO(cleanup):  Put in separate file?  Note that PowerboxCapability must be declared before
#   UiView due to a bug in Cap'n Proto requiring superclasses to be declared before subclasses.
#
# The powerbox is part of the Sandstorm UI which allows users to connect applications to each
# other.  First, one application must publish a PowerboxCapability to the powerbox via
# `SandstormApi.publish()`.  Then, a second application may request a capability from the powerbox
# via `SessionContext.request()`.  The user is presented with a list of capabilities from the
# powerbox which match the requesting application's query.  The user may select one, which will
# then be returned to the requesting app.
#
# Another way to connect apps is via actions.  One application may declare that it can implement
# some action on any capability matching a particular query.  Another application may later use
# SessionContext.offer() to offer a specific capability to the current user.  The user will be
# presented with a list of actions that make sense for that capability and may select one.  (This
# is much like Android intents.)

interface PowerboxCapability {
  # Capabilities to be offered to the powerbox must implement PowerboxCapability (in addition to
  # the interface for the application functionality they provide).  PowerboxCapability provides
  # metadata about the capability for display in the powerbox UI as well as the sharing graph
  # (which shows inter-app capabilities).
  #
  # Capabilities sent directly between two grains (e.g. as an RPC parameter) rather than through
  # the powerbox UI may also wish to implement PowerboxCapability in order to improve the sharing
  # graph visualization.  Only persisted capabilities will ever show up in the visualization.

  getPowerboxInfo @0 () -> PowerboxInfo;
  struct PowerboxInfo {
    title @0 :Util.LocalizedText;
    # Title for this capability if displayed as an option in the powerbox.  Useful for
    # distinguishing from other capabilities exported by the same grain.  Leave blank if the
    # capability effectively represents the entire grain and so should just take the grain's title.
    #
    # Titles are suggestions only.  The user may override the title with their own.

    verbPhrase @1 :Util.LocalizedText;
    # Verb phrase describing what the holder of this capability can do to the grain, e.g.
    # "can edit".  This may be displayed in the sharing UI to describe a connection between two
    # grains.

    description @2 :Util.LocalizedText;
    # Long-form description of what the capability represents.  Should be roughly a paragraph that
    # could be displayed e.g. in a tooltip.

    interfaces @3 :List(UInt64);
    # Type IDs of Cap'n Proto interfaces implemented by this capability.  Only interfaces which
    # should be used for powerbox searching/matching purposes need to be listed.  Superclasses
    # must be listed explicitly if they should be considered for matching.  The powerbox does not
    # know anything about the actual interface schemas; it just matches the IDs.

    # TODO(someday):  Icon.
    # TODO(someday):  Other match criteria.
  }
}

interface PowerboxAction {
  apply @0 (cap: PowerboxCapability) -> (view :UiView);
  # Invoke the action on the given capability, producing a view which is displayed to the user.
}

struct PowerboxQuery {
  # When the app requests a capability from the powerbox, it provides a PowerboxQuery specifying
  # what kind of capability it wants, in order to narrow down the options.

  union {
    conjunction @0 :List(PowerboxQuery);
    disjunction @1 :List(PowerboxQuery);
    # Specifies a conjunction (AND) or disjunction (OR) of other queries.

    implements @2 :UInt64;
    # The capability must list the given interface in `PowerboxInfo.interfaces`.

    # TODO(someday):  Other match criteria.
  }
}

# ========================================================================================
# Runtime interface

interface SandstormApi {
  # The Sandstorm platform API, exposed as the default capability over the two-way RPC connection
  # formed with the application instance.  This object specifically represents the supervisor
  # for this application instance -- two different application instances (grains) never share a
  # supervisor.

  # TODO(soon):  Read the grain title as set by the user.  Also have interface to offer a new
  #   title and icon?

  publish @0 (cap :PowerboxCapability, requiredPermissions :PermissionSet)
          -> (registration :Util.Handle);
  # Publish the given capability, such that any user who has access to the Grain with at least the
  # given permissions will see the capability show up in their powerbox for matching searches.
  #
  # Returns a handle which, when dropped, un-publishes the capability.  You must save this handle
  # to storage to keep the capability published.  Dropping the handle does not revoke the
  # capability, only prevents it from appearing in the powerbox going forward.

  # TODO(someday):  Let the app publish a picker UI which can be embedded in the powerbox.  For
  #   example, a music library may want to make each track in the library available via the
  #   powerbox, but publishing every one may be clunky.  Instead, it might offer a little embedded
  #   UI which lets the user type a search query or browse by artist.

  registerAction @1 (query :PowerboxQuery, action :PowerboxAction,
                     requiredPermissions :PermissionSet) -> (registration :Util.Handle);
  # Register an action implemented by this grain.  It will be offered to the user as an option
  # whenever another app uses `SessionContext.offer()` to offer a capability that matches the query.
  #
  # This method should only be used for actions that are somehow specific to this grain.  This is
  # unusual.  Usually, you want to define actions in the application's manifest; such actions will
  # be executed in a newly-created grain.

  shareCap @2 (cap :PowerboxCapability) -> (sharedCap :PowerboxCapability, link :SharingLink);
  # Share a capability, so that it may safely be sent to another user.  `sharedCap` is a wrapper
  # (membrane) around `cap` which can have a petname assigned and can be revoked via `link`.  The
  # share is automatically revoked if `link` is discarded.  If `cap` is persistable, then both
  # `sharedCap` and `link` also are.
  #
  # This method is intended to be used by programs that acutally implement a communications link
  # over which a capability could be sent from one user to another.  For example, a chat app would
  # use this to prepare a capability to be embedded into a message.  In these cases, capabilities
  # may be shared without going through the system sharing UI, and therefore the application must
  # set up the sharing link itself.
  #
  # In general, you should NOT call this on a capability that you will then pass to
  # `SessionContext.offer()`.

  shareView @3 (view :UiView) -> (sharedView :UiView, link :ViewSharingLink);
  # Like `shareCap` but with extra options for sharing a UiView, such as setting a role and
  # permissions.
}

interface UiView extends(PowerboxCapability) {
  # Implements a user interface with which a user can interact with the grain.  We call this a
  # "view" because a single grain may actually have multiple "views" that provide different
  # functionality or represent multiple logical objects in the same physical grain.
  #
  # When an application starts up, it must export an instance of UiView as its starting
  # capability on the Cap'n Proto two-party connection.  This represents the grain's main view and
  # is what the user will see when they open the grain.
  #
  # It is possible for a grain to export additional views via the usual powerbox mechanisms.  For
  # instance, a spreadsheet app might let the user create a "view" of a few cells of the
  # spreadsheet, allowing them to share those cells to another user without sharing the entire
  # sheet.  To accomplish this, the app would create an alternate UserInterface object that
  # implements an interface just to those cells, and then would use `UiSession.offer()` to offer
  # this object to the user.  The user could then choose to open it, share it, save it for later,
  # etc.

  getViewInfo @0 () -> ViewInfo;
  # Get metadata about the view, especially relating to sharing.

  struct ViewInfo {
    permissions @0 :List(PermissionDef);
    # List of permission bits which apply to this view.  Permissions typically include things like
    # "read" and "write".  When sharing a view, the sending user may select a set of permissions to
    # grant to the receiving user, and may modify this set later on.  When a new user interface
    # session is initiated, the platform indicates which permissions the user currently has.
    #
    # The grain's owner always has all permissions.
    #
    # It is important that new versions of the app only add new permissions, never remove existing
    # ones, since permission IDs are indexes into the list and persist through upgrades.
    #
    # In a true capability system, permissions would normally be implemented by wrapping the main
    # view in filters that prohibit disallowed actions.  For example, to give a user read-only
    # access to a grain, you might wrap its UiView in a wrapper that checks all incoming requests
    # and disallows the ones that would modify the content.  However, this approach does not work
    # terribly well for UiView for a few reasons:
    #
    # - For complex UIs, HTTP is often the wrong level of abstraction for this kind of filtering.
    #   It _may_ work for modern apps that push all UI logic into static client-side Javascript and
    #   only serve RPCs over dynamic HTTP, but it won't work well for many legacy apps, and we want
    #   to be able to port some of those apps to Sandstorm.
    #
    # - If a UiView is reshared several times, each time adding a new filtering wrapper, then
    #   requests could get slow as they have to pass through all the separate filters.  This would
    #   be especially bad if some of the filters live in other grains, as those grains would have
    #   to spin up whenever the resulting view is used.
    #
    # - Compared to computers, humans are relatively less likely to be vulnerable to confused
    #   deputy attacks and relatively more likely to be confused by the concept of having multiple
    #   capabilities to the same object that provide different access levels.  For example, say
    #   Alice and Bob both share the same document to Carol, but Alice only grants read access
    #   while Bob gives read/write.  Carol should only see one instance of the document in her
    #   grain list and she should see the read/write interface when she opens it.  But this instance
    #   isn't simply the one she got from Bob -- if Bob revokes his share but Alice continues to
    #   share read rights, Carol should now see the read-only interface when she opens the same
    #   grain.
    #
    # To solve all three problems, we have permission bits that are processed when creating a new
    # session.  Instead of filtering individual requests, wrappers of UiView only need to filter
    # calls to `newSession()` in order to restrict the permission set as appropriate.  Once a
    # session is thus created, it represents a direct link to the target grain.  Also, the platform
    # can implement special handling of sharing and permission bits that allow it to recognize when
    # two UiViews are really the same view with different permissions applied, and can then combine
    # them in the UI as appropriate.
    #
    # It is actually entirely possible to implement a traditional filtering membrane around a
    # UiView, perhaps to implement a kind of access that can't be expressed using the permission
    # bits defined by the app.  But doing so will be awkward, slow, and confusing for all the
    # reasons listed above.

    roles @1 :List(RoleDef);
    # Choosing individual permissions is not very intuitive for most users.  Therefore, the sharing
    # interface prefers to offer the user a list of "roles" to assign to each recipient.  For
    # example, a document might have roles like "editor" and "viewer".  Each role corresponds to
    # some list of permissions.  The application may define a set of roles to offer via this list.
    #
    # In addition to the roles in this list, the sharing interface will always offer a "full access"
    # or "same as me" option.  So, it only makes sense to define roles that represent less than
    # "full access", and leaving the role list entirely empty is reasonable if there are no such
    # restrictions to offer.
    #
    # It is important that new versions of the app only add new roles, never remove existing ones,
    # since role IDs are indexes into the list and persist through upgrades.

    deniedPermissions @2 :PermissionSet;
    # Set of permissions which will be removed from the permission set when creating a new session
    # though this object.  This set should be empty for the grain's main UiView, but when that view
    # is shared with less than full access, recipients will get a proxy UiView which has a non-empty
    # `deniedPermissions` set.
    #
    # It is not the caller's responsibility to enforce this set.  It is provided mainly so that the
    # sharing UI can avoid offering options to the user that don't make sense.  For instance, if
    # Alice has read-only access to a document and wishes to share the document to Bob, the sharing
    # UI should not offer Alice the ability to share write access, because she doesn't have it in
    # the first place.  The sharing UI figures out what Alice has by examining `deniedPermissions`.
  }

  newSession @1 (userInfo :UserInfo, context :SessionContext,
                 sessionType :UInt64, sessionParams :AnyPointer)
             -> (session :UiSession);
  # Start a new user interface session.  This happens when a user first opens the view, or when
  # the user returns to a tab that has been inactive long enough that the server was killed off in
  # the meantime.
  #
  # `userInfo` specifies the user's display name and permissions, as authenticated by the system.
  #
  # `context` contains callbacks that can be used to invoke system functionality in the context of
  # the session, such as displaying the powerbox.
  #
  # `sessionType` is the type ID specifying the interface which the returned `session` should
  # implement.  All views should support the `WebSession` interface to support opening the view
  # in a browser.  Other session types might be useful for e.g. desktop and mobile apps.
  #
  # `sessionParams` is a struct whose type is specified by the session type.  By convention, this
  # struct should be defined nested in the session interface type with name "Params", e.g.
  # `WebSession.Params`.  This sturct contains some arbitrary startup information.
}

# ========================================================================================
# User interface sessions

interface UiSession {
  # Base interface for UI sessions.  The most common subclass is `WebSession`.
}

struct UserInfo {
  # Information about the user opening a new session.
  #
  # TODO(soon):  More details:
  # - Profile:  Name, avatar, profile link
  # - Sharing/authority chain:  "Carol (via Bob, via Alice)"
  # - Identity:  Public key, certificates, verification of proxy chain.

  displayName @0 :Util.LocalizedText;
  # Name by which to identify this user within the user interface.  For example, if two users are
  # editing a document simultaneously, the application may display each user's cursor position to
  # the other, labeled with the respective display names.  As the users edit the document, the
  # document's history may be annotated with the display name of the user who made each change.
  # Display names are NOT unique nor stable:  two users could potentially have the same display
  # name and a user's display name could change.

  permissions @1 :PermissionSet;
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

  userId @2 :Data;
  # A unique, stable identifier for the calling user. This is computed such that a user's ID will
  # be the same across all Sandstorm servers, and will not collide with any other user ID in the
  # world. Therefore, grains transferred between servers can still count on the user IDs being the
  # same and secure (unless the new host is itself malicious, of course, in which case all bets are
  # off).
  #
  # The ID is actually a SHA-256 hash, therefore it is always exactly 32 bytes and the app can
  # safely truncate it down to some shorter prefix according to its own security/storage trade-off
  # needs.
  #
  # If the user is not logged in, `userId` is null.
}

interface SessionContext {
  # Interface that the application can use to call back to the platform in the context of a
  # particular session.  This can be used e.g. to ask the platform to present certain system
  # dialogs to the user.

  getSharedPermissions @0 () -> (var :Util.Assignable);
  # Returns an `Assignable(PermissionSet)` indicating the permissions held by the user of this session.
  # This assignable can be persisted beyond the end of the session.  This is useful for detecting if
  # the user later loses their access and auto-revoking things in that case.  See also `tieToUser()`
  # for an easier way to make a particular capability auto-revoke if the user's permissions change.

  tieToUser @1 (cap :PowerboxCapability, requiredPermissions :PermissionSet)
            -> (tiedCap :PowerboxCapability);
  # Create a version of `cap` which will automatically stop working if the user no longer holds the
  # permissions indicated by `requiredPermissions` (and starts working again if the user regains
  # those permissions).  The capability also appears connected to the user in the sharing
  # visualization.
  #
  # Keep in mind that, security-wise, calling this also implies exposing `tiedCap` to the user, as
  # anyone with a UiView capability can always initiate a session and pass in their own
  # `SessionContext`.  If you need to auto-revoke a capability based on the user's permissions
  # _without_ actually passing that capability to the user, use `getSharedPermissions()` to detect
  # when the user's permissions change and implement it yourself.

  offer @2 (cap :PowerboxCapability, requiredPermissions :PermissionSet) -> ();
  # Offer a capability to the user.  A dialog box will ask the user what they want to do with it.
  # Depending on the type of capability, different options may be provided.  All capabilities will
  # offer the user the option to save the capability to their capability/grain store.  Other
  # type-specific actions may be offered by the platform or by other applications.
  #
  # For example, offering a UiView will give the user options like "open in new tab", "save to
  # grain list", and "share with another user".
  #
  # The capability is implicitly tied to the user as if via `tieToUser()`.

  request @3 (query :PowerboxQuery) -> (cap :PowerboxCapability);
  # Searches for capabilities in the user's powerbox matching the given query and displays a
  # selection UI to the user.  Returns the selected capability.
}

# ========================================================================================
# Sharing and Access Control

struct PermissionDef {
  # Metadata describing a permission bit.

  name @3 :Text;
  # Name of the permission, used as an identifier for the permission in cases where string names
  # are preferred. These names will never be used in Cap'n Proto interfaces, but could show up in
  # HTTP or JSON translations, such as in sandstorm-http-bridge's X-Sandstorm-Permissions header.
  #
  # The name must be a valid identifier (alphanumerics only, starting with a letter) and must be
  # unique among all permissions defined for a particular UiView.

  title @0 :Util.LocalizedText;
  # Display name of the permission, e.g. to display in a checklist of permissions that may be
  # assigned when sharing.

  description @1 :Util.LocalizedText;
  # Prose describing what this permission means, suitable for a tool tip or similar help text.

  obsolete @2 :Bool = false;
  # If true, this permission was relevant in a previous version of the application but should no
  # longer be offered to the user in future sharing actions.
}

using PermissionSet = Data;
# Set of permission IDs.  Currently represented as a bitfield.  The bits of the byte string are
# interpreted in little-endian order, e.g. the least-significant bit of the first byte represents
# permission 0 while the most-significant bit of the third byte represents permission 23.  All
# bits beyond the end of the byte string are assumed to be zero.

struct RoleDef {
  # Metadata describing a sharable role.

  title @0 :Util.LocalizedText;
  # Name of the role, e.g. "editor" or "viewer".

  verbPhrase @1 :Util.LocalizedText;
  # Verb phrase describing what users in this role can do with the grain.  Should be something
  # like "can edit" or "can view".  When the user shares the view with others, these verb phrases
  # will be used to populate a drop-list of roles for the user to select.

  description @2 :Util.LocalizedText;
  # Prose describing what this role means, suitable for a tool tip or similar help text.

  permissions @3 :PermissionSet;
  # Permissions which make up this role.  For example, the "editor" role on a document would
  # typically include "read" and "write" permissions.

  obsolete @4 :Bool = false;
  # If true, this role was relevant in a previous version of the application but should no longer
  # be offered to the user in future sharing actions.  The role may still be displayed if it was
  # used to share the view while still running the old version.
}

interface SharingLink {
  # Represents one link in the sharing graph.

  getPetname @0 () -> (name :Util.Assignable);
  # Name assigned by the sharer to the recipient. Assignable holds `LocalizedText`.
}

interface ViewSharingLink extends(SharingLink) {
  getRoleAssignment @0 () -> (var :Util.Assignable);
  # Returns an Assignable containing a RoleAssignment.

  struct RoleAssignment {
    union {
      allAccess @0 :Void;  # Grant all permissions.
      roleId @1 :UInt16;   # Grant permissions for the given role.
    }

    addPermissions @2 :PermissionSet;
    # Permissions to add on top of those granted above.

    removePermissions @3 :PermissionSet;
    # Permissions to remove from those granted above.
  }
}

# ========================================================================================
# Backup and Restore

struct GrainInfo {
  appId @0 :Text;
  appVersion @1 :UInt32;
  title @2 :Text;
}
