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

import { Match } from "meteor/check";

const createDesktopNotification = (options) => {
  Match.check(options, {
    identityId: String,
    action: Match.OneOf({
      grain: {
        grainId: String,
        path: Match.Optional(String),
      },
    }),
    title: String,
    body: Match.Optional(String),
    iconUrl: Match.Optional(String),
    badgeUrl: Match.Optional(String),
  });

  globalDb.collections.desktopNotifications.insert({
    identityId: options.identityId,
    grainId: options.grainId,
    path: options.path,
    title: options.title,
    body: options.body,
    iconUrl: options.iconUrl,
    badgeUrl: options.badgeUrl,
    creationDate: new Date(),
  });
};

export { createDesktopNotification };
