# Connector workspaces

The sidebar picker contains Projects and Connectors. Select a connector to browse its Containers, PM2 applications, or Overview. Administration / Connectors also provides an Open connector link.

Connector tables show resources across projects and discovered unassigned resources. Project links appear only for projects the current user can access. Discovery retains its existing collection behavior; enabling a workspace does not discover additional resources automatically.

## Server permissions

| Permission                                         | Connector workspace access                                                                |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Server Administrator                               | All browsing, resource operations, connector settings, and host SSH                       |
| Manage connectors                                  | Metadata, discovery settings, token revocation, and host SSH                              |
| Manage inventory assignments                       | Read connector metadata and resource inventory                                            |
| Operate connector resources (`connectors.operate`) | Read metadata/inventory and operate containers and PM2 applications across all connectors |

The new capability is explicit: existing non-admin users do not receive it automatically. Project permissions continue to apply on project routes. Host-wide operation permission does not grant connector settings or host SSH access.

Container operations include logs, inspection, start/stop/restart, and container shell. PM2 operations include logs, start/stop/restart/reload, and delete. Operations require fresh inventory and the matching runtime capability. Internal infrastructure containers remain protected. Permission loss ends access to log output and terminal requests.

## Interfaces and rollout

Run the normal API migrations before using the feature. Migration 10 extends the allowed server capabilities without changing existing grants.

Authenticated metadata endpoints: `GET /connectors` and `GET /connectors/:connector`.

Resource endpoints use `/connectors/:connector/containers` and `/connectors/:connector/pm2`. Each supports listing and `/:resource/permissions`, `/:resource/operation`, and `/:resource/logs`. Host SSH and settings continue using the existing administration endpoints. The authenticated OpenAPI document describes the new routes.

Run database-free browser coverage with `pnpm --filter @kloud/website exec playwright test --config playwright.workspace.config.ts`. Set `TEST_DATABASE_URL` to an isolated PostgreSQL 17 database for API integration tests.
