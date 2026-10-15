-- SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
-- SPDX-FileCopyrightText: 2026 Cogni-DAO
-- Purpose: Compare fenced source/restore schema, constraints, counts and full-row checksums.
-- Scope: Explicitly qualified read-only dump/restore proof, never a runtime research route.
-- Invariants: Streaming aggregates; no row payloads emitted; UTC; no application writes.
\set ON_ERROR_STOP on
\pset format unaligned
\pset tuples_only on
SET default_transaction_read_only = on;
SET timezone = 'UTC';
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;

WITH descriptors AS (
  SELECT format('%s.%s:%s:%s:%s:%s:%s', schema.nspname, relation.relname,
      attribute.attnum, attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod), attribute.attnotnull,
      coalesce(pg_get_expr(default_value.adbin, default_value.adrelid), '')) AS descriptor
  FROM pg_class relation
  JOIN pg_namespace schema ON schema.oid = relation.relnamespace
  JOIN pg_attribute attribute ON attribute.attrelid = relation.oid
  LEFT JOIN pg_attrdef default_value ON default_value.adrelid = relation.oid AND default_value.adnum = attribute.attnum
  WHERE relation.relkind IN ('r', 'p', 'm') AND attribute.attnum > 0 AND NOT attribute.attisdropped
    AND schema.nspname NOT IN ('pg_catalog', 'information_schema', 'cogni_control')
    AND schema.nspname !~ '^pg_toast'
  UNION ALL
  SELECT format('%s.%s:index:%s', schema.nspname, relation.relname, pg_get_indexdef(index_record.indexrelid))
  FROM pg_index index_record
  JOIN pg_class relation ON relation.oid = index_record.indrelid
  JOIN pg_namespace schema ON schema.oid = relation.relnamespace
  WHERE schema.nspname NOT IN ('pg_catalog', 'information_schema', 'cogni_control')
    AND schema.nspname !~ '^pg_toast'
  UNION ALL
  SELECT format('%s.%s:constraint:%s:%s', schema.nspname, relation.relname,
      constraint_record.conname, pg_get_constraintdef(constraint_record.oid, true))
  FROM pg_constraint constraint_record
  JOIN pg_class relation ON relation.oid = constraint_record.conrelid
  JOIN pg_namespace schema ON schema.oid = relation.relnamespace
  WHERE schema.nspname NOT IN ('pg_catalog', 'information_schema', 'cogni_control')
    AND schema.nspname !~ '^pg_toast'
)
SELECT jsonb_build_object('kind', 'schema', 'checksum',
  md5(coalesce(string_agg(descriptor, E'\n' ORDER BY descriptor), '')))
FROM descriptors;

-- Two independent signed 64-bit halves of every row's 128-bit checksum are
-- summed as numeric, preserving duplicate multiplicity without sorting or
-- materializing the dataset. Root tables include their partition contents.
SELECT format(
  $query$SELECT jsonb_build_object('kind','data','schema',%L,'table',%L,
    'rows', count(*)::text,
    'checksumHigh',coalesce(sum(('x'||substr(md5(to_jsonb(data)::text),1,16))::bit(64)::bigint::numeric),0)::text,
    'checksumLow',coalesce(sum(('x'||substr(md5(to_jsonb(data)::text),17,16))::bit(64)::bigint::numeric),0)::text)
    FROM %I.%I AS data$query$,
  schema.nspname, relation.relname, schema.nspname, relation.relname)
FROM pg_class relation
JOIN pg_namespace schema ON schema.oid = relation.relnamespace
WHERE relation.relkind IN ('r', 'p', 'm') AND NOT relation.relispartition
  AND schema.nspname NOT IN ('pg_catalog', 'information_schema', 'cogni_control')
  AND schema.nspname !~ '^pg_toast'
ORDER BY schema.nspname, relation.relname
\gexec

SELECT format($query$SELECT jsonb_build_object('kind','sequence','schema',%L,'sequence',%L,
  'lastValue',last_value::text,'isCalled',is_called) FROM %I.%I$query$,
  schema.nspname, relation.relname, schema.nspname, relation.relname)
FROM pg_class relation JOIN pg_namespace schema ON schema.oid = relation.relnamespace
WHERE relation.relkind = 'S'
  AND schema.nspname NOT IN ('pg_catalog', 'information_schema', 'cogni_control')
  AND schema.nspname !~ '^pg_toast'
ORDER BY schema.nspname, relation.relname
\gexec
COMMIT;
