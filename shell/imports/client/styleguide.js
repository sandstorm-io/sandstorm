import { Template } from "meteor/templating";
import { Router } from "meteor/iron:router";

Template.styleguide.events({
  "submit form"(evt) {
    evt.preventDefault();
    evt.stopPropagation();
  },
});

Router.map(function () {
  this.route("styleguide", {
    path: "/styleguide",
  });
});
