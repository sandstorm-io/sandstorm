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

@0xecd50d792c3d9992;

$import "/capnp/c++.capnp".namespace("sandstorm");

struct KeyValue {
  key @0 :Text;
  value @1 :Text;
}

struct LocalizedText {
  # Text intended to be displayed to a user.  May be localized to multiple languages.
  #
  # TODO(soon):  Maybe instead of packing all translations in here, we should have a message code
  #   and parameter substitutions, with the (message code, locale) -> text map stored elsewhere?

  defaultText @0 :Text;
  # What to display if no localization matching the user's preferences is available.

  localizations @1 :List(Localization);
  # Localized versions of the text.

  struct Localization {
    locale @0 :Text;  # IETF BCP 47 locale, e.g. "en" or "en-US".
    text @1 :Text;    # Localized text.
  }
}

interface Handle {
  # Arbitrary handle to some resource provided by the platform.  Can be persisted.
  #
  # To "drop" a handle means to discard any live references and delete any sturdy references.
  # The purpose of a handle is to detect when it has been dropped and to free the underlying
  # resource at that time.
}

interface Variable {
  # A "variable" -- a value that changes over time.  Supports subscribing to updates.
  #
  # TODO(someday):  This should be a parameterized type, when Cap'n Proto supports that.

  get @0 () -> (value :AnyPointer, setter :Setter);
  # The returned setter's set() can only be called once, and throws an exception if the variable
  # has changed since `getForUpdate()` was called.  This can be used to implement optimistic
  # concurrency.

  asGetter @1 () -> (getter :Getter);
  # Return a read-only capability for this variable, co-hosted with the variable itself for
  # performance.  If the varibale is persistable, the getter is as well.

  asSetter @2 () -> (setter :Setter);
  # Return a write-only capability for this variable, co-hosted with the variable itself for
  # performance.  If the varibale is persistable, the setter is as well.

  interface Getter {
    get @0 () -> (value :AnyPointer);

    pushTo @1 (setter :Setter) -> (handle :Handle);
    # Subscribe to updates.  Calls the given setter any time the variable's value changes.  Drop
    # the returned handle to stop receiving updates.  If the variable is persistent, `setter` must
    # be as well.
  }

  interface Setter {
    set @0 (value :AnyPointer) -> ();
  }
}
