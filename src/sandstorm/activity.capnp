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

@0xa4e001d4cbcf33fa;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";
using Identity = import "identity.capnp";

struct ActivityEvent {
  # Describes an event in a grain's activity feed / log.
  #
  # Call SessionContext.activity() to post new activity. The activity is attributed to the user
  # whose SessionContext was used.

  path @0 :Text;
  # Path (as in, URL) within the grain where the user can see this activity. Users inspecting the
  # event will be linked to this location. Visiting this path implicitly marks the event as "read".
  #
  # This should NOT include a leading '/'. (So, an empty string -- the default -- goes to the grain
  # root).

  thread @4 :ThreadInfo;
  # If this event is a member of a "thread", information about that thread. For example, in an
  # issue tracker app, all comments on an issue would be part of the same "thread". Threads are
  # important for deciding who gets notified and for grouping those notifications: a user might
  # subscribe to a particular thread, and e.g. email notifications related to a thread may be
  # designed to appear as a single email thread.
  #
  # TODO(now): Should this be a capability to a `Thread` object which must be created separately?

  struct ThreadInfo {
    path @0 :Text;
    # Like ActivityEvent.path, but identifies the path to the thread in general. For subscription
    # purposes, a thread must be uniquely identified by its path.

    title @1 :Util.LocalizedText;
    # The title of the thread, e.g. for use in an email subject line. Note that if a thread's title
    # changes, it may cause email notifications related to the therad to form a new thread, since
    # email clients commonly create email threads based on subject line.
  }

  notification @1 :NotificationDisplayInfo;
  # Optional metadata used to render a notification about this event. This metadata is not stored
  # in the activity log long-term. It is used e.g. to construct a notification email message or
  # to display in the notification "bell" menu (discarded once the notification is dismissed).
  #
  # It is OK to leave this null for simple events, especially events that don't by default send
  # notifications.

  type @2 :UInt16;
  # Event type; index into UiView.ViewInfo.eventTypes. Users are able to choose which types of
  # events should notify them.

  users @3 :List(User);
  # List of user identities connected to this event.

  struct User {
    # Information about a specific user's relationship with this event. At least one of the fields
    # other than `identityId` should be non-default, otherwise listing the user has no purpose.

    identity @0 :Identity.Identity;

    mentioned @1 :Bool;
    # This user is "mentioned" by this event. This is a hint that they should be more actively
    # notified.

    canView @2 :Bool;
    # This user can view this event *even if* they do not meet the `requiredPermission` in the
    # type definition. (However, if the user has no access to the grain at all, they still will
    # not see the event.) This flag is useful when the app is doing its own internal access control
    # rather than relying strictly on Sandstorm permissions.
  }
}

struct ActivityTypeDef {
  name @0 :Text;
  # Name of the type, used as an identifier for the type in cases where string names
  # are preferred. These names will never be used in Cap'n Proto interfaces, but could show up in
  # HTTP or JSON translations.
  #
  # The name must be a valid identifier (alphanumerics only, starting with a letter) and must be
  # unique among all types defined for a particular UiView.

  verbPhrase @1 :Util.LocalizedText;
  # Text of a verb phrase describing what the acting user did, e.g.:
  # * "edited document"
  # * "created new comment"
  # * "replied to comment"
  #
  # The activity log, when displayed, may contain text like:
  #
  #     Kenton Varda - 3 hours ago
  #     * edited document x13
  #     * created new comment
  #     * replied to comment x2
  #     Jade Wang - 2 hours ago
  #     * replied to comment x3
  #     * edited document x5

  description @2 :Util.LocalizedText;
  # Prose describing what this activity type means, suitable for a tool tip or similar help text.
  # Optional.

  requiredPermission :union {
    # Who is allowed to observe events of this type?

    everyone @3 :Void;
    # All users who have any access to this grain are allowed to observe this event.

    permissionIndex @4 :UInt16;
    # Users who have the given permission are allowed to observe this event.

    explicitList @5 :Void;
    # Only users explicitly listed.
  }

  obsolete @6 :Bool = false;
  # If true, this activity type was relevant in a previous version of the application but is no
  # longer used. The activity type will be hidden from the notification settings (and any events
  # of this type will not generate notifications).

  # The options below are hints controlling how users are notified of events. Note that these are
  # only hints; a user can potentially override whether or not a particular event causes a
  # notification through a variety of mechanisms. However, these hints are designed to be good
  # defaults.

  notifySubscribers @7 :Bool;
  # Should subscribers to this event (including subscribers to the event's thread, if any, and
  # subscribers to the event's grain) receive a notification of this event, by default?
  #
  # Note that when the user explicitly subscribes through they UI, they will have the opportunity
  # to choose exactly which event types they want to produce notifications. Moreover, when an app
  # provides a "subscribe" button in its own UI, and the user clicks it, the app can specify
  # different defaults that should apply to that button.
  #
  # Therefore, the `notifySubscribers` bit primarily serves two purposes:
  # - It applies to auto-subscriptions as created due to the `autoSubscribeToThread` or
  #   `autoSubscribeToGrain` bits (below).
  # - It applies when an update to the app defines a new type of event. Users who are subscribed
  #   to other kinds of notifications will be subscribed to the new notification type if and only
  #   if it has `notifySubscribers = true`.

  autoSubscribeToThread @8 :Bool;
  # Should the author of this event automatically become subscribed to the thread of which it is
  # a part? (If the event has no threadPath, this option has no effect.)
  #
  # Such an automatic subscription specifically subscribes the user to events which have
  # `notifySubscribers = true` (above).

  autoSubscribeToGrain @9 :Bool;
  # Should the author of this event automatically become subscribed to the grain?
  #
  # Such an automatic subscription specifically subscribes the user to events which have
  # `notifySubscribers = true` (above).

  suppressUnread @10 :Bool;
  # If true, this kind of activity does not cause the grain to be marked "unread". This is useful
  # for activities that should be logged but don't need attention.
}

struct NotificationDisplayInfo {
  caption @0 :Util.LocalizedText;
  # Text to display inside the notification box.

  # TODO(someday): "Body" containing extended text, for the body of an email or perhaps for display
  #   in the bell menu after the user clicks on the notification (Google+ style).
  # TODO(someday): Support notifications that can receive text replies. The replies are delivered
  #   to a provided capability. When notifications are delivered via email, Sandstorm can
  #   automatically support email replies. When notifications are delivered via the bell menu,
  #   Sandstorm can render an inline reply textarea (like Google+ notifications).
  # TODO(someday): Support rich interactive notifications, e.g. the ability to play/pause music
  #   via buttons.
}

interface NotificationTarget @0xf0f87337d73020f0 {
  # Represents a destination for notifications; usually, a user.
  #
  # TODO(someday): Expand on this and move it into `grain.capnp` when notifications are
  #   fully-implemented.

  addOngoing @0 (displayInfo :NotificationDisplayInfo, notification :OngoingNotification)
             -> (handle :Util.Handle);
  # Sends an ongoing notification to the notification target. `notification` must be persistent.
  # The notification is removed when the returned `handle` is dropped. The handle is persistent.
}

interface OngoingNotification @0xfe851ddbb88940cd {
  # Callback interface passed to the platform when registering a persistent notification.

  cancel @0 ();
  # Informs the notification creator that the user has requested cancellation of the task
  # underlying this notification.
  #
  # In the case of a `SandstormApi.stayAwake()` notification, after `cancel()` is called, the app
  # will no longer be held awake, so should prepare for shutdown.
  #
  # TODO(someday): We could allow the app to return some text to display to the user asking if
  #   they really want to shut down.
}
