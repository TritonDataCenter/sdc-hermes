#!/bin/ksh
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

set -o errexit
set -o pipefail

. /lib/svc/share/smf_include.sh

CURL=/usr/bin/curl
GUNZIP=/usr/bin/gunzip
TAR=/usr/bin/tar
DIGEST=/usr/bin/digest
SVCCFG=/usr/sbin/svccfg
SVCADM=/usr/sbin/svcadm

if [[ $SMF_FMRI != "svc:/smartdc/hermes-actor:default" ]]; then
	printf "ERROR: not running under correct SMF service\n" >&2
	exit $SMF_EXIT_ERR_NOSMF
fi

ACTOR_DIR="/opt/smartdc/hermes-actor"
TMPFILE="/tmp/.hermes-actor.$$.tar.gz"
DEPLOY_DIR="${ACTOR_DIR}/deploy"
VERFILE="${DEPLOY_DIR}/.version"

while :; do
	cd /tmp

	server=$(svcprop -p hermes/server ${SMF_FMRI})
	redeploy=$(svcprop -p hermes/redeploy ${SMF_FMRI})

	if [[ $redeploy != "false" ]]; then
		rm -rf ${DEPLOY_DIR}
	fi

	if [[ ! -f ${VERFILE} ]]; then
		rm -rf ${DEPLOY_DIR}

		mkdir -p ${DEPLOY_DIR}
		if ! ${CURL} -fsS -o ${TMPFILE} \
		    "http://${server}/actor.tar.gz"; then
			printf "failed to download; retrying...\n" >&2
			rm -f ${TMPFILE}
			sleep 1
			continue
		fi

		cd ${DEPLOY_DIR}

		if ! ${TAR} xfz ${TMPFILE}; then
			printf "failed to extract; retrying...\n" >&2
			rm -f ${TMPFILE}
			sleep 1
			continue
		fi

		${DIGEST} -a sha1 ${TMPFILE} > ${VERFILE}
		rm -f ${TMPFILE}

		${SVCCFG} -s ${SMF_FMRI%%:default} \
		    'setprop hermes/redeploy = false'
		${SVCADM} refresh ${SMF_FMRI}
	fi

	break
done

#
# Start the actor
#
cd $DEPLOY_DIR
${DEPLOY_DIR}/bin/node ${DEPLOY_DIR}/actor.js &

# vim: set ts=8 sts=8 sw=8 noet:
