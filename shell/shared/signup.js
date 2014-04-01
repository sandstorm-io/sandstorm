// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014, Kenton Varda <temporal@gmail.com>
// All rights reserved.
//
// This file is part of the Sandstorm platform implementation.
//
// Sandstorm is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as
// published by the Free Software Foundation, either version 3 of the
// License, or (at your option) any later version.
//
// Sandstorm is distributed in the hope that it will be useful, but
// WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the GNU
// Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public
// License along with Sandstorm.  If not, see
// <http://www.gnu.org/licenses/>.

// This file covers creation and consumption of invite keys (i.e. to invite people to become
// users of the Sandstorm server).

if (Meteor.isServer) {
  Meteor.publish("signupKey", function (key) {
    check(key, String);
    return SignupKeys.find(key);
  });

  Meteor.methods({
    useSignupKey: function (key) {
      check(key, String);

      if (!this.userId) {
        throw new Meteor.Error(403, "Must be signed in.");
      }

      if (isSignedUp()) {
        // Don't waste it.
        return;
      }

      var keyInfo = SignupKeys.find(key);
      if (!keyInfo || keyInfo.used) {
        throw new Meteor.Error(403, "Invalid key or already used.");
      }

      Meteor.users.update(this.userId, {$set: {signupKey: key}});
      SignupKeys.update(key, {$set: {used: true}});
    },

    createSignupKey: function (note) {
      check(note, String);

      if (!isAdmin()) {
        throw new Meteor.Error(403, "Must be admin to create keys.");
      }

      var key = Random.id();
      SignupKeys.insert({_id: key, used: false, note: note});
      return key;
    },

    sendInvites: function (origin, from, list, subject, message) {
      check([origin, from, list, subject, message], [String]);

      if (!isAdmin()) {
        throw new Meteor.Error(403, "Must be admin to send invites.");
      }

      if (!from.trim()) {
        throw new Meteor.Error(403, "Must enter 'from' address.");
      }

      if (!list.trim()) {
        throw new Meteor.Error(403, "Must enter 'to' addresses.");
      }

      this.unblock();

      list = list.split("\n");
      for (var i in list) {
        var email = list[i].trim();

        if (email) {
          var key = Random.id();

          SignupKeys.insert({_id: key, used: false, note: "E-mail invite to " + email,
                             definitelySent: false});
          Email.send({
            to: email,
            from: from,
            subject: subject,
            text: message.replace(/\$KEY/g, origin + Router.routes.signup.path({key: key}))
          });
          SignupKeys.update(key, {$set: {definitelySent: true}});
        }
      }

      return { sent: true };
    }
  });
}

if (Meteor.isClient) {
  Template.signupMint.events({
    "click #create": function (event) {
      var note = document.getElementById("key-note").value;

      Meteor.call("createSignupKey", note, function (error, key) {
        if (error) {
          Session.set("signupMintMessage", { error: error.toString() });
        } else {
          Session.set("signupMintMessage", {
            url: document.location.origin + Router.routes.signup.path({key: key})
          });
        }
      });
    },

    "click #retry": function (event) {
      Session.set("signupMintMessage", undefined);
    },
  });

  Template.invite.events({
    "click #send": function (event) {
      var from = document.getElementById("invite-from").value;
      var list = document.getElementById("invite-emails").value;
      var subject = document.getElementById("invite-subject").value;
      var message = document.getElementById("invite-message").value;

      Meteor.call("sendInvites", document.location.origin, from, list, subject, message,
                  function (error, results) {
        if (error) {
          Session.set("inviteMessage", { error: error.toString() });
        } else {
          Session.set("inviteMessage", results);
        }
      });
    },

    "click #retry": function (event) {
      Session.set("inviteMessage", undefined);
    },
  });
}

Router.map(function () {
  this.route("signup", {
    path: "/signup/:key",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return [
        Meteor.subscribe("signupKey", this.params.key),
        Meteor.subscribe("credentials")
      ];
    },

    data: function () {
      var keyInfo = SignupKeys.findOne(this.params.key);

      var result = {
        keyIsValid: !!keyInfo,
        keyIsUsed: keyInfo && keyInfo.used,
        origin: document.location.origin,
        alreadySignedUp: isSignedUp()
      };

      if (result.keyIsValid && !result.keyIsUsed && Meteor.userId()) {
        Meteor.call("useSignupKey", this.params.key);
      }

      return result;
    }
  });

  this.route("signupMint", {
    path: "/signup-mint",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return Meteor.subscribe("credentials");
    },

    data: function () {
      if (!isAdmin()) {
        return {error: "Must be admin to mint invite keys."};
      }

      return Session.get("signupMintMessage") || {};
    }
  });

  this.route("invite", {
    path: "/invite",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return Meteor.subscribe("credentials");
    },

    data: function () {
      if (!isAdmin()) {
        return {error: "Must be admin to send invites."};
      }

      return Session.get("inviteMessage") || {};
    }
  });
});
