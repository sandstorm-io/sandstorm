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

Accounts.onLogin(function() {
  var oldLoginToken = sessionStorage.getItem("mergeAccountsLoginToken");
  sessionStorage.removeItem("mergeAccountsLoginToken");

  if (oldLoginToken) {
    Meteor.call("mergeWithAccount", oldLoginToken, function (err, result) {
      console.log("merged!");
      if (err) {
        throw new Error("error: " + err);
      }
      Meteor.loginWithToken(oldLoginToken);
    });
  }
});

SandstormAccountsMerge.mergeWithGoogle = function () {
  var oldLoginToken = Accounts._storedLoginToken();
  sessionStorage.setItem("mergeAccountsLoginToken", oldLoginToken);
  Meteor.loginWithGoogle();
}
