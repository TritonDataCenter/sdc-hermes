#!/bin/ksh

set -o errexit

log_path="${1}"
put_url="${2}"
zone_name="${3}"

if [[ -z "${log_path}" || -z "${put_url}" || -z "${zone_name}" ]]; then
  echo "ERROR: Missing args" >&2
  exit 1
fi

if [[ ${zone_name} != global ]]; then
  log_path="/zones/${zone_name}/root/${log_path}"
fi

content_md5=$(/usr/bin/openssl md5 -binary "${log_path}" | openssl enc -base64)

/usr/bin/curl -fsS -X PUT \
  -H "Content-MD5: ${content_md5}" \
  -T "${log_path}" \
  "${put_url}"

