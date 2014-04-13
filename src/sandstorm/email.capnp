@0xdd10df585a82c6d8;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";
using Util = import "util.capnp";
using WebSession = import "web-session.capnp".WebSession;

struct EmailAddress {
  # Email addresses are (usually) of the form "example@example.org <Full Name>".
  # This struct seperates the first and second part into distinct fields
  address @0 :Text;
  name @1 :Text;
}

struct EmailMessage {
  date @0 :Int64; # Seconds since unix epoch

  # These fields are special in that they're added by our incoming smtp server.
  # These should be null for outgoing messages and will be ignored.
  deliveredFrom @1 :EmailAddress;
  deliveredTo @2 :EmailAddress;

  from @3 :EmailAddress;
  to @4 :List(EmailAddress);
  cc @5 :List(EmailAddress);
  bcc @6 :List(EmailAddress);
  replyTo @7 :EmailAddress; # header is actually reply-to

  # Not sure about these 3, but they can be pretty useful for mail clients
  messageId @8 :Text; # header is actually message-id
  references @9 :List(Text);
  inReplyTo @10 :List(Text); # header is actually in-reply-to

  subject @11 :Text;

  bodyText @12 :Text;
  bodyHtml @13 :Text;
  # TODO: attachments @14 :List(Text); # Probably should add an Attachment struct with at least Content-Type split out
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

interface EmailHackSession @0x9d0faf74c32bd817 extends(WebSession, EmailSendPort) {}
interface EmailHackContext @0xe14c1f5321159b8f extends(Grain.SessionContext, EmailSendPort) {}
