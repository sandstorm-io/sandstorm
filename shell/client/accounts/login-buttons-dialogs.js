// for convenience
const loginButtonsSession = Accounts._loginButtonsSession;

//
// configureLoginServiceDialog template
//

Template._configureLoginServiceDialog.events({
  "click .configure-login-service-dismiss-button": function () {
    loginButtonsSession.set("configureLoginServiceDialogVisible", false);
  },

  "click #configure-login-service-dialog-save-configuration": function () {
    if (loginButtonsSession.get("configureLoginServiceDialogVisible") &&
        !loginButtonsSession.get("configureLoginServiceDialogSaveDisabled")) {
      // Prepare the configuration document for this login service
      const serviceName = loginButtonsSession.get("configureLoginServiceDialogServiceName");
      const configuration = {
        service: serviceName,
      };

      // Fetch the value of each input field
      _.each(configurationFields(), function (field) {
        configuration[field.property] = document.getElementById(
          "configure-login-service-dialog-" + field.property).value
          .replace(/^\s*|\s*$/g, ""); // trim() doesnt work on IE8;
      });

      configuration.loginStyle =
        $('#configure-login-service-dialog input[name="loginStyle"]:checked')
        .val();

      // Configure this login service
      Accounts.connection.call(
        "configureLoginService", configuration, function (error, result) {
          if (error)
            Meteor._debug("Error configuring login service " + serviceName,
                          error);
          else
            loginButtonsSession.set("configureLoginServiceDialogVisible",
                                    false);
        });
    }
  },
  // IE8 doesn't support the 'input' event, so we'll run this on the keyup as
  // well. (Keeping the 'input' event means that this also fires when you use
  // the mouse to change the contents of the field, eg 'Cut' menu item.)
  "input, keyup input": function (event) {
    // if the event fired on one of the configuration input fields,
    // check whether we should enable the 'save configuration' button
    if (event.target.id.indexOf("configure-login-service-dialog") === 0)
      updateSaveDisabled();
  },
});

// check whether the 'save configuration' button should be enabled.
// this is a really strange way to implement this and a Forms
// Abstraction would make all of this reactive, and simpler.
const updateSaveDisabled = function () {
  const anyFieldEmpty = _.any(configurationFields(), function (field) {
    return document.getElementById(
      "configure-login-service-dialog-" + field.property).value === "";
  });

  loginButtonsSession.set("configureLoginServiceDialogSaveDisabled", anyFieldEmpty);
};

// Returns the appropriate template for this login service.  This
// template should be defined in the service's package
const configureLoginServiceDialogTemplateForService = function () {
  const serviceName = loginButtonsSession.get("configureLoginServiceDialogServiceName");
  // XXX Service providers should be able to specify their configuration
  // template name.
  return Template["configureLoginServiceDialogFor" +
                  (serviceName === "meteor-developer" ?
                   "MeteorDeveloper" :
                   capitalize(serviceName))];
};

const configurationFields = function () {
  const template = configureLoginServiceDialogTemplateForService();
  return template.fields();
};

Template._configureLoginServiceDialog.helpers({
  configurationFields: function () {
    return configurationFields();
  },

  visible: function () {
    return loginButtonsSession.get("configureLoginServiceDialogVisible");
  },

  configurationSteps: function () {
    // renders the appropriate template
    return configureLoginServiceDialogTemplateForService();
  },

  saveDisabled: function () {
    return loginButtonsSession.get("configureLoginServiceDialogSaveDisabled");
  },
});

// XXX from http://epeli.github.com/underscore.string/lib/underscore.string.js
const capitalize = function (str) {
  str = str == null ? "" : String(str);
  return str.charAt(0).toUpperCase() + str.slice(1);
};
