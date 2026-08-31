CREATE TABLE "completion_notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"company_id" uuid NOT NULL,
	"parent_issue_id" uuid NOT NULL,
	"parent_request_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"dispatch_state" text DEFAULT 'not_started' NOT NULL,
	"recipients_snapshot" jsonb NOT NULL,
	"subject_snapshot" text NOT NULL,
	"body_snapshot" text NOT NULL,
	"implementation_reference" text NOT NULL,
	"paperclip_correlation_id" text NOT NULL,
	"provider_message_id" text,
	"provider_request_id" text,
	"provider_client_request_id" text,
	"error_category" text,
	"error_message" text,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"next_attempt_at" timestamp with time zone,
	"lease_owner" text,
	"lease_expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	CONSTRAINT "completion_notifications_status_check" CHECK ("completion_notifications"."status" in ('pending', 'sending', 'sent', 'failed', 'operator_attention')),
	CONSTRAINT "completion_notifications_dispatch_state_check" CHECK ("completion_notifications"."dispatch_state" in ('not_started', 'started', 'accepted', 'ambiguous') and (
        ("completion_notifications"."status" = 'pending' and "completion_notifications"."dispatch_state" = 'not_started')
        or ("completion_notifications"."status" = 'sending' and "completion_notifications"."dispatch_state" in ('not_started', 'started'))
        or ("completion_notifications"."status" = 'failed' and "completion_notifications"."dispatch_state" = 'not_started')
        or ("completion_notifications"."status" = 'operator_attention' and "completion_notifications"."dispatch_state" = 'ambiguous')
        or ("completion_notifications"."status" = 'sent' and "completion_notifications"."dispatch_state" = 'accepted')
      )),
	CONSTRAINT "completion_notifications_attempt_count_check" CHECK ("completion_notifications"."attempt_count" >= 0 and "completion_notifications"."attempt_count" <= 5),
	CONSTRAINT "completion_notifications_recipients_snapshot_check" CHECK (jsonb_typeof("completion_notifications"."recipients_snapshot") = 'array' and jsonb_array_length("completion_notifications"."recipients_snapshot") = 2),
	CONSTRAINT "completion_notifications_lease_check" CHECK ((
        "completion_notifications"."status" = 'sending'
        and "completion_notifications"."lease_owner" is not null
        and "completion_notifications"."lease_expires_at" is not null
      ) or (
        "completion_notifications"."status" <> 'sending'
        and "completion_notifications"."lease_owner" is null
        and "completion_notifications"."lease_expires_at" is null
      )),
	CONSTRAINT "completion_notifications_sent_check" CHECK ((
        "completion_notifications"."status" = 'sent'
        and "completion_notifications"."dispatch_state" = 'accepted'
        and "completion_notifications"."sent_at" is not null
      ) or (
        "completion_notifications"."status" <> 'sent'
        and "completion_notifications"."sent_at" is null
      )),
	CONSTRAINT "completion_notifications_attention_check" CHECK ("completion_notifications"."status" <> 'operator_attention' or "completion_notifications"."next_attempt_at" is null)
);
--> statement-breakpoint
ALTER TABLE "completion_notifications" ADD CONSTRAINT "completion_notifications_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "completion_notifications" ADD CONSTRAINT "completion_notifications_parent_company_fk" FOREIGN KEY ("company_id","parent_issue_id") REFERENCES "public"."issues"("company_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "completion_notifications_company_parent_key_uq" ON "completion_notifications" USING btree ("company_id","parent_request_key");--> statement-breakpoint
CREATE UNIQUE INDEX "completion_notifications_company_correlation_uq" ON "completion_notifications" USING btree ("company_id","paperclip_correlation_id");--> statement-breakpoint
CREATE INDEX "completion_notifications_due_work_idx" ON "completion_notifications" USING btree ("company_id","status","next_attempt_at","lease_expires_at");--> statement-breakpoint
CREATE OR REPLACE FUNCTION paperclip_validate_completion_notification_update()
RETURNS trigger AS $$
BEGIN
	IF NEW."company_id" IS DISTINCT FROM OLD."company_id"
		OR NEW."parent_issue_id" IS DISTINCT FROM OLD."parent_issue_id"
		OR NEW."parent_request_key" IS DISTINCT FROM OLD."parent_request_key"
		OR NEW."recipients_snapshot" IS DISTINCT FROM OLD."recipients_snapshot"
		OR NEW."subject_snapshot" IS DISTINCT FROM OLD."subject_snapshot"
		OR NEW."body_snapshot" IS DISTINCT FROM OLD."body_snapshot"
		OR NEW."implementation_reference" IS DISTINCT FROM OLD."implementation_reference"
		OR NEW."paperclip_correlation_id" IS DISTINCT FROM OLD."paperclip_correlation_id"
	THEN
		RAISE EXCEPTION 'completion notification identity and content snapshots are immutable'
			USING ERRCODE = '23514';
	END IF;

	IF NEW."attempt_count" < OLD."attempt_count" THEN
		RAISE EXCEPTION 'completion notification attempt count cannot decrease'
			USING ERRCODE = '23514';
	END IF;

	IF NOT (
		(OLD."status" = 'pending' AND NEW."status" IN ('pending', 'sending'))
		OR (OLD."status" = 'sending' AND NEW."status" IN ('sending', 'sent', 'failed', 'operator_attention'))
		OR (OLD."status" = 'failed' AND NEW."status" IN ('failed', 'sending'))
		OR (OLD."status" = 'operator_attention' AND NEW."status" IN ('operator_attention', 'sent'))
		OR (OLD."status" = 'sent' AND NEW."status" = 'sent')
	) THEN
		RAISE EXCEPTION 'invalid completion notification status transition: % -> %', OLD."status", NEW."status"
			USING ERRCODE = '23514';
	END IF;

	RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER paperclip_completion_notification_update_guard
BEFORE UPDATE ON "completion_notifications"
FOR EACH ROW EXECUTE FUNCTION paperclip_validate_completion_notification_update();
