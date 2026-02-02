// Configure all drivers with working URLs
module.exports = {
  baseURL: 'https://github.com/SeleniumHQ/selenium/releases/download',
  version: '4.10.0',
  drivers: {
    chrome: {
      // Must match installed Chromium version on yertle (142.x)
      version: '142.0.7444.0',
      arch: 'x64',
      baseURL: 'https://storage.googleapis.com/chrome-for-testing-public',
    },
    firefox: {
      version: 'latest',
      arch: 'x64',
      baseURL: 'https://github.com/mozilla/geckodriver/releases/download',
    },
    chromiumedge: {
      version: 'latest',
      arch: 'x64',
      // Use microsoft.com instead of azureedge.net which has DNS issues
      baseURL: 'https://msedgedriver.microsoft.com',
    }
  },
};
