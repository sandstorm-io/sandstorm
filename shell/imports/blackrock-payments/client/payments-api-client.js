// Sandstorm Blackrock
// Copyright (c) 2016 Sandstorm Development Group, Inc.
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
import { Template } from "meteor/templating";
import { ReactiveVar } from "meteor/reactive-var";
import { _ } from "meteor/underscore";

import { SandstormDb } from "/imports/sandstorm-db/db.js";
import { updateStripeData }
  from "/imports/blackrock-payments/client/payments-client.js";

Template.stripePaymentAcceptorPowerboxConfiguration.events({
  "submit form"(event) {
    event.preventDefault();

    this.powerboxRequest.completeNewFrontendRef({
      stripePaymentAcceptor: {
        acceptorTitle: event.currentTarget.acceptorTitle.value,
        returnAddress: event.currentTarget.returnAddress.value,
        settingsUrl: event.currentTarget.settingsUrl.value,
      },
    });
  }
});

let counter = 0;

Template.stripeAddPaymentSourcePowerboxConfiguration.onCreated(function () {
  // TODO(cleanup): There's a lot of repeated code between this and the billing settings, but
  //   factoring out the common parts looked hard so I punted. Probably we should eventually
  //   replace the whole thing with a form that we render ourselves, rather than rely on Stripe's
  //   checkout.js.

  updateStripeData();
  this.addCardPrompt = new ReactiveVar(false);
  this.id = "stripe-powerbox-add-card-" + (counter++);
  this.listener = event => {
    if (event.origin !== window.location.protocol + "//" + makeWildcardHost("payments")) {
      return;
    }

    if (event.data.id !== this.id) {
      return;
    }

    if (event.data.showPrompt) {
      // ignore
      return;
    }

    if (event.data.token) {
      Meteor.call("addCardForUser", event.data.token.id, event.data.token.email, (err, source) => {
        if (err) {
          this.data.powerboxRequest.failRequest(err);
        } else {
          this.data.powerboxRequest.completeNewFrontendRef({
            stripePaymentSource: {
              source: source.id
            },
          });
        }
      });
    }

    if (event.data.error) {
      this.data.powerboxRequest.cancelRequest();
    }
  };

  window.addEventListener("message", this.listener, false);
});

Template.stripeAddPaymentSourcePowerboxConfiguration.onDestroyed(function () {
  window.removeEventListener("message", this.listener, false);
});

Template.stripeAddPaymentSourcePowerboxConfiguration.helpers({
  paymentsUrl: function () {
    return window.location.protocol + "//" + makeWildcardHost("payments");
  },

  checkoutData: function () {
    var template = Template.instance();
    var primaryEmail = _.findWhere(SandstormDb.getUserEmails(Meteor.user()), {primary: true});
    if (!primaryEmail) return;
    return encodeURIComponent(JSON.stringify({
      name: 'Sandstorm Oasis',
      panelLabel: "Add Card",
      email: primaryEmail.email,
      id: template.id,
      openNow: true,
    }));
  },
});

Template.stripePaymentSourcePowerboxOption.powerboxIconSrc = () => "/credit-m.svg";
Template.stripeAddPaymentSourcePowerboxOption.powerboxIconSrc = () => "/add-credit-m.svg";
