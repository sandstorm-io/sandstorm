'use strict';

const defaults = {
  baseUrl: 'https://desec.io/api/v1'
};

module.exports.create = function(config) {
  // config = { baseUrl, token }
  const baseUrl = (config.baseUrl || defaults.baseUrl).replace(/\/$/, '');
  const authtoken = config.token;
  let request;

  function api(method, path, form) {
    const req = {
      method: method,
      url: baseUrl + path,
      headers: {
        Authorization: 'Token ' + authtoken,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      json: true,
      body: form
    };
    return request(req).then(function(resp) {
      if (2 !== Math.floor(resp.statusCode / 100)) {
        console.error(resp.statusCode, req.url);
        console.error();
        console.error('Request:');
        console.error(req);
        console.error();
        console.error('Response:');
        console.error(resp.body);
        console.error();
        throw new Error('Error response. Check token, baseUrl, domains, etc.');
      }
      return resp;
    });
  }

  const helpers = {
    getExistingRecords: function(ch) {
      return api('GET',
        '/domains/' + ch.dnsZone + '/rrsets/?type=TXT&subname=' + ch.dnsPrefix)
        .then(function(existing) {
          if (existing && existing.body.length && existing.body[0].records) {
            return existing.body[0].records;
          }
          return [];
        });
    }
  };

  return {
    init: function(opts) {
      request = opts.request;
      return null;
    },
    zones: function(/*opts*/) {
      // { dnsHosts: [ xxxx.foo.example.com ] }
      //console.info('Get zones');
      return api('GET', '/domains/').then(function(resp) {
        return resp.body.map(function(x) {
          return x.name;
        });
      });
    },
    set: function(data) {
      const ch = data.challenge;
      const txt = '"' + ch.dnsAuthorization + '"';

      // console.info('Adding TXT', data);

      // find minimum ttl

      return api('GET', '/domains/' + ch.dnsZone + '/').then(function(resp) {
        if (resp && resp.body && resp.body.minimum_ttl) {
          // find existing records
          return helpers.getExistingRecords(ch).then(function(existing) {
              const records = existing;

              if (records.indexOf(txt) === -1) {
                records.push(txt);
              }

              return api('PUT', '/domains/' + ch.dnsZone + '/rrsets/', [{
                type: 'TXT',
                subname: ch.dnsPrefix,
                records: records,
                ttl: resp.body.minimum_ttl
              }]).then(function(resp) {
                resp = resp.body;
                if (resp.length && resp[0].records && resp[0].records.indexOf(txt) !== -1) {
                  return true;
                }
                throw new Error('record did not set. check subdomain, api key, etc');
              });
          });
        }
        throw new Error('could not determine minimum ttl');
      })
    },
    remove: function(data) {
      const ch = data.challenge;

      // console.info('Removing TXT', data);
      return helpers.getExistingRecords(ch).then(function(existing) {
        const records = existing;
        const txt = '"' + ch.dnsAuthorization + '"';
        if (records.indexOf(txt) !== -1) {
          records.splice(records.indexOf(txt), 1);
        }

        return api(
          'PATCH',
          '/domains/' + ch.dnsZone + '/rrsets/' + ch.dnsPrefix + '/TXT/',
          { records: records }
        ).then(function(resp) {
          resp = resp.body;
          return true;
        });
      });
    },
    get: function(data) {
      const ch = data.challenge;

      // console.info('Fetching TXT', data);
      return helpers.getExistingRecords(ch).then(function(existing) {
          const records = existing.map(x => x.replace(/^\"+|\"+$/g, ''));
          if (records.indexOf(data.challenge.dnsAuthorization) !== -1) {
            return { dnsAuthorization: data.challenge.dnsAuthorization };
          }
          return null;
      });
    }
  };
};
