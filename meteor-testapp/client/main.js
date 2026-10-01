import { Meteor } from 'meteor/meteor';
import { Tracker } from 'meteor/tracker';

document.title = "testapp";
["id", "name", "picture", "preferredHandle", "pronouns", "serverRuntime"].forEach((id) => {
  const paragraph = document.createElement("p");
  paragraph.id = id;
  document.body.append(paragraph);
});

function setField(id, label, value) {
  document.querySelector(id).textContent = `${label}: ${value || ""}`;
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
