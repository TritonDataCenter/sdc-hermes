#!/bin/ksh -x
#
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at http://mozilla.org/MPL/2.0/.
#

#
# Copyright (c) 2014, Joyent, Inc.
#

#
# Bootstrap the hermes actor on a node
#

set -o errexit
set -o pipefail

SVCS=/usr/bin/svcs
SVCADM=/usr/sbin/svcadm
SVCCFG=/usr/sbin/svccfg
SVCPROP=/usr/bin/svcprop
CURL=/usr/bin/curl

ACTOR_DIR="/opt/smartdc/hermes-actor"
FMRI="svc:/smartdc/hermes-actor:default"

SERVER="%%ENDPOINT%%"
SMF_REVISION="%%SMF_REVISION%%"


mkdir -p ${ACTOR_DIR}

${CURL} -fsS -o ${ACTOR_DIR}/.method.ksh "http://${SERVER}/actor.ksh"

#
# Compare downloaded method script with existing one...
#
method_changed=false
if ! /usr/bin/cmp -s ${ACTOR_DIR}/.method.ksh ${ACTOR_DIR}/method.ksh; then
	#
	# Either the file didn't exist, or the contents differed.
	#
	method_changed=true
	chmod 755 ${ACTOR_DIR}/.method.ksh
	mv ${ACTOR_DIR}/.method.ksh ${ACTOR_DIR}/method.ksh
else
	rm -f ${ACTOR_DIR}/.method.ksh
fi

#
# Do we need to import the smf(5) manifest?
#
smf_required=true
if rev=$(${SVCPROP} -p hermes/revision ${FMRI}); then
	if [[ ${rev} == "${SMF_REVISION}" ]]; then
		smf_required=false
	else
		printf "smf manifest revision incorrect, redeploying\n" >&2
	fi
fi

#
# If the smf manifest revision has changed, or we deployed a new method
# script, then reinitialise the entire service:
#
if [[ ${method_change} == true || ${smf_required} == true ]]; then
	#
	# Delete existing service, if it exists:
	#
	${SVCADM} disable -s ${FMRI} || true
	${SVCCFG} delete -f ${FMRI} || true
	#
	# Deploy new service:
	#
	printf "downloading new smf manifest\n" >&2
	${CURL} -fsS -o ${ACTOR_DIR}/actor.xml "http://${SERVER}/actor.xml"
	printf "importing new smf manifest\n" >&2
	${SVCCFG} import ${ACTOR_DIR}/actor.xml
fi

#
# Ensure the service is configured correctly:
#
needs_restart=true
if val=$(${SVCPROP} -p hermes/server ${FMRI}); then
	if [[ ${val} == ${SERVER} ]]; then
		needs_restart=false
	else
		printf "reconfiguring server to ${SERVER}\n" >&2
		${SVCCFG} -s ${FMRI%%:default} \
		    "setprop hermes/server = ${SERVER}"
	fi
fi

#
# If the service is in maintenance, have it redeploy itself
#
if status=$(${SVCS} -o state -H ${FMRI}); then
	if [[ ${status} == "maintenance" ]]; then
		printf "service in maintenance; redeploying...\n" >&2
		${SVCCFG} -s ${FMRI%%:default} \
		    "setprop hermes/redeploy = true"
		${SVCADM} refresh ${FMRI}
		${SVCADM} clear ${FMRI}
	fi
fi

#
# (Re)start the service as required:
#
if [[ ${needs_restart} == true ]]; then
	${SVCADM} disable -s ${FMRI}
	${SVCADM} refresh ${FMRI}
fi
${SVCADM} enable ${FMRI}

exit 0

# vim: set ts=8 sts=8 sw=8 noet:
