#!/bin/bash

nightwatch
rc=$?

[[ -z "$(jobs -p)" ]] || kill $(jobs -p)
exit $rc
