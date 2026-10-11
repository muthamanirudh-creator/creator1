-- Phase 4 hardening: honest delivery states, retry scheduling and worker leases.
ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_status_check;
ALTER TABLE notification_deliveries ADD CONSTRAINT notification_deliveries_status_check
  CHECK (status IN ('QUEUED','SENDING','SENT','FAILED','SKIPPED'));
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS locked_at TIMESTAMPTZ;
-- Deliveries that earlier builds marked SENT with a synthetic "dev-" id were never actually sent.
UPDATE notification_deliveries SET status='SKIPPED', last_error='legacy: no provider was configured; nothing was sent'
  WHERE status='SENT' AND provider_message_id LIKE 'dev-%' AND channel IN ('EMAIL','PUSH');
CREATE INDEX IF NOT EXISTS notification_deliveries_due_idx ON notification_deliveries(status,next_attempt_at);
