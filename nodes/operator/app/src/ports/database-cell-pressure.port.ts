// SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
// SPDX-FileCopyrightText: 2025 Cogni-DAO

/** Native measured pressure from one privately bound, owned state cell. */
export interface DatabaseCellPressureObservation {
  readonly nodeId: string;
  readonly nodeSlug: string;
  readonly environment: "candidate-a" | "preview" | "production";
  readonly allocationReceiptId: string;
  readonly dseq: string;
  readonly providerAccount: string;
  readonly databaseName: string;
  readonly systemIdentifier: string;
  readonly targetBuildSha: string;
  readonly observedAt: string;
  readonly totalBackends: number;
  readonly roles: readonly {
    readonly name: string;
    readonly kind: "app" | "service" | "replay";
    readonly connectionLimit: number;
    readonly connections: number;
    readonly active: number;
    readonly waiting: number;
    readonly idle: number;
    readonly idleInTransaction: number;
  }[];
  readonly queryRef: string;
}

/** Read-only, fixed aggregate; never accepts SQL, roles, or connection credentials. */
export interface DatabaseCellPressurePort {
  observe(input: {
    readonly nodeId: string;
    readonly nodeSlug: string;
    readonly environment: "candidate-a" | "preview" | "production";
    readonly cellId: string;
  }): Promise<DatabaseCellPressureObservation>;
}
