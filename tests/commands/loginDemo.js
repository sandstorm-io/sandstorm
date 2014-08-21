'use strict';

exports.command = function(callback) {
  var ret = this
    .url(this.launchUrl + "/demo")
    .execute('window.Meteor.logout()')
    .pause(50)
    .click("#createDemoUser")
    .waitForElementVisible('#applist-apps', 1000);

  this.sandstormAccount = 'demo';
  if (typeof callback === "function") {
    return ret.click("#applist-apps > ul > li:nth-child(1)", callback);
  } else {
    return ret.click("#applist-apps > ul > li:nth-child(1)");
  }
};
