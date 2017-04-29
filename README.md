# sdc-hermes

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md) --
*Triton does not use GitHub PRs* -- and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

## Overview

Hermes is a log and data file archival system provided as part of a Triton
deployment.  Hermes archives log (or other data) files from compute nodes and
Triton internal service zones; for example, the usage telemetry files from the
_hagfish-watcher_ agent, or audit logs from _CloudAPI_.

Hermes transfers the nominated set of data or log files to the storage provided
by a Joyent Manta instance, removing them from local disk only after the upload
is complete _and_ a configurable retention period has passed.  Users without
their own Manta deployment may use the public Manta instance available through
the Joyent Public Cloud.

The server process expects to run in the `"sdc"` zone within an Triton
deployment.  That zone must be able to access the Internet, or the network to
which the target Manta instance is available.  Compute nodes access the target
Manta through a proxy running in the `"sdc"` zone, and thus do not themselves
require direct access.


## Architecture


```
  +-------------------------------------------------------------+
  | COMPUTE NODE GLOBAL ZONE                                    |
  |                                                             |
  |   <global zone log files> ............> ****************    |
  |                                         *              *    |
  |    +-------------------------+          *              *    |
  |    | TRITON SERVICE ZONE(S)  |          * hermes-actor *    |
  |    |                         |          *              *    |
  |    |    <log files> ..................> *              *    |
  |    +-------------------------+          ****************    |
  |                                                   :         |
  |                                 ,---------^       :         |
  |                                /                  :         |
  +------------------------------ / ----------------- : --------+
                                 /                    :
                          deployment,               CONNECT
                        config, control              proxy
                              /                       :
  +------------------------- / ---------------------- : --------+
  | "sdc" ZONE              /                         V         |
  |   ________       ****************       ****************    |
  |  (________)      *              *       *              *    |
  |  | config |----> *              *  ,--> *              *    |
  |  | files  |      *    hermes    *  |    * hermes-proxy *    |
  |  \________/      *              *  |    *              *    |
  |        |         *              *  |    *              *    |
  |        |         ****************  |    ****************    |
  |        |                           |              :         |
  |        `---------------------------'              :         |
  |                                                   :         |
  +-------------------------------------------------- : --------+
                                                      :
                .     .                             HTTPS
                |_.-._|                               :
              ./       \.     <.......................;
         _.-'`           `'-._
      .-'        Manta        '-.
    ,'_.._      Storage      _.._',           LEGEND:
    '`    `'-.           .-'`    `'           +-- zone/server --+
              '.       .'                     *** smf service ***
                \_/|\_/                       ... log data .....>
                   |                          --- config ------->
                   |
                   |
```

## License

This Source Code Form is subject to the terms of the Mozilla Public License, v.
2.0.  For the full license text see LICENSE, or http://mozilla.org/MPL/2.0/.

Copyright (c) 2017, Joyent, Inc.
