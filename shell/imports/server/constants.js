// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// A collection of some global variables used in multiple places.

import { Meteor } from "meteor/meteor";
import Url from "url";

const SANDSTORM_ALTHOME = Meteor.settings && Meteor.settings.home;
const SANDSTORM_LOGDIR = (SANDSTORM_ALTHOME || "") + "/var/log";
const SANDSTORM_VARDIR = (SANDSTORM_ALTHOME || "") + "/var/sandstorm";

// TODO: dedupe this and the equivalent copy in sandstorm-db
const wildcardHost = Meteor.settings.public.wildcardHost.toLowerCase().split("*");

const staticAssetHost = `${Url.parse(process.env.ROOT_URL).protocol}//${wildcardHost[0]}static${wildcardHost[1]}`;

export { SANDSTORM_ALTHOME, SANDSTORM_LOGDIR, SANDSTORM_VARDIR, staticAssetHost };
