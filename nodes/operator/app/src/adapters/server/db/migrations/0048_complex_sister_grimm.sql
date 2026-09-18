-- bug.5187 — key the Akash ledger's serialization domain on the Console ACCOUNT, not on the
-- deploy environment, and move the existing receipts in the SAME change.
--
-- WHY THE DATA MUST MOVE WITH THE CODE. `wallet_scope` is not merely a serializer input: the
-- ledger adapter's `claimOnce` finds a prior receipt by the composite key
-- `(wallet_scope, cogni_key)`. Change the derived value and every existing receipt becomes
-- INVISIBLE to the next lookup — the reconciler claims a fresh row, sees no `external_name`,
-- concludes nothing was ever created, and mints a SECOND PAID LEASE beside one that is still
-- billing. At authoring time production held 5 active leases whose receipts were all keyed on
-- `akash-console:production`, so this is a live money path, not a rename.
--
-- WHY PER ENVIRONMENT DATABASE, FROM ONE FILE. Each environment owns its own operator Postgres
-- and applies this same file to it. The map below is therefore exhaustive across environments
-- rather than parameterised: applied to candidate-a's database only the candidate-a rows exist
-- and only they are rewritten; applied to production's database, only production's. The account
-- ids are the PUBLIC, git-reviewable pins already carried by
-- `infra/k8s/overlays/<env>/operator/kustomization.yaml` (AKASH_ACTUATOR_ACCOUNT_ID). This
-- migration does NOT change any pin — it restates the existing env->account binding as the
-- scope those rows should have carried all along.
--
-- CONCURRENCY SAFETY. Three things, in this order:
--   1. `SHARE ROW EXCLUSIVE` conflicts with the `ROW EXCLUSIVE` every INSERT/UPDATE takes, so a
--      live writer cannot slip a row in between the precondition check and the rewrite. The
--      lock is held for one small UPDATE. `lock_timeout` makes a blocked migration fail loudly
--      in 5s instead of wedging a deploy behind someone else's long transaction.
--   2. NO `state='preparing'` ROW IS EVER REWRITTEN. A preparing row is a writer mid-spend:
--      its cursor was written before the Console POST, and moving its scope would orphan the
--      only evidence that recovers a lost response. Production had zero preparing rows when
--      this was authored; that is ENFORCED here, not assumed — any preparing legacy row aborts
--      the migration and a human resolves the in-flight allocation first.
--   3. Row counts are asserted. The expected count is read under the lock, the UPDATE's actual
--      count must equal it, and zero legacy rows may remain. A partial rewrite cannot commit.
--
-- WHAT HAPPENS TO AN UNMAPPED LEGACY SCOPE. Nothing here, deliberately — and then the CHECK
-- constraint below refuses to validate and the whole migration aborts. An `akash-console:<env>`
-- value for an environment that pins no account means a writer existed where git says none can,
-- which is exactly the second-writer condition this work exists to detect. Failing the deploy
-- is the correct response; silently skipping it is not.
--
-- The lock_timeout is TRANSACTION-scoped on purpose rather than set inside the block below: it
-- must also cover the trailing ADD CONSTRAINT, which takes ACCESS EXCLUSIVE. With no timeout a
-- deploy would HANG behind an unrelated long reader instead of failing; 5s turns that into a
-- loud, retryable migration failure. `SET LOCAL` is reverted by the migrator's COMMIT.
SET LOCAL lock_timeout = '5s';--> statement-breakpoint
DO $$
DECLARE
	legacy_map CONSTANT text[][] := ARRAY[
		-- deploy environment          , the account its overlay pins (public, non-secret)
		['candidate-a', 'akash12eh8xgpeyumar3sk6wp94y0tq9uh62mkezxjmt'],
		['production' , 'akash10auj6u6wr7aqjawuxurgue9w7wfnca50t8cr4l']
	];
	expected_rows integer;
	moved_rows integer;
	preparing_rows integer;
	colliding_rows integer;
	remaining_rows integer;
BEGIN
	-- (1) Serialize against a live writer. SHARE ROW EXCLUSIVE conflicts with the ROW EXCLUSIVE
	-- every INSERT/UPDATE takes, so no row can appear between the checks and the rewrite. The
	-- lock is transaction-scoped and is released by the migrator's COMMIT; it is bounded by the
	-- lock_timeout set above.
	LOCK TABLE "akash_tx_allocations" IN SHARE ROW EXCLUSIVE MODE;

	CREATE TEMP TABLE akash_tx_scope_backfill (
		legacy_scope text PRIMARY KEY,
		account_scope text NOT NULL
	) ON COMMIT DROP;

	INSERT INTO akash_tx_scope_backfill (legacy_scope, account_scope)
	SELECT 'akash-console:' || legacy_map[i][1], 'akash-console:' || legacy_map[i][2]
	FROM generate_subscripts(legacy_map, 1) AS i;

	-- (2) A writer mid-spend. Loud refusal, never a rewrite.
	SELECT count(*) INTO preparing_rows
	FROM "akash_tx_allocations" a
	JOIN akash_tx_scope_backfill m ON m.legacy_scope = a."wallet_scope"
	WHERE a."state" = 'preparing';

	IF preparing_rows > 0 THEN
		RAISE EXCEPTION
			'bug.5187 backfill refused: % akash_tx_allocations row(s) are state=''preparing'' under a legacy environment-keyed wallet_scope. A preparing row is an in-flight paid allocation; resolve it (recover or settle the lease through the actuator) before re-running this migration.',
			preparing_rows;
	END IF;

	-- The idempotence key is (wallet_scope, cogni_key). If the target scope already holds the
	-- same key, the rewrite would be a unique violation; name it instead of emitting a raw
	-- constraint error, because it means receipts for one key already exist under both forms.
	SELECT count(*) INTO colliding_rows
	FROM "akash_tx_allocations" a
	JOIN akash_tx_scope_backfill m ON m.legacy_scope = a."wallet_scope"
	JOIN "akash_tx_allocations" b
		ON b."wallet_scope" = m.account_scope AND b."cogni_key" = a."cogni_key";

	IF colliding_rows > 0 THEN
		RAISE EXCEPTION
			'bug.5187 backfill refused: % receipt(s) exist under BOTH the legacy and the account-keyed wallet_scope for the same cogni_key. Two scopes for one key means two ledgers on one account; resolve by hand.',
			colliding_rows;
	END IF;

	-- (3) Count before, rewrite, assert the counts agree.
	SELECT count(*) INTO expected_rows
	FROM "akash_tx_allocations" a
	JOIN akash_tx_scope_backfill m ON m.legacy_scope = a."wallet_scope";

	UPDATE "akash_tx_allocations" a
	SET "wallet_scope" = m.account_scope,
		"updated_at" = now()
	FROM akash_tx_scope_backfill m
	WHERE a."wallet_scope" = m.legacy_scope
		AND a."state" <> 'preparing';

	GET DIAGNOSTICS moved_rows = ROW_COUNT;

	IF moved_rows <> expected_rows THEN
		RAISE EXCEPTION
			'bug.5187 backfill refused: expected to move % row(s) but moved %. A partial rewrite must never commit.',
			expected_rows, moved_rows;
	END IF;

	SELECT count(*) INTO remaining_rows
	FROM "akash_tx_allocations" a
	JOIN akash_tx_scope_backfill m ON m.legacy_scope = a."wallet_scope";

	IF remaining_rows > 0 THEN
		RAISE EXCEPTION
			'bug.5187 backfill refused: % legacy-scoped row(s) survived the rewrite.',
			remaining_rows;
	END IF;

	RAISE NOTICE 'bug.5187 backfill: moved % akash_tx_allocations receipt(s) from environment-keyed to account-keyed wallet_scope', moved_rows;
END $$;--> statement-breakpoint
ALTER TABLE "akash_tx_allocations" ADD CONSTRAINT "akash_tx_allocations_wallet_scope_account_check" CHECK ("akash_tx_allocations"."wallet_scope" ~ '^akash-console:akash1[0-9a-z]{38}$');