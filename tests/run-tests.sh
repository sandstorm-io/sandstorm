#!/bin/bash

start-selenium &

sleep 2 # TODO: make this more robust...

mocha basic
rc=$?

[[ -z "$(jobs -p)" ]] || kill $(jobs -p)
exit $rc
