# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
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

# This is used specifically with hack-session.capnp.
# It is subject to change after the Powerbox functionality is implemented.

@0xdd10df585a82c6d8;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";
using Util = import "util.capnp";

struct EmailAddress {
  # Email addresses are (usually) of the form "Full Name <example@example.org>".
  # This struct separates the display name and address into distinct fields.

  address @0 :Text;
  name @1 :Text;

  # TODO(someday): We could add a field `token` which is a capability representing "email capital",
  #   which you can think of like "political capital", but specifically representing some social
  #   permission to send email to this address. A token can be used some small number of times to
  #   send email to a particular address. Tokens can be requested using the inline powerbox: if a
  #   human user types (or selects from autocomplete) an address, this is good enough to allow the
  #   app to send a few messages to that address. Tokens would also be received as part of incoming
  #   messages, representing permission to reply (and reply-all).
}

struct EmailAttachment {
  contentType @0 :Text; # header is actually content-type
  contentDisposition @1 :Text; # header is actually content-disposition
  contentId @2 :Text; # header is actually content-id

  content @3 :Data;
}

struct EmailMessage {
  date @0 :Int64; # Nanoseconds since unix epoch.

  from @1 :EmailAddress;
  to @2 :List(EmailAddress);
  cc @3 :List(EmailAddress);
  bcc @4 :List(EmailAddress);
  replyTo @5 :EmailAddress; # header is actually reply-to
  # TODO(someday): replyTo should actually be a List(EmailAddress)

  messageId @6 :Text; # header is actually message-id
  references @7 :List(Text);
  inReplyTo @8 :List(Text); # header is actually in-reply-to

  # TODO(someday): Add list-id.

  subject @9 :Text;

  # Separate body into text and html fields.
  # Any other content-types will be in the attachments field.
  text @10 :Text;
  html @11 :Text;
  attachments @12 :List(EmailAttachment);
}

interface EmailSendPort @0xec831dbf4cc9bcca {
  # Represents a destination for e-mail.
  #
  # Make a Powerbox request for `EmailSendPort` when you want to request permission to send email
  # to the current user. For example, a mailing list app would request this when a user indicates
  # they wish to subscribe to the list.
  #
  # Make a Powerbox offer of an `EmailSendPort` when you want to receive email on that port.
  # The user will be prompted to assign your port to an address. For example, a mailing list app
  # would offer an `EmailSendPort` to the owner during initial setup.

  send @0 (email :EmailMessage);
  # Send a message through this port.

  hintAddress @1 (address :EmailAddress);
  # Hint to the port that it is now receiving email sent to the given address. The email driver
  # will call this after the port has been bound to an address after being offered through the
  # Powerbox. The purpose is to allow the app to display back to the user what address it is
  # bound to. Implementing this is optional.

  struct PowerboxTag {
    # Tag which can be set on `PowerboxDescriptor`s when requesting an `EmailSendPort`.

    fromHint @0 :EmailAddress;
    # The user will be offered the ability to override the "from" address on emails sent through
    # this port. The application requesting the port may provide `fromHint` to suggest an override
    # address to the user. Do not provide a `fromHint` if you do not want `from` addresses to be
    # overridden, but note that the user may choose to do so anyway.
    #
    # It does not make sense to fill in this field when making a Powerbox offer.

    listIdHint @1 :Text;
    # The user will be offered the ability to set the "list-id" on emails sent through this port.
    # The application requesting the port may provide 'listIdHint' to suggest a list ID to use.
    # Do not provide a `listIdHint` if you do not want the list ID to be set, but note that the
    # user may choose to set it anyway.
    #
    # It does not make sense to fill in this field when making a Powerbox offer.
  }
}

interface VerifiedEmail @0xf88bf102464dfa5a {
  # By default, an app is not told a user's email address. You may, however, request that the user
  # provide their verified email address through the powerbox.
  #
  # First, you need an `EmailVerifier`. See that class for info on how to get one.
  #
  # To verify a user, make a powerbox request for `VerifiedEmail`. In your `PowerboxDescriptor`,
  # set the tag value to a `VerifiedEmail.PowerboxTag` which has `authority` set to the
  # capability returned by your `EmailVerifier`'s `getAuthority()` method. The user will be asked to
  # choose one of their addresses. The Powerbox returns an `VerifiedEmail` for the address they
  # chose. You must then pass this object to `EmailVerifier.verifyEmail()` to verify that
  # the capability really is attached to the user's account and obtain the final address.
  #
  # You might wonder why the `EmailVerifier.verifyEmail()` step is necessary -- why not just
  # have a `getAddress()` method on `VerifiedEmail` itself? The answer is that although the
  # powerbox will only offer the user a choice of addresses associated with their account, the
  # powerbox code runs client-side, and thus a malicious user could inject an arbitrary capability
  # in place of the powerbox's response. So, they could respond with a fake `VerifiedEmail`
  # capability.

  struct PowerboxTag {
    # Use this type as the tag value when requesting an VerifiedEmail in order to narrow the
    # choices presented to the user.

    verifierId @0 :Data;
    # Value returned by `EmailVerifier.getId()`. Pass this to ensure that only
    # addresses which can be verified by this verifier are offered as options.

    address @1 :Text;
    # Specify a complete address (like "foo@example.com") in a Powerbox request to request that
    # the user verify this specific address and no other. The user will still have the choice to
    # refuse verification, but will not be offered other addresses.
    #
    # This field will NOT be present in the tag returned with the powerbox response, because the
    # field could be spoofed by the user. You must invoke `EmailVerifier.verifyEmail()` to find out
    # the matching address.

    domain @2 :Text;
    # Specify a domain (like "example.com") in a Powerbox request to require that the user choose
    # an address under the specified domain. The user will still have the choice to refuse
    # verification, but will not be offered addresses under other domains.
    #
    # This field will NOT be present in the tag returned with the powerbox response, because the
    # field could be spoofed by the user. You must invoke `EmailVerifier.verifyEmail()` to find out
    # the matching address.
  }
}

interface VerifiedEmailSendPort @0xa3cc885445aed8e9 extends(VerifiedEmail, EmailSendPort) {
  # Make a PowerboxRequest for this type when you want to both verify an email and request
  # the ability to send messages to it.

  struct PowerboxTag {
    verification @0 :VerifiedEmail.PowerboxTag;
    port @1 :EmailSendPort.PowerboxTag;
  }
}

interface EmailVerifier @0xd458f7ca9d1ba9ff {
  # Object which can verify users' email addresses.
  #
  # To obtain an `EmailVerifier`, do a powerbox request for one, usually during first-time
  # setup of your app. The user will be asked what kinds of address verification mechanisms they
  # wish to trust -- e.g., do they trust that if Github says it has verified an address, it really
  # has, or do they want Sandstorm do directly verify addresses? SECURITY NOTE: The user from whom
  # you request the `EmailVerifier` will have the ability to spoof verifications, so only
  # request it from the grain owner!
  #
  # Once you have a verifier, you can verify a user's address by making a powerbox request for
  # an `VerifiedEmail` from that user; see the docs for `VerifiedEmail` for info.

  getId @0 () -> (id :Data);
  # Place the returned value in your `VerifiedEmail.PowerboxTag` when making a powerbox
  # request. This tells the powerbox to filter for options that will be accepted by this
  # `EmailVerifier`.
  #
  # Implementations of EmailVerifier should generate this value randomly to prevent collisions,
  # but note that the ID need not be kept secret, since it's really only a filtering hint.

  verifyEmail @1 (tabId :Data, verification :VerifiedEmail) -> (address :Text);
  # Unpack the given verification to read the address that was verified.
  #
  # `tabId` comes from `UiView.newSession()`; verification only succeeds if it was in fact this
  # tab's user whose address was verified. This exists to prevent the following MITM attack: Alice
  # wants to falsely verify to a grain belonging to Carol that she owns Bob's address. So, she
  # creates a grain of her own running an app that requests email verification and sends it to Bob.
  # Bob willingly verifies his email to Alice's grain since Alice already knows his address anyway.
  # However, Alice's grain actually stashes the VerifiedEmail capability. Alice then visits
  # Carol's grain which requests email verification. Alice directs her malicious grain to respond
  # to the powerbox request with Bob's VerifiedEmail. This doesn't work because Bob's
  # VerifiedEmail was created in Bob's tab (against Alice's grain), and therefore when Carol's
  # grain tries to verify it passing Alice's `tabId`, they don't match, and the verification fails.
}

interface EmailAgent @0x8b6f158d70cbc773 {
  # Represents the ability to send and receive email as some user.
  #
  # Make a Powerbox request for `EmailAgent` when you want to request the ability to send and
  # receive email under some address. For example, an email client app would request this.

  send @0 (email :EmailMessage);
  # Send a message from this user to all the addresses listed in the message's `to`, `cc`, and
  # `bcc` fields. `email.from` is ignored; it will be replaced with the address associated with
  # this capability. `email.bcc` will not be revealed to recipients.

  addReceiver @1 (port :EmailSendPort) -> (handle :Util.Handle);
  # Arrange for future mail sent to this user to be delivered to `port`.
  #
  # Drop the returned handle to unsubscribe. This handle is persistent (can be saved as a
  # SturdyRef).
  #
  # Multiple `port`s can be added; each will receive a copy.
}

# TODO(someday): Support remote mailboxes, e.g. IMAP. Look at Nylas API for design hints!
