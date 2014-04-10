@0xdd10df585a82c6d8;

$import "/capnp/c++.capnp".namespace("sandstorm");

using Grain = import "grain.capnp";
using Util = import "util.capnp";

struct EmailMessage {
  # Email is really complicated, but I'm going to go ahead and make a ton of
  # simplifying assumptions here.
  #
  # First, character encoding: According to RFC-822
  # (https://tools.ietf.org/html/rfc822), email should only contain ASCII-US
  # characters. For everything else, the character set is supposed to be
  # transfer encoded to ASCII, so we should be mostly ok not handling it for
  # now. The Cap'n Proto Text type is a superset of ASCII-US, so we'll just go
  # ahead and use that.
  #
  # Second, I'm splitting out the "important" headers. These include things
  # like from, to, cc, bcc, etc. The rest of the headers are being preserved
  # in the rawHeaders list for now.
  #
  # Third, I've split the body into 3 seperate fields. bodyText corresponds
  # to Content-Type: text/plain, or in the case that the message has no
  # Content-Type at all then it's just the whole body. bodyHtml corresponds
  # to Content-Type: text/html. attachments is a list of all attachments

  rawHeaders @0 :List(Util.KeyValue);

  date @1 :Text; # Should this be a special timestamp type? Or maybe even just a uint32 unix epoch time?

  # Do we want a special email type? It is a bit weird that emails here will
  # be text of the form: "name@domain.com <Full Name>"
  from @2 :Text;
  to @3 :List(Text);
  cc @4 :List(Text);
  bcc @5 :List(Text);
  replyTo @6 :Text; # header is actually reply-to

  # Not sure about these 2, but they can be pretty useful for mail clients
  messageId @7 :Text; # header is actually message-id
  inReplyTo @8 :Text; # header is actually in-reply-to

  subject @9 :Text;

  # All of the body elements are still of type Text, since according to RFC-822, they're also ASCII-US
  bodyText @10 :Text;
  bodyHtml @11 :Text;
  attachments @12 :List(Text); # Probably should add an Attachment struct with at least Content-Type split out
}

interface EmailReceiver {
  # A generic interface for sending/receiving email. Could be implemented with SMTP or equivalent services

  send @0 (email :EmailMessage);
}
