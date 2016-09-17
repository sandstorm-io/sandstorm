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
import { send } from "/imports/server/email.js";
import { computeTitleFromTokenOwnerUser } from "/imports/model-helpers.js";

function escapeHtmlForEmail(rawText) {
  return rawText.replace(/[&<>\n]/gm, (m) => {
    if (m == "&") return "&amp;";
    if (m == "<") return "&lt;";
    if (m == ">") return "&gt;";
    if (m == "\n") return "<br>";
  });
}

const appActivityShape = {
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
};

function createAppActivityDesktopNotification(options) {
  check(options, {
    userId: String,
    identityId: String,
    notificationId: String,
    appActivity: appActivityShape,
  });

  globalDb.collections.desktopNotifications.insert({
    userId: options.userId,
    identityId: options.identityId,
    notificationId: options.notificationId,
    creationDate: new Date(),
    appActivity: options.appActivity,
    deliveredToUser: false,
  });
}

function deliverNotificationViaEmail(db, doc) {
  // If email is not configured on this server, don't bother trying to send any.
  const smtpConfig = db.getSmtpConfig();
  const emailUnconfigured = (!smtpConfig.hostname || !smtpConfig.port || !smtpConfig.returnAddress);
  if (emailUnconfigured) return;

  check(doc, {
    _id: String,
    userId: String,
    identityId: Match.Optional(String), // Older versions of Sandstorm didn't record identityIds
    notificationId: String,
    creationDate: Date,
    appActivity: appActivityShape,
    deliveredToUser: Boolean,
  });

  if (!doc.identityId) return;

  // Unpack.
  const { userId, identityId, notificationId, appActivity } = doc;
  const { grainId, path, body, actionText } = appActivity;
  const actingUser = appActivity.user;

  // Compute the title of the grain, as seen by userId (the account to which the email is being
  // delivered)
  const grainTitle = db.userGrainTitle(grainId, userId, identityId);

  // Pick the name and address to send this mail to and from
  const toAddress = db.getPrimaryEmail(userId, identityId);
  const toName = db.getIdentity(identityId).profile.name;
  const to = {
    name: toName,
    address: toAddress,
  };
  const from = {
    name: actingUser.name,
    address: db.getReturnAddress(),
  };

  // Construct an email
  const threadUrl = `${process.env.ROOT_URL}/grain/${grainId}/${path}`;
  const muteUrl = ""; // TODO(now): implement thread-muting route?

  const actingUserText = actingUser.name;
  // TODO(someday): localization rather than jumping to defaultText
  const actionTextText = actionText.defaultText;
  const bodyText = body.defaultText;
  let eventSummaryText;
  if (bodyText) {
    eventSummaryText = `${actingUserText} ${actionTextText}:

${bodyText}`;
  } else {
    eventSummaryText = `${actingUserText} ${actionTextText}`;
  }

  const text = `${eventSummaryText}

----
You are receiving this because you are subscribed to this thread.
View on ${db.getServerTitle()}:

${threadUrl}

Mute this thread:

${muteUrl}
`;

  // N.B. make sure to escape any strings/data interpolated into the HTML below that are controlled
  // by 3rd parties.
  // TODO(someday): localization rather than jumping to defaultText
  const bodyHtml = escapeHtmlForEmail(body.defaultText);
  const actingUserNameHtml = escapeHtmlForEmail(actingUser.name);
  const actionTextHtml = escapeHtmlForEmail(actionText.defaultText);
  let eventSummaryHtml;
  if (bodyHtml) {
    eventSummaryHtml = `<p>${actingUserNameHtml} ${actionTextHtml}:</p>

<p>${bodyHtml}</p>
`;
  } else {
    eventSummaryHtml = `<p>${actingUserNameHtml} ${actionTextHtml}</p>
`;
  }

  const html = `${eventSummaryHtml}

----<br>
You are receiving this because you are subscribed to this thread.<br>
<a href="${threadUrl}">View on ${db.getServerTitle()}</a> or <a href="${muteUrl}">mute the thread</a>.
`;

  const emailOpts = {
    from,
    to,
    // TODO(someday): add `replyTo` support plumbing replies back to the sending grain
    subject: grainTitle,
    text,
    html,
    envelopeFrom: db.getReturnAddress(),
    // TODO(someday): add mailinglist headers to make reply-to-unsubscribe magic work.
    // Probably needs some way to check that replies actually get routed back to the server.
  };

  // Actually send the mail.
  send(emailOpts);
}

export { createAppActivityDesktopNotification, deliverNotificationViaEmail };
