'use strict';

exports.command = function(callback) {
  var ret = this
    .init()
    .execute('window.Meteor.logout()')
    .pause(50)
    .execute('window.mockLoginGithub()')
    .pause(50)
    .init()
    .waitForElementVisible('#applist-apps', 1000);

  this.sandstormAccount = 'github';
  if (typeof callback === "function") {
    return ret.click("#applist-apps > ul > li:nth-child(1)", callback);
  } else {
    return ret.click("#applist-apps > ul > li:nth-child(1)");
  }
};
