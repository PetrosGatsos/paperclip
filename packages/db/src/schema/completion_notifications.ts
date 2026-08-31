import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type {
  CompletionNotificationDispatchState,
  CompletionNotificationErrorCategory,
  CompletionNotificationRecipientsSnapshot,
  CompletionNotificationStatus,
} from "@paperclipai/shared";
import { companies } from "./companies.js";
import { issues } from "./issues.js";

/**
 * One immutable delivery snapshot per eligible email-triggered parent request.
 * The row is a delivery ledger only. It never owns or changes implementation
 * execution state.
 */
export const completionNotifications = pgTable(
  "completion_notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    parentIssueId: uuid("parent_issue_id")
      .notNull()
      .references(() => issues.id, { onDelete: "cascade" }),
    parentRequestKey: text("parent_request_key").notNull(),
    status: text("status").$type<CompletionNotificationStatus>().notNull().default("pending"),
    dispatchState: text("dispatch_state")
      .$type<CompletionNotificationDispatchState>()
      .notNull()
      .default("not_started"),
    recipientsSnapshot: jsonb("recipients_snapshot")
      .$type<CompletionNotificationRecipientsSnapshot>()
      .notNull(),
    subjectSnapshot: text("subject_snapshot").notNull(),
    bodySnapshot: text("body_snapshot").notNull(),
    implementationReference: text("implementation_reference").notNull(),
    paperclipCorrelationId: text("paperclip_correlation_id").notNull(),
    // Graph /me/sendMail has no response body, so this remains null unless a
    // future provider really returns a message identifier.
    providerMessageId: text("provider_message_id"),
    providerRequestId: text("provider_request_id"),
    providerClientRequestId: text("provider_client_request_id"),
    errorCategory: text("error_category").$type<CompletionNotificationErrorCategory>(),
    errorMessage: text("error_message"),
    attemptCount: integer("attempt_count").notNull().default(0),
    nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
  },
  (table) => ({
    companyParentKeyUq: uniqueIndex("completion_notifications_company_parent_key_uq").on(
      table.companyId,
      table.parentRequestKey,
    ),
    companyCorrelationUq: uniqueIndex("completion_notifications_company_correlation_uq").on(
      table.companyId,
      table.paperclipCorrelationId,
    ),
    dueWorkIdx: index("completion_notifications_due_work_idx").on(
      table.companyId,
      table.status,
      table.nextAttemptAt,
      table.leaseExpiresAt,
    ),
    statusCheck: check(
      "completion_notifications_status_check",
      sql`${table.status} in ('pending', 'sending', 'sent', 'failed', 'operator_attention')`,
    ),
    dispatchStateCheck: check(
      "completion_notifications_dispatch_state_check",
      sql`${table.dispatchState} in ('not_started', 'started', 'accepted', 'ambiguous') and (
        (${table.status} = 'pending' and ${table.dispatchState} = 'not_started')
        or (${table.status} = 'sending' and ${table.dispatchState} in ('not_started', 'started'))
        or (${table.status} = 'failed' and ${table.dispatchState} = 'not_started')
        or (${table.status} = 'operator_attention' and ${table.dispatchState} = 'ambiguous')
        or (${table.status} = 'sent' and ${table.dispatchState} = 'accepted')
      )`,
    ),
    attemptsCheck: check(
      "completion_notifications_attempt_count_check",
      sql`${table.attemptCount} >= 0 and ${table.attemptCount} <= 5`,
    ),
    recipientsCheck: check(
      "completion_notifications_recipients_snapshot_check",
      sql`jsonb_typeof(${table.recipientsSnapshot}) = 'array' and jsonb_array_length(${table.recipientsSnapshot}) = 2`,
    ),
    leaseCheck: check(
      "completion_notifications_lease_check",
      sql`(
        ${table.status} = 'sending'
        and ${table.leaseOwner} is not null
        and ${table.leaseExpiresAt} is not null
      ) or (
        ${table.status} <> 'sending'
        and ${table.leaseOwner} is null
        and ${table.leaseExpiresAt} is null
      )`,
    ),
    sentCheck: check(
      "completion_notifications_sent_check",
      sql`(
        ${table.status} = 'sent'
        and ${table.dispatchState} = 'accepted'
        and ${table.sentAt} is not null
      ) or (
        ${table.status} <> 'sent'
        and ${table.sentAt} is null
      )`,
    ),
    attentionCheck: check(
      "completion_notifications_attention_check",
      sql`${table.status} <> 'operator_attention' or ${table.nextAttemptAt} is null`,
    ),
  }),
);
