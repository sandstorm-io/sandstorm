'use strict';

var webdriver = require('selenium-webdriver');

var test = require('selenium-webdriver/testing'),
    describe = test.describe,
    it = test.it;

var chai = require('chai'),
    expect = chai.expect,
    assert = chai.assert;

describe('Test sandstorm title', function(){
  var driver;

  before(function() {
    driver = new webdriver.Builder().
      withCapabilities(webdriver.Capabilities.phantomjs()).
      build();
  });

  describe('Check homepage', function(){
    it('should see the correct title', function() {
      driver.get('http://localhost:6080');
      driver.getTitle().then(function(title) {
        expect(title).to.have.string('Sandstorm');
      });
    });
  });

  after(function() {
    driver.quit();
  });
});
