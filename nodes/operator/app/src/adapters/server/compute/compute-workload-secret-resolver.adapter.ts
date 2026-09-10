// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2026 Cogni-DAO

import type { CoreV1Api } from "@kubernetes/client-node";
import {
  ComputeLifecycleError,
  type ComputeWorkloadSecretResolverPort,
} from "@/ports";
import { isOffClusterWorkloadSecretKey } from "@/shared/secrets/node-secrets-reserved.data";

function decodeSecretValue(encoded: string): string | undefined {
  if (
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      encoded
    )
  )
    return undefined;
  const bytes = Buffer.from(encoded, "base64");
  const decoded = bytes.toString("utf8");
  if (!decoded || !bytes.equals(Buffer.from(decoded, "utf8"))) return undefined;
  return decoded;
}

export class ComputeWorkloadSecretResolverAdapter
  implements ComputeWorkloadSecretResolverPort
{
  constructor(
    private readonly core: Pick<CoreV1Api, "readNamespacedSecret">,
    private readonly namespace: string
  ) {}

  async resolve(input: {
    nodeId: string;
    nodeSlug: string;
    environment: string;
    serviceName: string;
    sourceSha: string;
    refs: readonly { key: string }[];
  }): Promise<Readonly<Record<string, string>>> {
    const keys = [...new Set(input.refs.map((ref) => ref.key))];
    if (keys.some((key) => !isOffClusterWorkloadSecretKey(key))) {
      throw new ComputeLifecycleError(
        "terminal",
        "SecretPolicyRejected",
        false
      );
    }
    let stored: Readonly<Record<string, string>> = {};
    if (keys.length) {
      try {
        const response = await this.core.readNamespacedSecret(
          `${input.nodeSlug}-compute-env-secrets`,
          this.namespace
        );
        stored = Object.fromEntries(
          Object.entries(response.body.data ?? {}).map(([key, value]) => {
            const decoded = decodeSecretValue(value);
            if (decoded === undefined) {
              throw new ComputeLifecycleError(
                "transient",
                "SecretResolverUnavailable",
                true
              );
            }
            return [key, decoded];
          })
        );
      } catch (error) {
        if (error instanceof ComputeLifecycleError) throw error;
        throw new ComputeLifecycleError(
          "transient",
          "SecretResolverUnavailable",
          true
        );
      }
    }
    const result: Record<string, string> = {};
    for (const key of keys) {
      const value = stored[key];
      if (!value) {
        throw new ComputeLifecycleError(
          "transient",
          "SecretResolverUnavailable",
          true
        );
      }
      result[key] = value;
    }
    return result;
  }
}
