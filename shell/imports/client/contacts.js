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

import { Mongo } from "meteor/mongo";
import { SandstormDb } from "/imports/sandstorm-db/db";

const transform = function (contact) {
  SandstormDb.fillInPictureUrl(contact);
  return contact;
};

const ContactProfiles = new Mongo.Collection("contactProfiles", { transform: transform });
// A psuedo-collection used to store the results of joining Contacts with identity profiles.
//
// Each contains:
//   _id: the id of identity (from Meteor.users collection)
//   profile: the profile of the identity (see db.js for fields in this object) with profile
//     default values, `intrinsicName`, and `pictureUrl` filled in.

export { ContactProfiles };
