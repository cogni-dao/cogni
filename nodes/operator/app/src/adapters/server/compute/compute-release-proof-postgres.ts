// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

/** Proof-only max1 transport. Driver end() alone does not confirm socket closure.
 * The supported onclose callback observes actual connection closure in postgres3.4.7.
 * An unconfirmed close permanently retires the owning proof lane, never the wallet.
 */
import postgres from "postgres";

export function proofPostgres(
  dsn: string,
  connection: Record<string, string | number | boolean>
) {
  let confirmed = false;
  let observedClose: (() => void) | undefined;
  const closed = new Promise<void>((resolve) => {
    observedClose = resolve;
  });
  const sql = postgres(dsn, {
    max: 1,
    connect_timeout: 1,
    idle_timeout: undefined,
    max_lifetime: null,
    connection,
    onclose: () => {
      confirmed = true;
      observedClose?.();
    },
  });
  let closing: Promise<boolean> | undefined;
  return {
    sql,
    close(): Promise<boolean> {
      closing ??= (async () => {
        await sql.end({ timeout: 0 });
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            closed,
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, 100);
            }),
          ]);
          return confirmed;
        } finally {
          clearTimeout(timer);
        }
      })();
      return closing;
    },
  };
}
