'use strict';

var webdriver = require('selenium-webdriver'),
    By        = webdriver.By;

var test = require('selenium-webdriver/testing'),
    describe = test.describe,
    it = test.it;

var chai = require('chai'),
    expect = chai.expect,
    assert = chai.assert;

describe('Test sandstorm title', function () {
  var driver;

  before(function () {
    driver = new webdriver.Builder().
      withCapabilities(webdriver.Capabilities.phantomjs()).
      build();
  });

  describe('Check homepage', function () {
    it('should see the correct title', function () {
      driver.get('http://localhost:6080');
      driver.getTitle().then(function (title) {
        expect(title).to.have.string('Sandstorm');
      });
    });
  });

  after(function () {
    driver.quit();
  });
});

function waitForElementVisible (driver, selector, timeout) {
  timeout = timeout || 1000;
  driver.wait(function () {
    return driver.findElement(selector).isDisplayed();
  }, timeout);
}

describe('Test sandstorm login', function () {
  var driver;

  before(function () {
    driver = new webdriver.Builder().
      withCapabilities(webdriver.Capabilities.phantomjs()).
      build();
  });

  describe('Check home page', function () {
    it('should see allow login as demo user', function() {
      // Implicitly will wait up to a second for all DOM queries to complete
      driver.manage().timeouts().implicitlyWait(1000);
      driver.get('http://localhost:6080/demo');

      driver.findElement(By.id('createDemoUser')).click();
      driver.findElement(By.id('login-name-link')).getText().then(function (text) {
        expect(text).to.have.string('Demo User');
      });
    });
  });

  after(function () {
    driver.quit();
  });
});
