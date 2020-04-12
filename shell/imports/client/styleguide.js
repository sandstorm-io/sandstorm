import { Template } from "meteor/templating";

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
