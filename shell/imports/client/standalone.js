const parser = document.createElement("a");
// jscs:disable requireCamelCaseOrUpperCaseIdentifiers
parser.href = __meteor_runtime_config__.ROOT_URL;
// jscs:enable requireCamelCaseOrUpperCaseIdentifiers

const isStandalone = function () {
  return window.location.host !== parser.host;
};

export { isStandalone };
