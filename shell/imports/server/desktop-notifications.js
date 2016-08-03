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

import { Match, check } from "meteor/check";

const createAppActivityDesktopNotification = (options) => {
  check(options, {
    userId: String,
    notificationId: String,
    appActivity: {
      user: {
        identityId: String,
        name: String,
        avatarUrl: String,
      },
      grainId: String,
      path: String,
      body: Match.ObjectIncluding({
        defaultText: String,
      }),
      actionText: Match.ObjectIncluding({
        defaultText: String,
      }),
    },
  });

  globalDb.collections.desktopNotifications.insert({
    userId: options.userId,
    notificationId: options.notificationId,
    creationDate: new Date(),
    appActivity: options.appActivity,
  });
};

export { createAppActivityDesktopNotification };
