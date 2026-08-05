ALTER TABLE "epoch_distribution_manifests" ALTER COLUMN "distribution_amount" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "epoch_distribution_manifests" ALTER COLUMN "total_allocated" SET DATA TYPE numeric;--> statement-breakpoint
ALTER TABLE "epoch_distribution_leaves" ALTER COLUMN "amount" SET DATA TYPE numeric;