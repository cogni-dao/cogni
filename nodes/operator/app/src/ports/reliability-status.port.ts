// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Read-only seam from the public app to the private reliability actuator. */

import type {
  ReliabilityEnvironment,
  ReliabilityStatusV1,
} from "@cogni/node-contracts";

export interface ReliabilityStatusReaderPort {
  read(input: {
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: ReliabilityEnvironment;
  }): Promise<ReliabilityStatusV1>;
}
