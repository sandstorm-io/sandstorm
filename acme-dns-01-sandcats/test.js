'use strict';

const sandcatsChallenge = require("./index.js");
const fs = require("fs");
const tester = require("acme-dns-01-test");

require("dns").setServers(["104.197.28.173"]);

async function run() {
  let challenger = sandcatsChallenge.create({
    key: fs.readFileSync("id_rsa"),
    cert: fs.readFileSync("id_rsa.pub"),
    hostname: "kenton",
    isTest: true
  });

  await tester.testZone("dns-01", "kenton.sandcats.io", challenger);
  console.log("PASS");
}

run();
