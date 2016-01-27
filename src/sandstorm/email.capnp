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

  # TODO(someday): We could add a field `token` which is a capability representing "email captial",
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
