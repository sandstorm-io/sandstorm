// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2014 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

// This file covers creation and consumption of invite keys (i.e. to invite people to become
// users of the Sandstorm server).

if (Meteor.isServer) {
  Meteor.publish("signupKey", function (key) {
    check(key, String);
    return SignupKeys.find(key);
  });

  Meteor.publish("selfEmail", function () {
    if (this.userId) {
      return Meteor.users.find({_id: this.userId}, {fields: {
        "services.github.email": 1,
        "services.google.email": 1
      }});
    } else {
      return [];
    }
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

      if (isDemoUser()) {
        throw new Meteor.Error(403,
            "Demo users cannot accept invite keys. Please sign in as a real user.");
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
  Template.invite.events({
    "click #send": function (event) {
      var from = document.getElementById("invite-from").value;
      var list = document.getElementById("invite-emails").value;
      var subject = document.getElementById("invite-subject").value;
      var message = document.getElementById("invite-message").value;

      var sendButton = event.currentTarget;
      sendButton.disabled = true;
      var oldContent = sendButton.textContent;
      sendButton.textContent = "Sending...";

      Meteor.call("sendInvites", getOrigin(), from, list, subject, message,
                  function (error, results) {
        sendButton.disabled = false;
        sendButton.textContent = oldContent;
        if (error) {
          Session.set("inviteMessage", { error: error.toString() });
        } else {
          Session.set("inviteMessage", results);
        }
      });
    },

    "click #create": function (event) {
      var note = document.getElementById("key-note").value;

      Meteor.call("createSignupKey", note, function (error, key) {
        if (error) {
          Session.set("inviteMessage", { error: error.toString() });
        } else {
          Session.set("inviteMessage", {
            url: getOrigin() + Router.routes.signup.path({key: key})
          });
        }
      });
    },

    "click .autoSelect": function (event) {
      event.currentTarget.select();
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
        origin: getOrigin(),
        alreadySignedUp: isSignedUp()
      };

      if (result.keyIsValid && !result.keyIsUsed && Meteor.userId()) {
        Meteor.call("useSignupKey", this.params.key);
      }

      return result;
    }
  });

  this.route("invite", {
    path: "/invite",

    waitOn: function () {
      // TODO(perf):  Do these subscriptions get stop()ed when the user browses away?
      return [
        Meteor.subscribe("credentials"),
        Meteor.subscribe("selfEmail")
      ];
    },

    data: function () {
      if (!isAdmin()) {
        return {error: "Must be admin to send invites."};
      }

      var me = Meteor.user();
      var email = (me.services && me.services.google && me.services.google.email) ||
                  (me.services && me.services.github && me.services.github.email);
      if (email && me.profile.name) {
        email = me.profile.name + " <" + email + ">";
      }
      email = email || "";

      return Session.get("inviteMessage") || {email: email};
    }
  });
});
