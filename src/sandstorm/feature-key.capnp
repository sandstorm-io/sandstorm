# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2016 Sandstorm Development Group, Inc. and contributors
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

@0xd24581e9cd6a6772;

using PublicSigningKey = import "update-tool.capnp".PublicSigningKey;

$import "/capnp/c++.capnp".namespace("sandstorm");

struct FeatureKey {
  # A FeatureKey describes a customer of Sandstorm for Work and the features for which
  # they have paid. This "key" is actually more of a certificate: it is a signed statement.
  # However, it is also a key in that it alone unlocks the features, and should be treated as
  # a secret.
  #
  # A complete key is formed by:
  # 1) Serialize a FeatureKey in Cap'n Proto packed format. (Note that canonicalization
  #    is not necessary, since we don't use detached signatures.)
  # 2) Sign it using libsodium's crypto_box_easy().
  # 3) Base64 the whole thing, for easy copy/paste.
  # 4) Optionally insert newlines or other whitespace for readability.
  # 5) Optionally add lines beginning with '-', which will be ignored. (Commonly, lines like
  #    "---- BEGIN SANDSTORM FEATURE KEY ----" are added to delimit the whole cert.)

  secret @0 :Data;
  # Secret ID of this key. Do not share this. If shared, others may be able to bill the
  # account, and/or the key may be revoked, disrupting service.

  struct Customer {
    # Information about the customer. This primarily identifies who is paying.

    id @0 :UInt64;              # non-secret database ID of this customer
    organizationName @1 :Text;  # like "Sandstorm Development Group, Inc."
    contactName @2 :Text;       # name of specific contact person
    contactEmail @3 :Text;      # email address of contact
  }

  customer @1 :Customer;

  issued @2 :UInt64;
  expires @3 :UInt64;
  # Unix timestamp (seconds) when this key was issued and expires.
  #
  # Use UINT64_MAX for `expires` to mean (effectively) "never expires".
  #
  # Tip: Although 64-bit, these values can safely be represented as numbers in Javascript.

  userLimit @4 :UInt32;
  # How many users are allowed? Use UINT32_MAX to mean (effectively) "unlimited".

  isElasticBilling @5 :Bool;
  # If true, then userLimit is a ceiling, but the customer will actually be billed based on
  # monthly active user count at the end of each month.

  isTrial @6 :Bool;
  # Is this a trial key? For display purposes only.

  features :group {
    # Individual features enabled.

    ldap @7 :Bool = true;
    saml @8 :Bool = true;
    orgManagement @9 :Bool = true;
  }

  const signingKey :PublicSigningKey =
      (key0 = 0xa87bfaf12af68423, key1 = 0xc42d2e56f009d882,
       key2 = 0x62298178d76d746b, key3 = 0xfe7ee882ec3d945a);
  # The Ed25519 public key used to verify FeatureKeys.
}
