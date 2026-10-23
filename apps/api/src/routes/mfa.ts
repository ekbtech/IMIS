import { randomUUID } from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db.js";
import { requireSession } from "../middleware/require-session.js";
import { decryptData, encryptData, isDataEncryptionConfigured } from "../security/data-encryption.js";
import { createTotpSecret, verifyTotpCode } from "../security/totp.js";

const codeSchema = z.object({ code: z.string().regex(/^\d{6}$/u) });

interface MfaRow extends RowDataPacket {
  secret_ciphertext: Buffer | null;
  pending_secret_ciphertext: Buffer | null;
  pending_expires_at: Date | null;
  confirmed_at: Date | null;
  last_verified_step: number | null;
}

export const mfaRouter = Router();

mfaRouter.use(rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "MFA_RATE_LIMITED", message: "Too many MFA attempts. Try again later." } },
}));
mfaRouter.use(requireSession);
mfaRouter.use((_req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  next();
});

mfaRouter.post("/enrollment/start", async (req, res, next) => {
  const principal = req.principal;
  if (!principal) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  if (req.get("origin") !== config.WEB_ORIGIN) {
    res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed." } });
    return;
  }
  if (!isDataEncryptionConfigured()) {
    res.status(503).json({ error: { code: "MFA_NOT_CONFIGURED", message: "Secure MFA key configuration is required." } });
    return;
  }

  try {
    const secret = createTotpSecret();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.execute<MfaRow[]>(
        "SELECT confirmed_at FROM user_mfa_credentials WHERE user_id = ? FOR UPDATE",
        [principal.userId],
      );
      if (rows[0]?.confirmed_at) {
        await connection.rollback();
        res.status(409).json({ error: { code: "MFA_ALREADY_ENABLED", message: "Multi-factor authentication is already enabled." } });
        return;
      }
      await connection.execute(
        `INSERT INTO user_mfa_credentials
          (user_id, pending_secret_ciphertext, pending_expires_at, created_at, updated_at)
         VALUES (?, ?, DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 10 MINUTE), UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
         ON DUPLICATE KEY UPDATE pending_secret_ciphertext = VALUES(pending_secret_ciphertext),
           pending_expires_at = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 10 MINUTE),
           updated_at = UTC_TIMESTAMP(6)`,
        [principal.userId, encryptData(secret)],
      );
      await connection.execute(
        `INSERT INTO audit_events
          (event_uuid, actor_user_id, action_code, resource_type, outcome, ip_address, occurred_at)
         VALUES (?, ?, 'security.mfa.enrollment.start', 'mfa_credential', 'changed', ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), principal.userId, req.ip ?? null],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    const issuer = "IMIS";
    const account = encodeURIComponent(`${issuer}:${principal.userId}`);
    const uri = `otpauth://totp/${account}?secret=${secret}&issuer=${issuer}&algorithm=SHA1&digits=6&period=30`;
    res.status(201).json({ secret, otpauthUri: uri, expiresInSeconds: 600 });
  } catch (error) {
    next(error);
  }
});

mfaRouter.post("/enrollment/verify", async (req, res, next) => {
  const principal = req.principal;
  if (!principal) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  if (req.get("origin") !== config.WEB_ORIGIN) {
    res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed." } });
    return;
  }
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Enter the six-digit authenticator code." } });
    return;
  }
  if (!isDataEncryptionConfigured()) {
    res.status(503).json({ error: { code: "MFA_NOT_CONFIGURED", message: "Secure MFA key configuration is required." } });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<MfaRow[]>(
      `SELECT secret_ciphertext, pending_secret_ciphertext, pending_expires_at, confirmed_at, last_verified_step
       FROM user_mfa_credentials WHERE user_id = ? FOR UPDATE`,
      [principal.userId],
    );
    const credential = rows[0];
    if (!credential?.pending_secret_ciphertext || !credential.pending_expires_at ||
        credential.pending_expires_at.getTime() <= Date.now() || credential.confirmed_at) {
      await connection.rollback();
      res.status(409).json({ error: { code: "MFA_ENROLLMENT_EXPIRED", message: "Start a new multi-factor enrollment." } });
      return;
    }

    const secret = decryptData(credential.pending_secret_ciphertext);
    const step = verifyTotpCode(secret, parsed.data.code, Date.now(), credential.last_verified_step ?? -1);
    if (step === null) {
      await connection.execute(
        `INSERT INTO audit_events
          (event_uuid, actor_user_id, action_code, resource_type, outcome, ip_address, occurred_at)
         VALUES (?, ?, 'security.mfa.enrollment.verify', 'mfa_credential', 'denied', ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), principal.userId, req.ip ?? null],
      );
      await connection.commit();
      res.status(401).json({ error: { code: "MFA_INVALID", message: "The code is invalid or expired." } });
      return;
    }

    await connection.execute(
      `UPDATE user_mfa_credentials
       SET secret_ciphertext = pending_secret_ciphertext, pending_secret_ciphertext = NULL,
           pending_expires_at = NULL, confirmed_at = UTC_TIMESTAMP(6),
           last_verified_step = ?, updated_at = UTC_TIMESTAMP(6)
       WHERE user_id = ?`,
      [step, principal.userId],
    );
    await connection.execute(
      "UPDATE sessions SET mfa_verified_at = UTC_TIMESTAMP(6) WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL",
      [principal.sessionId, principal.userId],
    );
    await connection.execute(
      `INSERT INTO audit_events
        (event_uuid, actor_user_id, action_code, resource_type, outcome, ip_address, occurred_at)
       VALUES (?, ?, 'security.mfa.enrollment.verify', 'mfa_credential', 'changed', ?, UTC_TIMESTAMP(6))`,
      [randomUUID(), principal.userId, req.ip ?? null],
    );
    await connection.commit();
    res.json({ enabled: true, message: "Multi-factor authentication is enabled for this account." });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});

mfaRouter.post("/verify", async (req, res, next) => {
  const principal = req.principal;
  if (!principal) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  if (req.get("origin") !== config.WEB_ORIGIN) {
    res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed." } });
    return;
  }
  const parsed = codeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Enter the six-digit authenticator code." } });
    return;
  }
  if (!isDataEncryptionConfigured()) {
    res.status(503).json({ error: { code: "MFA_NOT_CONFIGURED", message: "Secure MFA key configuration is required." } });
    return;
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute<MfaRow[]>(
      "SELECT secret_ciphertext, confirmed_at, last_verified_step FROM user_mfa_credentials WHERE user_id = ? FOR UPDATE",
      [principal.userId],
    );
    const credential = rows[0];
    if (!credential?.confirmed_at || !credential.secret_ciphertext) {
      await connection.rollback();
      res.status(409).json({ error: { code: "MFA_NOT_ENABLED", message: "Enroll multi-factor authentication first." } });
      return;
    }
    const secret = decryptData(credential.secret_ciphertext);
    const step = verifyTotpCode(secret, parsed.data.code, Date.now(), credential.last_verified_step ?? -1);
    if (step === null) {
      await connection.execute(
        `INSERT INTO audit_events
          (event_uuid, actor_user_id, action_code, resource_type, outcome, ip_address, occurred_at)
         VALUES (?, ?, 'security.mfa.verify', 'mfa_credential', 'denied', ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), principal.userId, req.ip ?? null],
      );
      await connection.commit();
      res.status(401).json({ error: { code: "MFA_INVALID", message: "The code is invalid, expired, or already used." } });
      return;
    }
    await connection.execute(
      `UPDATE user_mfa_credentials SET last_verified_step = ?, updated_at = UTC_TIMESTAMP(6) WHERE user_id = ?`,
      [step, principal.userId],
    );
    await connection.execute(
      "UPDATE sessions SET mfa_verified_at = UTC_TIMESTAMP(6) WHERE session_id = ? AND user_id = ? AND revoked_at IS NULL",
      [principal.sessionId, principal.userId],
    );
    await connection.execute(
      `INSERT INTO audit_events
        (event_uuid, actor_user_id, action_code, resource_type, outcome, ip_address, occurred_at)
       VALUES (?, ?, 'security.mfa.verify', 'mfa_credential', 'allowed', ?, UTC_TIMESTAMP(6))`,
      [randomUUID(), principal.userId, req.ip ?? null],
    );
    await connection.commit();
    res.json({ verified: true });
  } catch (error) {
    await connection.rollback();
    next(error);
  } finally {
    connection.release();
  }
});
