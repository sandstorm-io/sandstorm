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
using UiView = import "grain.capnp".UiView;

interface PersistentUiView extends (UiView, SystemPersistent) {}
# An interface which can be restored into a UiView again.
# Note that when restored by a grain, the UiView restored will not by default carry the `isHuman`
# pseudoprivilege, which is required to actually make any calls on a UiView.
