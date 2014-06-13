# Sandstorm - Personal Cloud Sandbox
# Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
# All rights reserved.
#
# This file is part of the Sandstorm API, which is licensed as follows.
#
# Redistribution and use in source and binary forms, with or without
# modification, are permitted provided that the following conditions are met:
#
# 1. Redistributions of source code must retain the above copyright notice, this
#    list of conditions and the following disclaimer.
# 2. Redistributions in binary form must reproduce the above copyright notice,
#    this list of conditions and the following disclaimer in the documentation
#    and/or other materials provided with the distribution.
#
# THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
# ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
# WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
# DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE LIABLE FOR
# ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES
# (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES;
# LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND
# ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
# (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
# SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.

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
