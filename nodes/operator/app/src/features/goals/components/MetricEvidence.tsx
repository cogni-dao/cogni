// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
"use client";
import {
  MetricObservationSchema,
  MetricViewSchema,
} from "@cogni-dao/metrics/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { z } from "zod";
/** Evidence inspection lives with its owning knowledge atom, never a manual compute control. */
export function MetricEvidence({ id }: { id: string }) {
  const observationId = useSearchParams().get("observation");
  const query = useQuery({
    queryKey: ["metric", "evidence", id, observationId],
    refetchInterval: 15000,
    queryFn: async () => {
      const base = `/api/v1/metrics/${encodeURIComponent(id)}`;
      const response = await fetch(base, { cache: "no-store" });
      if (!response.ok) throw new Error("Evidence unavailable");
      const current = MetricViewSchema.extend({
        history: z.array(MetricObservationSchema),
      }).parse(await response.json());
      let pinned = null;
      if (observationId) {
        const r = await fetch(
          `${base}/observations/${encodeURIComponent(observationId)}`,
          { cache: "no-store" }
        );
        if (!r.ok) throw new Error("Linked evidence unavailable");
        pinned = MetricObservationSchema.parse((await r.json()).observation);
      }
      return { current, pinned };
    },
  });
  if (query.isError)
    return (
      <p role="alert" className="text-sm text-warning">
        Measurement evidence is unavailable.
      </p>
    );
  if (!query.data)
    return <p className="text-muted-foreground text-sm">Loading evidence…</p>;
  const { current, pinned } = query.data;
  const history = [
    ...(pinned ? [pinned] : []),
    ...current.history.filter((r) => r.id !== pinned?.id),
  ];
  return (
    <section
      aria-label="Measurement evidence"
      className="space-y-3 rounded-lg border p-4 text-sm"
    >
      <h2 className="font-medium">Measurement evidence</h2>
      <p className="text-muted-foreground">
        Readings are recorded automatically. Each keeps its source time and
        definition.
      </p>
      {pinned && (
        <p>
          Linked immutable evidence; its definition may differ from the current
          metric.
        </p>
      )}
      {history.slice(0, pinned ? 1 : 3).map((r) => (
        <article
          id={`observation-${r.id}`}
          key={r.id}
          className="space-y-1 rounded border p-3"
        >
          <p className="font-medium">
            {r.value ?? "Unknown"} {r.unit} · {r.status}
          </p>
          <p className="text-muted-foreground text-xs">{r.window.end}</p>
          <p className="break-all text-xs">Observation {r.id}</p>
          <p className="break-all text-muted-foreground text-xs">
            Definition {r.definitionHash} · {r.calculatorVersion}
          </p>
          <p className="break-all text-muted-foreground text-xs">
            {r.reason ?? r.evidenceRefs.join(" · ")}
          </p>
        </article>
      ))}
      <details>
        <summary className="cursor-pointer text-muted-foreground">
          Measurement history · {current.history.length} recent readings
        </summary>
        <ol className="mt-2 space-y-1 text-xs">
          {current.history.map((r) => (
            <li key={r.id}>
              {r.window.end} · {r.value ?? "Unknown"} {r.unit} · {r.status}
            </li>
          ))}
        </ol>
      </details>
    </section>
  );
}
