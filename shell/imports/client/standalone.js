const parser = document.createElement("a");
// jscs:disable requireCamelCaseOrUpperCaseIdentifiers
parser.href = __meteor_runtime_config__.ROOT_URL;
// jscs:enable requireCamelCaseOrUpperCaseIdentifiers

const isStandalone = function () {
  // Note: Don't compare by `host` because IE11 incorrectly adds ":443" to parser.host if it's an
  //   HTTPS URL. :(
  return window.location.hostname !== parser.hostname;
};

export { isStandalone };
