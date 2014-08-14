'use strict';

exports.command = function() {
  return this
    .url("http://localhost:6080/demo")
    .execute('window.Meteor.logout()')
    .pause(50)
    .click("#createDemoUser")
    .click("#applist-apps > ul > li:nth-child(1)");
};
