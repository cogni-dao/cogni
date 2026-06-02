CREATE TABLE "execution_requests" (
	"idempotency_key" text PRIMARY KEY NOT NULL,
	"request_hash" text NOT NULL,
	"run_id" text NOT NULL,
	"trace_id" text,
	"ok" boolean NOT NULL,
	"error_code" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
