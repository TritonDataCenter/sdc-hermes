#!/bin/ksh

set -o errexit

log_path="${1}"
remote_md5="${2}"
zone_name="${3}"

if [[ -z "${log_path}" || -z "${remote_md5}" || -z "${zone_name}" ]]; then
  echo "ERROR: Missing args" >&2
  exit 1
fi

if [[ ${zone_name} != global ]]; then
  log_path="/zones/${zone_name}/root/${log_path}"
fi

if [[ ! -f "${log_path}" ]]; then
  # Already deleted.
  exit 0
fi

content_md5=$(/usr/bin/openssl md5 -binary "${log_path}" | openssl enc -base64)

if [[ "$content_md5" != "$remote_md5" ]]; then
  echo "ERROR: md5 mismatch from local to remote" >&2
  echo "       local:  ${content_md5}" >&2
  echo "       remote: ${remote_md5}" >&2
  exit 1
fi

rm -f "${log_path}"
