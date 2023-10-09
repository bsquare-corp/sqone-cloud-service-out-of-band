#!/bin/sh -e

find ./src -name "*.sql" -exec sh -ec 'mkdir -p $(dirname $(echo ${0} | sed s/src/dist/)) && cp ${0} $(echo ${0} | sed s/src/dist/)' {} \;
