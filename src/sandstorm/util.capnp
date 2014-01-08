# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
# All rights reserved.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice, this
#    list of conditions and the following disclaimer.
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
# ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
# WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
# DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
# ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
# (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
# LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
# ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
# (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
# SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

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
