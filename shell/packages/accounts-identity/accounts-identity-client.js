// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
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

Template.identityLoginInterstitial.helpers({
  currentIdentity: function () {
    var identities = SandstormDb.getUserIdentities(Meteor.user());
    return identities && identities.length > 0 && identities[0];
  },
  nonloginAccounts: function () {
    return Session.get("nonloginAccounts");
  },
});

Template.identityLoginInterstitial.events({
  "click button.logout": function () {
    Meteor.logout();
  },
  "click button.unlink": function () {
    var userId = event.target.getAttribute("data-user-id")
    var user = Meteor.user();
    var identityId = user && user._id;

    Meteor.call("unlinkIdentity", userId, identityId, function (err, result) {
      if (err) {
        console.log("error: ", err);
      } else {
        // Remove the account from our display list.
        var list = Session.get("nonloginAccounts");
        Session.set("nonloginAccounts",
                    list.filter(function (account) {return account.accountId !== userId; }));
      }
    });
  },
});

Template.identityPicker.events({
  "click button.pick-identity": function (event, instance) {
    instance.data.onPicked(event.currentTarget.getAttribute("data-identity-id"))
  },
});

Template.identityPicker.helpers({
  isCurrentIdentity: function () {
    return this._id === Template.instance().data.currentIdentityId;
  },
});

Template.identityCard.helpers({
  intrinsicName: function() {
    if (this.privateIntrinsicName) {
      return this.privateIntrinsicName;
    } else {
      return this.profile && this.profile.intrinsicName;
    }
  },
});

Meteor.loginWithIdentity = function (userId, callback) {
  check(userId, String);

  Accounts.callLoginMethod({
    methodName: "loginWithIdentity",
    methodArguments: [userId],
    userCallback: function (error, result) {
      if (error) {
        callback && callback(error);
      } else {
        callback && callback();
      }
    }
  });
};

Accounts.onLogin(function () {
  Session.set("nonloginAccounts", undefined);
  var user = Meteor.user();
  var token = sessionStorage.getItem("linkingIdentityLoginToken");
  if (user.loginIdentities || token === Accounts._storedLoginToken()) { return; }
  sessionStorage.removeItem("linkingIdentityLoginToken");

  if (token) {
    Meteor.call("linkIdentityToAccount", token, function (err, result) {
      if (err) {
        // TODO(soon): display this error somewhere that the user will see.
        console.log("Error", err);
      }
      Meteor.loginWithToken(token);
    });
  } else {
    Meteor.call("checkForLinkedAccounts", function(err, result) {
      if (err) {
        console.log("Error", err);
        Meteor.logout();
      } else if (result) {
        if (result.loginAccountId) {
          Meteor.loginWithIdentity(result.loginAccountId);
        } else if (result.nonloginAccounts) {
          var loginIdentities = result.nonloginAccounts.map(function (account) {
            SandstormDb.fillInIdenticon(account.loginIdentityUser);
            return {accountId: account.accountId,
                    identity: account.loginIdentityUser};
          });
          Session.set("nonloginAccounts", loginIdentities);
        }
      }
    });
  }
});
