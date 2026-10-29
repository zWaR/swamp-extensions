# @cachehit/mysql-client

Read-only client for MySQL and [Aurora MySQL](https://aws.amazon.com/rds/aurora/). It checks connectivity, runs
parameterized queries and records table and column metadata, all as swamp data that workflows can read with CEL.

## Prerequisites

- [swamp](https://github.com/swamp-club/swamp) CLI
- A MySQL-compatible endpoint reachable over TCP, and a database user. A user with only `SELECT` grants, or the Aurora
  reader endpoint, is recommended.

The network path is yours to provide. If the database is only reachable inside a cluster, start a port-forward or tunnel
yourself, for example:

```bash
kubectl -n <namespace> port-forward deployment/db-proxy 3308:3306
```

The model never opens or manages tunnels and runs no other programs. When nothing is listening on `host:port`, `check`
and the other methods say so instead of printing a raw socket error.

## Installation

```bash
swamp extension pull @cachehit/mysql-client
```

## Usage

### Store the credentials

```bash
swamp vault create local_encryption db
swamp vault put db USER
swamp vault put db PASSWORD
```

### Create the model

```bash
swamp model create @cachehit/mysql-client my-db \
  --global-arg host=127.0.0.1 \
  --global-arg port=3308 \
  --global-arg database=app \
  --global-arg 'user=${{ vault.get("db", "USER") }}' \
  --global-arg 'password=${{ vault.get("db", "PASSWORD") }}'
```

| Global argument    | Default      | Description                      |
| ------------------ | ------------ | -------------------------------- |
| `host`             | `127.0.0.1`  | Host to connect to               |
| `port`             | `3308`       | TCP port to connect to           |
| `database`         | _(none)_     | Default database                 |
| `user`             | _(required)_ | MySQL user                       |
| `password`         | _(required)_ | MySQL password; marked sensitive |
| `connectTimeoutMs` | `5000`       | Connect timeout in milliseconds  |

### Methods

**`check`** records the server version, Aurora version (null on plain MySQL), current user, database and read-only flag
as the `connection` data item.

```bash
swamp model method run my-db check
```

**`query`** runs one or more named statements over a single connection and stores each result as `result-<name>`, with
`columns`, `rows`, `rowCount`, `truncated` and `durationMs`. Bind values with `?` placeholders and `params`.

```yaml
# queries.yaml
queries:
  - name: recent-orders
    sql: SELECT id, status, createdAt FROM orders WHERE createdAt > ? ORDER BY createdAt DESC
    params: ["2026-10-01"]
maxRows: 100
```

```bash
swamp model method run my-db query --input-file queries.yaml
swamp data query 'model("my-db") && name == "result-recent-orders"' --select content
```

Rows past `maxRows` (default 1000, at most 50000) are dropped and `truncated` is set. The whole result set is read
before it is cut, so put a `LIMIT` in the SQL for large tables. Dates become ISO strings, binary values base64, and
`BIGINT`/`DECIMAL` values strings.

**`schema`** records the tables and columns of a database (the global `database` by default) as `schema-<database>`.

```bash
swamp model method run my-db schema
swamp model method run my-db schema --input database=other
```

## Read-only guarantee

Writes are refused in two layers:

1. Before connecting, `query` rejects any statement that doesn't start with `SELECT`, `WITH`, `SHOW`, `DESC`, `DESCRIBE`
   or `EXPLAIN`. It also rejects MySQL executable comments (`/*! ... */`) and `SELECT ... INTO OUTFILE` or `DUMPFILE`.
   This matters because DDL and `COMMIT` end an open transaction before they run.
2. Accepted statements run inside `START TRANSACTION READ ONLY`, followed by a `ROLLBACK` that always runs, so the
   server refuses `INSERT`, `UPDATE` and `DELETE` even inside a `WITH` statement.

## License

Apache-2.0. See [LICENSE.md](LICENSE.md).
