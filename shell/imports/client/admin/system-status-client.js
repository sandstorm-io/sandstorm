import { Meteor } from "meteor/meteor";
import { Mongo } from "meteor/mongo";
import { Template } from "meteor/templating";
import downloadFile from "/imports/client/download-file";
import getBuildInfo from "/imports/client/build-info";
import { allowDemo } from "/imports/demo";

// Pseudocollection holding number of grains with open sessions and accounts with open sessions.
const systemStatus = new Mongo.Collection("systemStatus");

// Pseudocollection with the lines of the server log
const AdminLog = new Meteor.Collection("adminLog");

// This is some logic to make the log scroll to the bottom by default and also stick there.  It is
// two template and more complicated than it needs to be because Blaze lacks the appropriate set
// of lifecycle hooks to make it more straightforward.
//
// Some events will not trigger when you need them to - if you want to take an action on the DOM any
// time a child calls a template helper, `onRendered` isn't going to cut it, because the parent
// template isn't actually considered to be changing.  This is an artifact of opaquely sideloading
// data through ReactiveVars, which are how Blaze's data context passes information around.
//
// Other events trigger before you want them to - a child template's `onRendered`, for instance,
// will fire before the parent can reference things like `lastNode`.  So you can't just naively
// have the child notify the parent on render or even data context change.
//
// The hack, then, is to store a boolean `renderedYet` in the parent (which controls the scroll
// height) and guard any DOM interactions on that being true, and to split the content out into a
// second template, so the content template can ask its parent template to run its hook whenever the
// data context changes.  This is ugly, but appears to both work and not trigger any exceptions.
Template.newAdminLogContents.onRendered(function () {
  this.autorun(() => {
    Template.currentData(); // establish reactive dependency on currentData
    this.data.onRenderedHook && this.data.onRenderedHook();
  });
});

Template.newAdminLog.onCreated(function () {
  this.shouldScroll = true;
  this.renderedYet = false;

  this.forceScrollBottom = () => {
    this.lastNode.scrollTop = this.lastNode.scrollHeight;
    this.shouldScroll = true;
  };

  this.maybeScrollToBottom = () => {
    if (this.shouldScroll && this.renderedYet) {
      this.forceScrollBottom();
    }
  };

  this.saveShouldScroll = () => {
    // Save whether the current scrollTop is equal to the ~maximum scrollTop.
    // If so, then we should make the log "stick" to the bottom, by manually scrolling to the bottom
    // when needed.
    const messagePane = this.lastNode;

    // Include a 5px fudge factor to account for bad scrolling and fractional pixels.
    this.shouldScroll = (messagePane.clientHeight + messagePane.scrollTop + 5 >= messagePane.scrollHeight);
  };

  this.resizeHandler = (evt) => {
    this.maybeScrollToBottom();
  };

  // As the window resizes, the space allocated to this template may grow, which would make it
  // possible for the viewport to no longer be "scrolled to the bottom".  This event listener
  // makes sure that we do the right thing as the window resizes.
  window.addEventListener("resize", this.resizeHandler);
});

Template.newAdminLog.onRendered(function () {
  // On initial render, force scroll to the bottom.
  if (!this.renderedYet) {
    this.renderedYet = true;
    this.maybeScrollToBottom();
  }
});

Template.newAdminLog.onDestroyed(function () {
  window.removeEventListener("resize", this.resizeHandler);
});

Template.newAdminLog.events({
  "scroll .admin-log-box"(evt) {
    const instance = Template.instance();
    instance.saveShouldScroll();
  },
});

Template.newAdminLog.helpers({
  logHtml() {
    // jscs:disable requireCamelCaseOrUpperCaseIdentifiers
    return AnsiUp.ansi_to_html(
      AdminLog.find({}, { $sort: { _id: 1 } })
          .map(entry => entry.text)
          .join(""),
      { use_classes: true }
    );
    // jscs:enable requireCamelCaseOrUpperCaseIdentifiers
  },

  maybeScrollToBottom() {
    const instance = Template.instance();
    return () => {
      instance.maybeScrollToBottom();
    };
  },
});

Template.newAdminStatus.onCreated(function () {
  // This route can be used with a setup token (unlike most admin routes).
  this.subscribe("adminLog", sessionStorage.getItem("setup-token"));
});

Template.newAdminStatus.onDestroyed(function () {
  window.clearInterval(this.intervalHandle);
});

Template.newAdminStatus.events({
  "click button[name=download-full-log]"(evt) {
    Meteor.call("adminGetServerLogDownloadToken", sessionStorage.getItem("setup-token"),
        (err, token) => {
      if (err) {
        console.log(err.message);
      } else {
        const url = "/admin/status/server-log/" + token;
        const suggestedFilename = "sandstorm.log";
        downloadFile(url, suggestedFilename);
      }
    });
  },
});
