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

import Crypto from "crypto";
import { Meteor } from "meteor/meteor";
import { check } from "meteor/check";

import Capnp from "/imports/server/capnp.js";
const PaymentsRpc = Capnp.importSystem("sandstorm/payments.capnp");

function wrapAsyncAsPromise(obj, func) {
  if (typeof func === "string") {
    func = obj[func];
  }

  return function () {
    const args = [...arguments];
    return new Promise((resolve, reject) => {
      const callback = (err, result) => {
        if (err) {
          reject(err);
        } else {
          resolve(result);
        }
      };
      args.push(callback);
      func.apply(obj, args);
    });
  }
}

const retrieveSource = wrapAsyncAsPromise(stripe.customers, "retrieveSource");
const createCharge = wrapAsyncAsPromise(stripe.charges, "create");
const captureCharge = wrapAsyncAsPromise(stripe.charges, "capture");
const retrieveCharge = wrapAsyncAsPromise(stripe.charges, "retrieve");

function formatCents(cents) {
  return (cents / 100).toFixed(2);
}

BlackrockPayments.registerPaymentsApi =
    (frontendRefRegistry, PersistentImpl, unwrapFrontendCap) => {
  class PaymentSourceImpl extends PersistentImpl {
    // A payment source, such as a credit card.
    //
    // frontendRef.stripePaymentSource contains:
    //   customer: Stripe customer ID.
    //   source: Stripe source ID, e.g. "card_18YkudJdON0GsGxm4oeQYqV5".

    constructor(db, saveTemplate, params) {
      super(db, saveTemplate);
      this._customer = params.customer;
      this._source = params.source;
    }

    getTitle() {
      return retrieveSource(this._customer, this._source).then(source => {
        if (source.object === "card") {
          return { title: { defaultText: source.brand + " **" + source.last4 } };
        } else {
          return { title: { defaultText: "Unknown payment source type" } };
        }
      });
    }
  }

  frontendRefRegistry.register({
    frontendRefField: "stripePaymentSource",
    typeId: PaymentsRpc.PaymentSource.typeId,

    restore(db, saveTemplate, params) {
      return new Capnp.Capability(new PaymentSourceImpl(db, saveTemplate, params),
                                  PaymentsRpc.PersistentPaymentSource);
    },

    validate(db, session, value) {
      check(value, { source: String });

      if (!session.userId) {
        throw new Meteor.Error(403, "Not logged in.");
      }

      const user = Meteor.users.findOne(session.userId);
      value.customer = ((user || {}).payments || {}).id;
      if (!value.customer) {
        throw new Meteor.Error(403, "No such payment source.");
      }

      value.source = findOriginalSourceId(value.source, value.customer);

      return {
        descriptor: { tags: [{ id: PaymentsRpc.PaymentSource.typeId }] },
        requirements: [],
        frontendRef: value,
      };
    },

    query(db, userId, value) {
      const user = Meteor.users.findOne(userId);
      const customerId = ((user || {}).payments || {}).id;

      const addCardSource = {
        _id: "frontendref-stripeAddPaymentSource",
        cardTemplate: "stripeAddPaymentSourcePowerboxOption",
        configureTemplate: "stripeAddPaymentSourcePowerboxConfiguration",
      };

      if (!customerId) {
        return [addCardSource];
      }

      const data = Meteor.wrapAsync(stripe.customers.retrieve.bind(stripe.customers))(customerId);
      if (!data.sources || !data.sources.data) {
        return [addCardSource];
      }

      const sources = data.sources.data.map(source => {
        const clean = sanitizeSource(source, source.id === data.default_source);
        return {
          _id: "frontendref-stripePaymentSource-" + clean.id,
          frontendRef: { stripePaymentSource: { source: clean.id } },
          cardTemplate: "stripePaymentSourcePowerboxOption",
          stripeSourceInfo: clean,
        };
      });

      sources.push(addCardSource);

      return sources;
    },
  });

  // ---------------------------------------------------------------------------

  class PaymentAcceptorImpl extends PersistentImpl {
    // A payment acceptor. This capability exists primarily to prevent non-admins from arranging
    // to collect payments (even though the payments would still go to the server's bank account).
    //
    // frontendRef.stripePaymentAcceptor is an empty object.

    constructor(db, saveTemplate, config) {
      super(db, saveTemplate);
      this._db = db;
      this._config = config;
    }

    createPayment(source, invoice) {
      return unwrapFrontendCap(source, "stripePaymentSource", source => {
        const description = (invoice.items || []).map(item => {
          return item.title.defaultText + " $" + formatCents(item.amountCents);
        }).join("; ");

        let total = 0;
        invoice.items.forEach(item => total += item.amountCents);

        return createCharge({
          amount: total,
          currency: "usd",
          customer: source.customer,
          source: source.source,
          description: description,
          capture: false,
        });
      }).then(charge => {
        const payment = frontendRefRegistry.create(this._db, {
          stripePayment: { id: charge.id, invoice: invoice, config: this._config }
        }, []);

        return { success: { payment } };
      }, err => {
        console.error("Payment declined:", err);
        return { failed: { description: { defaultText: err.message } } };
      });
    }
  }

  frontendRefRegistry.register({
    frontendRefField: "stripePaymentAcceptor",
    typeId: PaymentsRpc.PaymentAcceptor.typeId,

    restore(db, saveTemplate, params) {
      return new Capnp.Capability(new PaymentAcceptorImpl(db, saveTemplate, params),
                                  PaymentsRpc.PersistentPaymentAcceptor);
    },

    validate(db, session, value) {
      check(value, {
        acceptorTitle: String,
        returnAddress: String,
        settingsUrl: String,
      });

      if (!session.userId) {
        throw new Meteor.Error(403, "Not logged in.");
      }

      return {
        descriptor: { tags: [{ id: PaymentsRpc.PaymentAcceptor.typeId }] },
        requirements: [{ userIsAdmin: session.userId }],
        frontendRef: value,
      };
    },

    query(db, userId, value) {
      if (userId && Meteor.users.findOne(userId).isAdmin) {
        return [
          {
            _id: "frontendref-stripePaymentAcceptor",
            cardTemplate: "stripePaymentAcceptorPowerboxOption",
            configureTemplate: "stripePaymentAcceptorPowerboxConfiguration",
          },
        ];
      } else {
        return [];
      }
    },
  });

  // ---------------------------------------------------------------------------

  class PaymentImpl extends PersistentImpl {
    // A payment source, such as a credit card.
    //
    // frontendRef.stripePayment contains:
    //   id: The charge ID.

    constructor(db, saveTemplate, params) {
      super(db, saveTemplate);
      this._db = db;
      this._id = params.id;
      this._invoice = params.invoice;
      this._config = params.config;
    }

    commit() {
      // TODO(now): Handle throw, especially for already captured.
      return captureCharge(this._id).then(charge => {
        const user = Meteor.users.findOne({ "payments.id": charge.customer });
        if (user) {
          sendInvoice(this._db, user, this._invoice, this._config);
        } else {
          console.error("Stripe charge didn't match any user: " + charge.id);
        }
      }, err => {
        // The error could be because the charge was already captured, but the only indication
        // Stripe gives of this in the error is in the natural-language description, and I'm not
        // about to try to match on it. So, we try to fetch the charge to check if it is captured.
        return retrieveCharge(this._id).then(charge => {
          if (!charge.captured) {
            // Not captured, so the error must be something else.
            throw err;
          }
        }, err2 => {
          // Couldn't fetch the charge, probably for the same reason we couldn't capture it. Throw
          // the original error.
          throw err;
        });
      });
    }
  }

  frontendRefRegistry.register({
    frontendRefField: "stripePayment",

    restore(db, saveTemplate, params) {
      return new Capnp.Capability(new PaymentImpl(db, saveTemplate, params),
                                  PaymentsRpc.PersistentPayment);
    },

    // Note: You can't powerbox-query for a payment.
  });
}
