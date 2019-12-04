// Sandstorm - Personal Cloud Sandbox
// Copyright (c) 2015 Sandstorm Development Group, Inc. and contributors
// All rights reserved.
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//   http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

"use strict";

var FirefoxProfile = require('firefox-profile');
var utils = require('../utils');
var Promise = require('es6-promise').Promise;
var JSZip = require('jszip');
var fs = require('fs');
var path = require('path');
var downloadsPath = path.resolve(__dirname, "../downloads");
var actionSelector = utils.actionSelector;
var appDetailsTitleSelector = utils.appDetailsTitleSelector;
var short_wait = utils.short_wait;
var medium_wait = utils.medium_wait;
var very_long_wait = utils.very_long_wait;

function rm_rfSync(pathToRemove) {
  try {
    var stats = fs.lstatSync(pathToRemove);
    if (stats.isSymbolicLink()) { // Check symlinks before targets
      fs.unlinkSync(pathToRemove);
    } else if (stats.isFile()) {
      fs.unlinkSync(pathToRemove); // Delete the file
    } else if (stats.isDirectory()) {
      // Walk the directory and rm_rf each child
      var parentPath = pathToRemove;
      var files = fs.readdirSync(pathToRemove);
      for (var i = 0; i < files.length; i++) {
        var childPath = path.join(parentPath, files[i]);
        console.log("removing " + childPath);
        rm_rfSync(childPath);
      }
      fs.rmdirSync(parentPath);
    }
  } catch (e) {
    console.log(e);
    // silence exceptions (probably ENOENT on root node)
  }
};

function makeCleanDownloadsDirSync() {
  rm_rfSync(downloadsPath);
  fs.mkdirSync(downloadsPath);
}

function setProfile(browser, profile, callback) {
  profile.encoded(function (encodedProfile) {
    browser.options.desiredCapabilities['firefox_profile'] = encodedProfile;
    callback();
  });
}

function configureAutoDownload(browser, done) {
  browser.options.desiredCapabilities['chromeOptions'] = {
    prefs: {
      download: {
        prompt_for_download: false,
        default_directory: downloadsPath
      }
    }
  }

  var autoDownloadProfile = new FirefoxProfile();
  autoDownloadProfile.setPreference('browser.download.folderList', 2);
  autoDownloadProfile.setPreference('browser.download.dir', downloadsPath);
  autoDownloadProfile.setPreference('browser.helperApps.neverAsk.saveToDisk', 'application/zip');
  setProfile(browser, autoDownloadProfile, done);
}

module.exports = {
  before: function(browser, done) {
    makeCleanDownloadsDirSync();
    configureAutoDownload(browser, done);
  },
};

module.exports["Test backup and restore"] = function(browser) {
  // For setting up an async watch on the filesystem
  var watcherPromise = undefined;

  // Fulfilled when the file is downloaded, rejected if a timeout is reached
  var downloadPromise = undefined;

  // Filled in if downloading fails.
  var downloadError = undefined;

  // For using the file after download completes.
  var downloadPath = undefined;

  var randomValue = "" + Math.random(); // TODO: randomize this per-test

  //v0: /install/9111a8c70938276d28a00468a18a25c7?url=https://alpha-hlngxit86q1mrs2iplnx.sandstorm.io/test-0.spk
  //v1: /install/f5fe6aa9fcbccc690fd36a86efe02b8a?url=https://alpha-hlngxit86q1mrs2iplnx.sandstorm.io/test-1.spk
  browser
    .loginDevAccount()
    // sandstorm-test-python, v0
    .installApp("https://alpha-hlngxit86q1mrs2iplnx.sandstorm.io/test-0.spk", "9111a8c70938276d28a00468a18a25c7", "rwyva77wj1pnj01cjdj2kvap7c059n9ephyyg5k4s5enh5yw9rxh")
    .assert.containsText('#grainTitle', 'Untitled Test App test page')
    .waitForElementVisible('.grain-frame', short_wait)
    .grainFrame()
    .waitForElementPresent('#randomId', medium_wait)
    .assert.containsText('#randomId', 'initial state')
    .setValue("#state", [randomValue, browser.Keys.ENTER])
    .waitForElementPresent('#randomId', medium_wait)
    .assert.containsText('#randomId', randomValue)
    .frame(null)
    .perform(function (client, done) {
      // Set up the filesystem watcher before clicking the download button.
      watcherPromise = new Promise(function(resolve, reject) {
        var watcher = fs.watch(downloadsPath, {persistent: false, recursive: false},
                               function (event, filename) {
          if (event === 'change' && filename && filename.endsWith(".zip")) {
            var fullpath = path.join(downloadsPath, filename);
            var stat = fs.statSync(fullpath);
            watcher.close();
            // Assume the backup will download within one second of the zip file being created.
            // There's not a really good way to detect that the file is done being downloaded
            // without e.g. doing deep inotify things to watch for a CLOSE event.
            setTimeout(function() {
              resolve(fullpath);
            }, 1000);
          }
        });
      });
      done();
    })
    .click('#backupGrain', function() {
      downloadPromise = new Promise(function(resolve, reject) {
        watcherPromise.then(resolve);
        // Expect the zip download to complete within 5 seconds of clicking the button.
        var timeout = 5000;
        setTimeout(function () {
          reject(new Error('Download timed out after '+ timeout + ' ms'));
        }, timeout);
      });
    })
    .perform(function (client, done) {
      // Potential async stuff happening, call done() when ready
      downloadPromise.then(function (fileDownloaded) {
        downloadPath = fileDownloaded;
        client.assert.ok(fileDownloaded !== undefined, "a zip was downloaded");
        var data = fs.readFileSync(fileDownloaded);
        var zip = new JSZip(data);
        var metadata = zip.file("metadata");
        client.assert.ok(!!metadata, "" + fileDownloaded + " contains file /metadata");
        var stateFile = zip.file("data/state");
        client.assert.ok(!!stateFile, "" + fileDownloaded + " contains file /data/state");
        client.assert.ok(stateFile.asText() === randomValue, "" + fileDownloaded + "/data/state contains the expected value " + randomValue);
        done();
      }).catch(function (error) {
        downloadError = error;
        done();
      });
    })
    .perform(function (client, done) {
      client.assert.ifError(downloadError);
      done();
    })
    .click('li.navitem-grain.current button.close-button')
    .url(browser.launch_url + "/grain")
    .waitForElementVisible('button.restore-button', short_wait)
    .execute(function () {
      // Firefox/Selenium oddity: invisible inputs cannot have their values set
      var input = document.querySelector('button.restore-button input[type=file]');
      input.style["display"] = "inline";
    }, [])
    .perform(function (client, done) {
      // Have to defer referencing downloadPath until after the previous steps have run, so this
      // is wrapped in a .perform rather than simply chaining a .setValue()
      client.setValue('button.restore-button input[type=file]', downloadPath, function() {
        console.log("finished setting the form value");
        done();
      });
    })
    .execute(function () {
      // This function is run in the browser context.
      var input = document.querySelector('button.restore-button input[type=file]');
      var file = input.files[0];
      restoreBackup(file);
    }, [])
    .waitForElementVisible('#grainTitle', medium_wait)
    .assert.containsText('#grainTitle', 'Untitled Test App test page')
    .waitForElementVisible('.grain-frame', short_wait)
    .grainFrame()
    .waitForElementPresent('#randomId', medium_wait)
    .assert.containsText('#randomId', randomValue)
    .frame(null)
    .end();
}
