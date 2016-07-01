# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014-2016 Sandstorm Development Group, Inc. and contributors
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

@0xf6c200ab14cd53e4;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";

# ========================================================================================
# Powerbox
#
# The powerbox is part of the Sandstorm UI which allows users to connect applications to each
# other. There are two main modes in which a powerbox interaction can be driven: "request" and
# "offer".
#
# In "request" mode, an app initiates the powerbox by requesting to receive a capability matching
# some particular criteria using `SessionContext.request()` (or through the client-side
# postMessage() API, described in the documentation for `SessionContext.request()`). The user is
# presented with a list of other grains of theirs which might be able to fulfill this request and
# asked to choose one. Other grains initially register their ability to answer certain requests
# by filling in the powerbox fields of `UiView.ViewInfo`. When the user chooses a grain,
# `UiView.newRequestSession()` is called on the providing grain and the resulting UI session is
# displayed embedded in the powerbox. The providing grain can render a UI which prompts the user
# for additional details if needed, or implements some sort of additional picker. Once the grain
# knows which capability to provide, it calls `SessionContext.provide()` to fulfill the original
# request.
#
# In "offer" mode, an app initiates the powerbox by calling `SessionContext.offer()` in a normal,
# non-powerbox session, to indicate that it wishes to offer some capability to the current user
# for use in other apps. The user is presented with a list of apps and grains that are able to
# accept this offer. Grains can register interest in receiving offers by filling in the powerbox
# metadata in `UiView.ViewInfo`. Apps can also indicate in their manifest that it makes sense for a
# user to create a whole new grain to accept a powerbox offer. In either case, a session is created
# using `UiView.newOfferSession()`.

struct PowerboxDescriptor {
  # Describes properties of capabilities exported by the powerbox, or capabilities requested
  # through the powerbox.
  #
  # A PowerboxDescriptor specified individually describes the properties of a single object or
  # capability. It is a conjunction of "tags" describing different aspects of the object, such as
  # which interfaces it implements.
  #
  # Often, descriptors come in a list, i.e. List(PowerboxDescriptor). Such a list is usually a
  # disjunction describing one of two things:
  # - A powerbox "query" is a list of descriptors used in a request to indicate what kinds of
  #   objects the requesting app is looking for. (In a powerbox "offer" interaction, the "query"
  #   is the list of descriptors that the accepting app indicated it accepts in its `ViewInfo`.)
  # - A powerbox "provision" is a list of descriptors used to describe what kinds of objects an
  #   app provides, which can be requested by other apps. (In a powerbox "offer" interaction, the
  #   "provision" consists of the single descriptor that the offering app passed to `offer()`.)
  #
  # For a query to match a provision, at least one descriptor in the query must match at least one
  # descriptor in the provision (with an acceptable `matchQuality`; see below).
  #
  # Note that, in some use cases, where the "object" being granted is in fact just static data,
  # that data may be entirely encoded in tags, and the object itself may be a null capability.
  # For example, a powerbox request for a "contact" may result in a null capability with a tag
  # containing the contact details. Apps are free to define such conventions as they see fit; it
  # makes no difference to the system.

  tags @0 :List(Tag);
  # List of tags. For a query descriptor to match a provision descriptor, every tag in the query
  # must be matched by at least one tag in the provision. If the query tags list is empty, then
  # the query is asking for any capability at all; this occasionally makes sense in "meta" apps
  # that organize or communicate general capabilities.

  struct Tag {
    id @0 :UInt64;
    # A unique ID naming the tag. All such IDs should be created using `capnp id`.
    #
    # It is up to the developer who creates a new ID to decide what type the tag's `value` should
    # have (if any). This should be documented where the ID is defined, e.g.:
    #
    #     const preferredFrobberTag :UInt64 = 0xa170f46ec4b17829;
    #     # The value should be of type `Text` naming the object's preferred frobber.
    #
    # By convention, however, a tag ID is *usually* a Cap'n Proto type ID, with the following
    # meanings:
    #
    # * If `id` is the Cap'n Proto type ID of an interface, it indicates that the described
    #   powerbox capability will implement this interface. The interface's documentation may define
    #   what `value` should be in this case; otherwise, it should be null. (For example, a "file"
    #   interface might define that the `value` should be some sort of type descriptor, such as a
    #   MIME type. Most interfaces, however, will not define any `value`; the mere fact that the
    #   object implements the interface is the important part.)
    #
    # * If `id` is the type ID of a struct type, then `value` is an instance of that struct type.
    #   The struct type's documentation describes how the tag is to be interpreted.
    #
    # Note that these are merely conventions; nothing in the system actually expects tag IDs to
    # match Cap'n Proto type IDs, except possibly debugging tools.

    value @1 :AnyPointer;
    # An arbitrary value expressing additional metadata related to the tag.
    #
    # This is optional. "Boolean" tags (where all that matters is that they are present or
    # absent) -- including tags that merely indicate that an interface is implemented -- may leave
    # this field null.
    #
    # When "matching" two descriptors (one of which is a "query", and the other of which describes
    # a "provision"), the following algorithm is used to decide if they match:
    #
    # * A null pointer matches any value (essentially, null = wildcard).
    # * Pointers pointing to different object types (e.g. struct vs. list) do not match.
    # * Two struct pointers match if the primitive fields in both structs have identical values
    #   (bit for bit) and the corresponding pointer fields match by applying this algorithm
    #   recursively.
    # * Two lists of non-struct elements match if their contents match exactly.
    # * Lists of structs are treated as *sets*. They match if every element in the query list
    #   matches at least one element in the provider list. Order of elements is irrelevant.
    #
    # The above algorithm may appear quirky, but is designed to cover common use cases while being
    # relatively simple to implement. Consider, for example, a powerbox query seeking to match
    # "video files". All "files" are just byte blobs; file managers probably don't implement
    # different interfaces for different file types. So, you will want to use tags here. For
    # example, a MIME type tag might be defined as:
    #
    #     struct MimeType {
    #       category @0 :Text;
    #       subtype @1 :Text;
    #       tree @2 :Text;    // e.g. "vnd"
    #       suffix @3 :Text;  // e.g. "xml"
    #       params @4 :List(Param);
    #       struct Param {
    #         name @0 :Text;
    #         value @1 :Text;
    #       }
    #     }
    #
    # You might then express your query with a tag with `id` = MimeType's type ID and value =
    # `(category = "video")`, which effectively translates to a query for "video/*". (Your query
    # descriptor would have a second tag to indicate what Cap'n Proto interface the resulting
    # capability should implement.)
  }

  quality @1 :MatchQuality = acceptable;
  # Use to indicate a preference or anti-preference for this descriptor compared to others in the
  # same list.
  #
  # When a descriptor in the query matches multiple descriptors in the provision, or vice versa,
  # exactly one of the matches is chosen to decide the overall `matchQuality`, as follows:
  # - If one matching descriptor is strictly less-specific than some other in the match set, it is
  #   discarded. (A descriptor A is strictly less-specific than a descriptor B if every possible
  #   match for B would also match A.)
  # - Once all less-specific descriptors are eliminated, of those that remains, the descriptor with
  #   the best `matchQuality` is chosen.

  enum MatchQuality {
    # The values below are listed in order from "best" to "worst". Note that this ordering does NOT
    # correspond to the numeric order. Also note that new values could be introduced in the future.

    preferred @1;
    # Indicates that this match should be preferred over other options. The powerbox UI may
    # encourage the user to choose preferred options. For example, a document editor that uses
    # the powerbox to import document files might indicate that it accepts docx format but prefers
    # odf, perhaps because its importer for the latter is higher-quality. Similarly, it might
    # publish powerbox capabilities to export as either format, but again mark odf as preferred.
    #
    # Note `preferred` is only meaningful if the descriptor list contains other descriptors that
    # are marked `acceptable`. An app cannot promote itself over other apps by marking its
    # provisions as `preferred`. (A requesting app could indicate a preference for a particular
    # providing app, though, if the providing app provides a unique tag that the requestor can
    # mark as preferred.)

    acceptable @0;
    # Indicates that this is a fine match which should be offered to the user as a regular option.
    # This is the default.

    # TODO(someday): mightWork @3;
    # Indicates that the match might have useful results but there is a non-negligible priority
    # that it won't work, and this option should be offered to the user only as an advanced option.

    unacceptable @2;
    # "Unacceptable" matches are expected *not* to work and therefore will not be offered to the
    # user.
    #
    # Note that `unacceptable` can be used to filter out a subset of matches of a broader
    # descriptor by taking advantage of the fact that the powerbox prefers more-specific matches
    # over less-specific ones. For instance, you could query for "files except video files" by
    # specifying a query with two descriptors: a descriptor for "implements File" with quality
    # "acceptable" and a second descriptor for "implements File with type = video" with quality
    # "unacceptable".
  }
}

struct PowerboxDisplayInfo {
  # Information about a powerbox link (i.e., the result of a powerbox interaction) which could be
  # displayed to the user when auditing powerbox-granted capabilities.

  title @0 :Util.LocalizedText;
  # A short, human-readable noun phrase describing the object this capability represents. If null,
  # the grain's title will be used -- this is appropriate if the capability effectively represents
  # the whole grain.
  #
  # The title is used, for example, when the user is selecting multiple capabilities, building a
  # list.

  verbPhrase @1 :Util.LocalizedText;
  # Verb phrase describing what the holder of this capability can do to the grain, e.g.
  # "can edit".  This may be displayed in the sharing UI to describe a connection between two
  # grains.

  description @2 :Util.LocalizedText;
  # Long-form description of what the capability represents.  Should be roughly a paragraph that
  # could be displayed e.g. in a tooltip.
}
