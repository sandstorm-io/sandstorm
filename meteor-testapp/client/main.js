import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';
import $ from 'jquery';

document.title = "testapp";
$("body").append(
  '<p id="id"></p>',
  '<p id="name"></p>',
  '<p id="picture"></p>',
  '<p id="preferredHandle"></p>',
  '<p id="pronouns"></p>',
  '<p id="serverRuntime"></p>',
);

function setField(id, label, value) {
  $(id).text(`${label}: ${value || ""}`);
}

Meteor.call("getServerRuntime", (err, result) => {
  if (err) {
    console.error("getServerRuntime failed:", err);
    setField("#serverRuntime", "serverRuntime", "ERROR");
  } else {
    setField("#serverRuntime", "serverRuntime", result);
  }
});

Tracker.autorun(() => {
  const user = Meteor.sandstormUser();
  if (!user) return;

  setField("#id", "id", user.id);
  setField("#name", "name", user.name);
  setField("#picture", "picture", user.picture);
  setField("#preferredHandle", "preferredHandle", user.preferredHandle);
  setField("#pronouns", "pronouns", user.pronouns);
});
