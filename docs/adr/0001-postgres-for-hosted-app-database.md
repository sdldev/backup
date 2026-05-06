# 0001. Use Postgres for the hosted application database

## Status

Accepted

## Context

The original technology plan included SQLite with Drizzle. The product is a hosted multi-tenant SaaS for database backups, with Workspaces, Projects, Database Sources, scheduled Backup Jobs, audit logs, sessions, plan limits, notifications, and worker queues.

Hosted deployments need reliable concurrent writes from the API, workers, scheduling, audit logging, sessions, and future billing integrations. SQLite is attractive for local development and small self-hosted deployments, but a hosted SaaS can outgrow a single-file database and its write-locking model quickly.

## Decision

Use Postgres as the application database for hosted deployments. Use Drizzle with the Postgres dialect for the app database.

Self-hosted v1 deployments also require Postgres. SQLite is not part of the v1 application database stack.

## Consequences

- Hosted SaaS deployments have a database better suited to concurrent multi-tenant workloads.
- Queue, audit, session, and plan-limit writes can share the same production-grade relational database.
- The system avoids maintaining two SQL dialects and two migration paths in v1.
- The product gives up SQLite's simpler single-file deployment story.
- Self-hosted users must operate Postgres.
