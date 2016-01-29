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

@0xd5d3e63bd0a552b6;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";
using Handle = Util.Handle;

interface WebSite {
  # Represents an HTTP URL to which a web site can be published.
  #
  # Make a powerbox request for `WebSite` when you wish to publish a web site accessible over HTTP
  # without going through the Sandstorm UI.

  getUrl @0 () -> (path :Text);
  # Get the URL of this resource.

  struct Entity {
    # An HTTP entity (using the term "entity" as defined in the HTTP spec). Think of this as the
    # "payload" of an HTTP response.

    mimeType @0 :Text;  # Content-Type header.
    language @1 :Text;  # Content-Language header (optional).
    encoding @2 :Text;  # Content-Encoding header (optional).

    body :union {
      bytes @3 :Data;
      # Use when content is smaller than 1MB.

      blob @4 :Util.Blob;
      # Use when content is larger than 1MB. Currently, the blob must be created via uploadBlob().
    }
  }

  getEntities @1 (path :Text) -> (entities :Util.Assignable(List(Entity)));
  # Get the list of static HTTP entities that make up the resource at the given path. Often there
  # is only one entity, but if you provide multiple entities, one will be chosen based on "Accept"
  # headers provided by the client. Setting the entity list empty effectively deletes the resource;
  # the client will receive a 404 error, which can be customizedb using `getNotFoundEntities()`.
  #
  # The path normally should not contain the character '?' nor '#'; if it does, then requests for
  # this resource will have to URL-escape those characters since otherwise they have special
  # meanings.

  getNotFoundEntities @2 () -> (entities :Util.Assignable(List(Entity)));
  # Get the entity set used to respond when a path is not found. Such responses also have HTTP
  # error code 404.

  uploadBlob @3 () -> (blob :Util.Blob, stream :Util.ByteStream);
  # Upload a data blob to be stored by the driver and possibly used as an entity-body.
  #
  # The content of the blob must be written to the returned stream. Once `done()` is called on the
  # stream, the blob is ready. Before that point, calling methods on the blob may block waiting
  # until enough data has actually been uploaded for them to respond. If the stream is dropped
  # without calling `done()`, the blob will be left in a broken state in which some methods will
  # throw exceptions.

  getSubsite @4 (suffix :Text) -> (site :WebSite);
  # Append `suffix` to the URL and return a `WebSite` capability that can only modify resources
  # under that URL. Note that the web driver assigns *no* special meaning to the character '/', so
  # you should use a suffix ending in '/' if you want a site that represents a subdirectory.

  # TODO(someday): Allow registering dynamaic handlers.

  # TODO(someday): Allow transactionally changing a bunch of things at once.
}
