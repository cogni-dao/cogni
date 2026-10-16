#!/usr/bin/env bash
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2025 Cogni-DAO
# Exercise receipt budgets and failed streams without a database or provider.
set -euo pipefail
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
fixture="$(mktemp -d)"
trap 'rm -rf "$fixture"' EXIT
mkdir -p "$fixture/bin" "$fixture/kit/00000000-0000-4000-8000-000000000001"
kit="$fixture/kit/00000000-0000-4000-8000-000000000001"
printf 'backup_neutral\tcogni_neutral\tproduction\t00000000-0000-4000-8000-000000000001\t1234567890123456789\n' > "$kit/targets.tsv"
printf '[backup_neutral]\nhost=fixture.invalid\n' > "$kit/pg_service.conf"
printf 'neutral-fixture-only\n' > "$kit/encryption.key"
printf 'neutral-public-ca-fixture\n' > "$kit/ca.crt"
cat > "$fixture/bin/psql" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  *'SELECT current_database()'*) printf 'cogni_neutral\n' ;;
  *'SHOW server_version_num'*) printf '150018\n' ;;
  *) cat > /dev/null; printf '%s\n' "${FAKE_NATIVE_IDENTITY:-t}" ;;
esac
STUB
cat > "$fixture/bin/pg_dump" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
if [[ "${1:-}" == --version ]]; then printf 'pg_dump (PostgreSQL) 15.18\n'; exit 0; fi
printf 'called\n' >> "$FAKE_DUMP_CALLS"
if [[ "${FAKE_DUMP_FAIL:-0}" == 1 ]]; then printf 'partial archive'; exit 9; fi
printf 'PGDMP-neutral-archive-stream'
STUB
cat > "$fixture/bin/pg_restore" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
[[ "$(cat)" == PGDMP-neutral-archive-stream ]]
STUB
cat > "$fixture/bin/cat" <<'STUB'
#!/usr/bin/env bash
if [[ "${1:-}" == /proc/sys/kernel/random/uuid ]]; then
  printf '00000000-0000-4000-8000-000000000002\n'
else
  exec /bin/cat "$@"
fi
STUB
cat > "$fixture/bin/df" <<'STUB'
#!/usr/bin/env bash
printf 'Filesystem 1048576-blocks Used Available Capacity Mounted on\nfixture 100000 1000 99000 1%% /\n'
STUB
cat > "$fixture/bin/stat" <<'STUB'
#!/usr/bin/env bash
[[ "$1" == -c && "$2" == %s ]]
wc -c < "$3" | tr -d ' '
STUB
chmod +x "$fixture/bin/"*
export PATH="$fixture/bin:$PATH"
export DATABASE_CELL_BACKUP_BOUNDED_RUN=1 DATABASE_CELL_BACKUP_KIT_ROOT="$fixture/kit"
export FAKE_DUMP_CALLS="$fixture/dump-calls"
worker="$repo_root/infra/compose/runtime/db-backup/cell-backup.sh"
DB_BACKUP_ROOT="$fixture/success" bash "$worker" > "$fixture/success.json"
python3 - "$fixture/success.json" "$repo_root/infra/compose/runtime/db-backup/install-cell-timer.sh" <<'CHECK'
import json,re,sys
from pathlib import Path
receipt=json.loads(Path(sys.argv[1]).read_text())
unit_budget=int(re.search(r"^TimeoutStartSec=([0-9]+)s$",Path(sys.argv[2]).read_text(),re.M)[1])
assert receipt['scheduledJobTimeoutSeconds']==unit_budget==800
assert receipt['rpoBoundSeconds']==receipt['intervalSeconds']+receipt['maximumJitterSeconds']+unit_budget==1761
assert 0<receipt['durationSeconds']<unit_budget
assert receipt['rpoBoundSeconds']>receipt['intervalSeconds']+receipt['maximumJitterSeconds']+receipt['durationSeconds']
assert receipt['rpoAssumption']=='successful_schedule_without_failed_or_skipped_runs'
assert receipt['currentRpoBoundSeconds'] is None
assert receipt['archiveBytes']>0 and len(receipt['archiveSha256'])==64
CHECK
# Custom cadence/jitter still use the complete installed job budget.
DB_BACKUP_ROOT="$fixture/custom" DATABASE_CELL_BACKUP_INTERVAL_SECONDS=1800 DATABASE_CELL_BACKUP_MAX_JITTER_SECONDS=90 bash "$worker" > "$fixture/custom.json"
python3 - "$fixture/custom.json" <<'CHECK'
import json,sys
from pathlib import Path
receipt=json.loads(Path(sys.argv[1]).read_text())
assert receipt['rpoBoundSeconds']==1800+90+800
CHECK
# A failed dump must not issue a successful recovery point or leave a partial.
if DB_BACKUP_ROOT="$fixture/failure" FAKE_DUMP_FAIL=1 bash "$worker" > "$fixture/failure.json" 2> "$fixture/failure.err"; then
  echo 'failed native stream produced success' >&2; exit 1
fi
[[ ! -s "$fixture/failure.json" ]]
[[ -z "$(find "$fixture/failure" -name receipt.json -o -name '*.partial')" ]]
# Failure after a completed point preserves that exact recovery artifact.
previous="$(find "$fixture/success" -name MANIFEST.sha256)"
previous_digest="$(sha256sum "$previous")"
if DB_BACKUP_ROOT="$fixture/success" FAKE_DUMP_FAIL=1 bash "$worker" > "$fixture/failed-next.json" 2> "$fixture/failed-next.err"; then
  echo 'failed next scheduled stream produced success' >&2; exit 1
fi
[[ ! -s "$fixture/failed-next.json" && "$(sha256sum "$previous")" == "$previous_digest" ]]
[[ "$(find "$fixture/success" -name receipt.json | wc -l | tr -d ' ')" == 1 ]]
# Worker overrides cannot understate the fixed installed calendar/jitter.
for understated in interval jitter; do
  if [[ "$understated" == interval ]]; then interval=60; jitter=61; else interval=900; jitter=1; fi
  if DB_BACKUP_ROOT="$fixture/understated-$understated" DATABASE_CELL_BACKUP_INTERVAL_SECONDS="$interval" DATABASE_CELL_BACKUP_MAX_JITTER_SECONDS="$jitter" bash "$worker" > "$fixture/understated.json" 2> "$fixture/understated.err"; then
    echo 'understated installed scheduler budget accepted' >&2; exit 1
  fi
  [[ ! -s "$fixture/understated.json" ]]
done
# Wrong native identity aborts before opening the archive stream.
before="$(wc -l < "$FAKE_DUMP_CALLS")"
if DB_BACKUP_ROOT="$fixture/identity" FAKE_NATIVE_IDENTITY=f bash "$worker" > "$fixture/identity.json" 2> "$fixture/identity.err"; then
  echo 'foreign identity produced success' >&2; exit 1
fi
[[ ! -s "$fixture/identity.json" && "$(wc -l < "$FAKE_DUMP_CALLS")" == "$before" ]]
printf 'PASS: complete scheduled-job RPO budget, cadence overrides, failed stream and native identity fail closed\n'
