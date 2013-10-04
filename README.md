# hermes

This is an interim tool for uploading logs from SDC Compute Nodes and Zones into Manta.
It is built to run in the "sdc" zone, which need to be able to resolve the names of,
and route traffic to, the Manta DC in question.

## Configuration

```js
{
  "admin_ip": "10.101.50.22",
  "sapi": {
    "url": "http://sapi.sf1.sf1.joyent.com"
  },
  "rabbitmq": "guest:guest:10.101.50.13:5672",
  "polling": {
    "sysinfo": 60,
    "discovery": 120
  }
}
```

Polling intervals are specific in _seconds_ -- `polling.sysinfo` for how often
we (re-)discover _servers_; `polling.discovery` for how often we (re-)discover
_log files_.

The `admin_ip` is the IP address we will bind to for the SDC _ADMIN_ network.

## Logsets

```
/* XXX */
```
