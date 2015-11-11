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

@0xfe5c7cde99284f21;

$import "/capnp/c++.capnp".namespace("sandstorm");

using SystemPersistent = import "supervisor.capnp".SystemPersistent;

interface SealedUiView @0x8ccbcb3c38aa1574 {}
# An empty interface which the frontend is capable of automatically sealing for UiViews and
# unsealing when offered.

interface PersistentSealedUiView @0xa6511bdccae691a6 extends (SealedUiView, SystemPersistent) {}
# The interface which can be restored into a SealedUiView again.

