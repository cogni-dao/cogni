CREATE TABLE "user_profiles" (
	"user_id" text PRIMARY KEY NOT NULL,
	"display_name" text,
	"avatar_color" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_profiles_display_name_length" CHECK (char_length("user_profiles"."display_name") <= 50),
	CONSTRAINT "user_profiles_avatar_color_hex" CHECK ("user_profiles"."avatar_color" ~ '^#[0-9a-fA-F]{6}$')
);
--> statement-breakpoint
ALTER TABLE "user_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "identity_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_bindings" ADD COLUMN "provider_login" text;--> statement-breakpoint
ALTER TABLE "user_profiles" ADD CONSTRAINT "user_profiles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
