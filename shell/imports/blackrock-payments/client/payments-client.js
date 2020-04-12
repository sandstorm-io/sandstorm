// Sandstorm Blackrock
// Copyright (c) 2015-2016 Sandstorm Development Group, Inc.
// All Rights Reserved
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

import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";

StripeCustomerData = new Mongo.Collection(null);  // see getStripeData for where this is produced
StripeCards = new Mongo.Collection(null);

updateStripeData = function (cb) {
  Meteor.call("getStripeData", function (err, data) {
    if (err) {
      alert(err); // TODO(soon): make this UI better
    } else {
      StripeCustomerData.upsert({_id: '0'}, {
          email: data.email,
          subscription: data.subscription ||
              (Meteor.user().plan === "free" ? "free" : undefined),
          subscriptionEnds: data.subscriptionEnds,
          credit: data.credit});
      if (data.sources) {
        sources = data.sources;
        for (var i = 0; i < sources.length; i++) {
          StripeCards.upsert({_id: sources[i].id}, sources[i]);
        }
      }
      if (cb) {
        cb();
      }
    }
  });
}

BlackrockPayments = function (db) {
  this.db = db
}

BlackrockPayments.processOptins = function (form) {
  if (form.subscribeToList && form.subscribeToList.checked) {
    Meteor.call("subscribeMailingList", function(err) {
      if (err) window.alert("Error subscribing to list: " + err.message);
    });
  }
};

BlackrockPayments.MAILING_LIST_BONUS = MAILING_LIST_BONUS;

// Client-side method simulations.
Meteor.methods({
  unsubscribeMailingList: function () {
    Meteor.users.update({_id: Meteor.userId()}, {$set: {"payments.bonuses.mailingList": false}});
  },
  subscribeMailingList: function () {
    Meteor.users.update({_id: Meteor.userId()}, {$set: {"payments.bonuses.mailingList": true}});
  }
});
