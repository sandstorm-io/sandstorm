# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
#
# This file is part of the Sandstorm API, which is licensed under the MIT license:
#
# Permission is hereby granted, free of charge, to any person obtaining a copy
# of this software and associated documentation files (the "Software"), to deal
# in the Software without restriction, including without limitation the rights
# to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
# copies of the Software, and to permit persons to whom the Software is
# furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
# AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
# OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
# THE SOFTWARE.

@0xdd10df585a82c6d8;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";
using Util = import "util.capnp";

struct EmailAddress {
  # Email addresses are (usually) of the form "example@example.org <Full Name>".
  # This struct seperates the first and second part into distinct fields
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

  # Seperate body into text and html fields.
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
