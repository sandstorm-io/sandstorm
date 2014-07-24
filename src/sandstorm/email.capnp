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

@0xdd10df585a82c6d8;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";
using Util = import "util.capnp";

struct EmailAddress {
  # Email addresses are (usually) of the form "Full Name <example@example.org>".
  # This struct separates the display name and address into distinct fields.
  address @0 :Text;
  name @1 :Text;
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

  messageId @6 :Text; # header is actually message-id
  references @7 :List(Text);
  inReplyTo @8 :List(Text); # header is actually in-reply-to

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
  # Usually, a port you get from the user through the powerbox will
  # represent a particular address owned by the user.  All messages
  # sent through the port will have the `from` field overwritten with the
  # user's address.

  send @0 (email :EmailMessage);
}
