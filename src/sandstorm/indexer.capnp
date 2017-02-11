# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2017 Sandstorm Development Group, Inc. and contributors
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

@0xcae98639575b2b35;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";

interface IndexingSession(Metadata) {
  # This is a UiView session type, created by calling UiView.newSession().
  #
  # Sandstorm requests a session of this type when it wants to index a grain for search purposes.
  #
  # Indexing sessions, like any other sessions, *must* pay attention to the UserInfo passed to
  # `newSession()`; only content which is visible to that user can be indexed.
  #
  # Note that, as an optimization, Sandstorm may start out assuming that all users see exactly
  # the same content, and may do all indexing as an anonymous user, perhaps with no permissions.
  # However, if the app logs an ActivityEvent that specifies that it requires specific permissions
  # or is visible only to certain users, Sandstorm uses that as a hint to index the path associated
  # with that event separately specifically for people who can see said event. Hence, if your app
  # has content that is visible to some users but not others, and that needs to be indexed, it
  # should be sure to log appropriate activity events.

  indexAll @0 (indexer :GrainIndexer(Metadata));
  # Asks the app to iterate through the grain's entire text contents, pushing it all to the given
  # indexer capability.

  indexPaths @1 (paths :List(Text), indexer :GrainIndexer(Metadata));
  # Index a specific list of paths. If a path in the list doesn't exist, calls `indexer.index()`
  # with `content` = null for that path.
}

interface GrainIndexer(Metadata) {
  # Capability used to index the content of a grain.
  #
  # This is a one-way capability. Although GrainIndexer is implemented by the indexer and is called
  # by arbitrary content grains, Sandstorm ensures that information cannot leak from the indexer to
  # the content grains by implementing a one-way message queue in between. When the content grain
  # calls index(), Sandstorm places the data in a queue and returns immediately. Later on,
  # Sandstorm takes calls from the queue and actually delivers them to the indexer. This means
  # that not only is the indexer unable to return data to the caller, but the caller cannot find
  # out how long it takes to process the call nor if it threw an exception.

  index @0 (path :Text, content :IndexableContent(Metadata));
  # Add content of the given path to the index.
  #
  # A null value for `content` indicates that the path doesn't exist.
  #
  # TODO(someday): When Cap'n Proto supports bulk-transfer methods with flow control, mark this
  #   method as such. This will cause the Cap'n Proto implementation to pretend the method has
  #   completed (resolving the promise) as soon as it's appropriate for the caller to make another
  #   call. For now, apps should pretend this is already in place, and make only one call at a
  #   time -- the current performance penalty in doing so probably isn't a big deal.
}

struct IndexableContent(Metadata) {
  body @0 :Text;
  # Freeform natural-language body text. Will be tokenized by the search indexer.

  links @1 :List(Grain.UiView);
  # Other grains that can be accessed through this content.

  threadPath @2 :Text;
  # Optional path of thread of which this item is a part, if any. See `ActivityEvent.thread`.

  metadata @3 :Metadata;
  # Metadata for search operators, e.g. "subject:", "author:", etc. Each app can define its own
  # metadata format.
  #
  # TODO(someday): Spec out how this works. Not needed for MVP of search.
}

# ========================================================================================
# Indexer implementation

interface IndexerSession {
  # A session type specifically implemented by the indexer app. The app's UiView's newSession()
  # supports this session type for the purpose of the platform informing the app of new content
  # to index.

  indexGrain @0 (info :GrainInfo) -> (indexer :GrainIndexer);
  # Begin a complete index of the given grain. Returns an indexer capability to which grain content
  # should be pushed. If any information about this grain (as identified by the grain ID) already
  # exists in the index, it should be deleted.
  #
  # The `grain` capability given here is sealed -- the only things the indexer can do with it are
  # save it and offer() it to the user via the search UI.

  updateGrain @1 (info :GrainInfo) -> (indexer :GrainIndexer);
  # Begin a partial index of the given grain. Specific paths passed to the indexer should be
  # replaced with new content, but other paths should be left alone. A call to `indexer.index()`
  # with a null `content` means that that specific entry should be deleted.

  struct GrainInfo {
    cap @0 :Grain.UiView;
    id @1 :Text;
    title @2 :Text;

    # TODO(now): If the grain is not directly in the user's capability store but was found by
    #   traversing through e.g. a collection, we need some info about said collection so that:
    #   1. It can be displayed to the user to tell them where this grain came from.
    #   2. If the user opens this grain, Sandstorm actually needs to traverse the path through
    #      other grains on-demand in order to get the target grain to land in the user's capability
    #      store. It can do this by opening new IndexingSessions on each intermediate grain and
    #      fetching just the desired path in order to get the capabilities, perhaps. Or maybe
    #      the sealed UiView capabilities passed to the indexer actually encapsulate this
    #      information, and the source app is required to properly revoke the previously-indexed
    #      capability if the item is deleted.
    #   Also need to think about what happens if the grain is accessible by multiple paths.

    # TODO(someday): Metadata schema?
  }

  # TODO(now): How do searches happen? It would be nice if the indexer could implement its own UI,
  #   but this runs into complication when we start doing multi-tier search: it's important that
  #   information cannot leak from a personal index to a group or public index (although
  #   information flow in the opposite direction is fine). We could have the shared index tiers
  #   report (via one-way communications) search results back to the personal indexer in an
  #   abtrirary format, which it would then merge with its own results. However, we would then not
  #   be able to make the search query box itself be part of the app, since the app could leak
  #   info by appending it to the queries. Maybe this is fine because there are a few reasons
  #   it would be better to keep the query box inside the shell (e.g. to avoid starting up the
  #   grain just to display the box), but how do "advanced searches" work?
}
