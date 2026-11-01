# Private connectivity and optional public listeners

VPN installation is a separate host administration task. Kloud does not enroll hosts,
issue VPN credentials, change VPN routes, or manage a five-host VPN. No VPN product
has been selected by this implementation.

## Establish private connectivity

Before cross-host database use, inventory each host's OS, access method, network
interfaces, NAT/firewall rules and overlapping private subnets. Choose and configure
a VPN appropriate to those hosts separately. Preserve management access and an
independent rollback path while changing host networking.

Record each configured private/VPN IP in the connector's **Network addresses**
settings. These values are independent of detected public addresses and DNS target
overrides. Metadata is not proof of reachability and does not change host interfaces.

Validate both directions at the actual workload boundary:

1. Verify the intended private address is reachable between the relevant hosts.
2. Bind database access to the intended private interface and restrict firewall
   access to authorized project clients. Do not open a public listener to make a
   private-connectivity test pass.
3. From an application container on another host, connect using the actual
   database client, private address, database name and app role. Verify an allowed
   query and rejection using incorrect credentials.
4. Verify an unauthorized host/container cannot connect and that a public Internet
   client cannot reach the private database port.
5. Repeat container-to-database checks after reconnecting the VPN and restarting
   the connector. A host ping alone does not validate container routing or database
   authorization. A Docker bridge is local to a host and does not span the VPN.

Kloud-managed PostgreSQL resources start on a project-local Docker network without
published host ports. That default does not expose the resource across a VPN.
Cross-host private database publication and host firewall changes must be configured
and verified separately before claiming the resource is remotely reachable.

## Generic TCP/UDP listeners

Listeners are opt-in and disabled by default. App deployers manage listeners for
assigned services. An empty source list is explicitly **Allow anyone**; a nonempty
list requires matching IPv4/IPv6 CIDRs. Invalid entries reject the complete rule.
TCP and UDP may share a numeric port. Management, VPN and HTTP proxy ports are
reserved. Actual OS binding conflicts are reported as errors.

Run the connector in the host network namespace when enabling this facility.
For a containerized Linux connector, this requires an explicitly reviewed host
network configuration. Ordinary bridged Docker port publication is not sufficient:
it may hide the source address, and dynamically configured ports are not
published automatically. Docker Desktop host networking has separate platform
requirements and is not claimed verified by loopback tests.

Set `FORWARDING_ENABLED=true` and set `FORWARDING_BIND_ADDRESSES` to a
comma-separated administrator-approved list of actual host addresses, or explicit
wildcards (`0.0.0.0` and/or `::`). These settings do not open firewall ports.
The connector advertises forwarding support only when enabled. Configure the
host firewall deliberately; the connector does not replace unrelated firewall,
VPN, SSH or Docker rules.

In a service's **Listeners** tab, select an assigned container, its Docker network
and internal port, an approved public bind address, protocol, port and source
CIDRs. Review the exact mapping and source policy before enabling it. The connector
checks target ownership again and accepts source addresses at the listener socket,
before proxying traffic to the target. TCP sockets and UDP associations are bounded;
changes, removal, authorization loss or backend replacement can end connections.
Loss of API authorization/connectivity closes active listeners until a successful
sync authorizes them again. A removed deploy grant disables listeners owned by that
actor; an authorized manager may review and save them under current authority.

The desired/applied/error status is separate from application health. A listener
may bind successfully while a backend is temporarily unreachable. Failed bindings
and target-validation failures are reported; inspect backend connectivity from an
external allowed client before announcing availability.

## PostgreSQL TLS gate

Public PostgreSQL listeners cannot be enabled in this implementation. The API
rejects PostgreSQL rules and the connector additionally rejects recognized
PostgreSQL targets. Private/VPN encryption and raw TCP forwarding do not establish
native PostgreSQL TLS. Supporting this workflow requires an owned certificate and
hostname model, issuance/import, renewal and reload, `hostssl` access controls,
plaintext rejection and tests with `sslmode=verify-full`. An HTTP proxy certificate
or a generic TLS terminator does not establish those properties.

## Host acceptance checks still required

Before production enablement, exercise real external allowed and denied clients,
IPv4/IPv6 independently where configured, restricted-to-empty and empty-to-restricted
allowlist changes, TCP/UDP same-port listeners, OS conflicts, connector restart,
API/credential revocation, target-container replacement and unrelated firewall rule
preservation. Local socket tests validate proxy/CIDR behavior; they do not establish
correct source-address preservation on a particular host or Docker network.
