import dotenv from 'dotenv';

dotenv.config();

function int(name: string, fallback: number): number {
  const value = parseInt(process.env[name] || '', 10);
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Install-level settings. Everything a shop owner configures at runtime
 * (BoxAPI key, page, alerts) lives in the database, not here.
 */
export const config = {
  port: int('PORT', 3000),
  /** Public HTTPS address of this install, used to show the webhook URL. */
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  databasePath: process.env.DATABASE_PATH || './data/direp.db',
  boxApiBaseUrl: (process.env.BOXAPI_BASE_URL || 'https://api.sendbox.chat/api/v1').replace(/\/$/, ''),
  /** Log outbound Instagram calls instead of sending them. */
  dryRun: process.env.BOXAPI_DRY_RUN === 'true',
  recovery: {
    step1DelayMinutes: int('RECOVERY_STEP1_DELAY_MINUTES', 120),
    step2DelayMinutes: int('RECOVERY_STEP2_DELAY_MINUTES', 1200),
    /** Meta only allows business-initiated DMs inside 24h of the customer's last message. */
    windowHours: 24,
  },
  /** How long to wait for BoxAPI's async follow-status result before giving up. */
  followCheckTimeoutSeconds: int('FOLLOW_CHECK_TIMEOUT_SECONDS', 120),
  schedulerIntervalSeconds: int('SCHEDULER_INTERVAL_SECONDS', 30),
};
