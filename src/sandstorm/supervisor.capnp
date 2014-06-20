# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
#
# This file is part of the Sandstorm API, which is licensed under the MIT license:
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.

@0xc7205d6d32c7b040;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Util = import "util.capnp";
using Grain = import "grain.capnp";

interface Supervisor {
  # Default capability exported by the supervisor process.

  getMainView @0 () -> (view :Grain.UiView);
  # Get the grain's main UiView.

  keepAlive @1 ();
  # Must call periodically to prevent supervisor from killing itself off.  Call at least once
  # per minute.

  shutdown @2 ();
  # Shut down the grain immediately.  Useful e.g. when upgrading to a newer app version.  This
  # call will never return successfully because the process kills itself.

  getGrainSize @3 () -> (size :UInt64);
  # Get the total storage size of the grain.

  getGrainSizeWhenDifferent @4 (oldSize :UInt64) -> (size :UInt64);
  # Wait until the storage size of the grain is different from `oldSize` and then return the new
  # size. May occasionally return prematurely, with `size` equal to `oldSize`.
}
