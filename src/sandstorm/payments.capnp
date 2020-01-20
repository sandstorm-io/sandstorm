# Sandstorm Blackrock
# Copyright (c) 2016 Sandstorm Development Group, Inc.
# All Rights Reserved
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

@0xd512486208994241;

$import "/capnp/c++.capnp".namespace("blackrock");

using import "util.capnp".LocalizedText;
using import "supervisor.capnp".SystemPersistent;

interface PaymentSource {
  # A payment source, like a credit card. Powerbox-request one of these in order to prompt the
  # user to choose a payment source or add a new one.

  getTitle @0 () -> (title :LocalizedText);
  # Probably something like: "VISA ***4242"
}

interface PaymentAcceptor {
  # Used to charge money from the user's credit card.
  #
  # Powerbox-request this capability in order to accept payments.
  #
  # The server admin on Blackrock can obtain a PaymentAcceptor that makes payments to the server's
  # bank account -- the same place where hosting subscription payments go.

  createPayment @0 (source :PaymentSource, invoice :Invoice)
                -> CreatePaymentResults;
  # Initiate a payment. If this completes successfully, the payment is authorized but has not yet
  # been committed. The app should commit the payment as soon as it is able to do so safely.
  # If not committed, the payment will eventually expire with no money being moved.
  #
  # In order to avoid double-payments, payments must use two-phase commit:
  # 1. Call createPayment() to authorize the payment. The payment is not actually paid yet.
  # 2. `save()` the returned Payment.
  # 3. Write a journal entry about the payment and the effect it should have once it completes, in
  #    such a way that applying said effect is idempotent. Make sure this entry is flushed to disk,
  #    such that if a failure occurs, the journal will be replayed later.
  # 4. Call payment.commit().
  # 5. Apply the changes which the payment is supposed to effect, flushing all changes to disk.
  # 6. Delete the journal entry or mark it committed, so that it doesn't replay.

  struct CreatePaymentResults {
    union {
      success :group {
        # Payment was authorized.
        payment @0 :Payment;
      }

      failed :group {
        # Payment was declined.
        description @1 :LocalizedText;
      }
    }
  }

  struct Invoice {
    items @0 :List(Item);
    struct Item {
      title @0 :LocalizedText;
      amountCents @1 :Int32;
    }
  }
}

interface Payment {
  # An authorized payment.

  commit @0 ();
  # Completes the payment, if it hasn't completed already. Returns successfully if the payment
  # succeeded (either as a result of this call or a previosu call). This call is idempotent.
}

interface PersistentPaymentSource extends(PaymentSource, SystemPersistent) {}
interface PersistentPaymentAcceptor extends(PaymentAcceptor, SystemPersistent) {}
interface PersistentPayment extends(Payment, SystemPersistent) {}
