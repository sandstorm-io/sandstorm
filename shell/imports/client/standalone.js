const parser = document.createElement("a");
parser.href = Meteor.settings.public.rootUrl;

const isStandalone = function () {
  return window.location.host !== parser.host;
};

export { isStandalone };
