import { randomBytes, randomUUID } from "node:crypto";
import argon2 from "argon2";
import { Router } from "express";
import { rateLimit } from "express-rate-limit";
import type { RowDataPacket } from "mysql2";
import { z } from "zod";
import { config } from "../config.js";
import { pool } from "../db.js";
import { requireSession } from "../middleware/require-session.js";
import { createSessionToken, hashSessionToken, SESSION_COOKIE_NAME } from "../security/session.js";
import { decryptData } from "../security/data-encryption.js";
import { verifyTotpCode } from "../security/totp.js";
import { writeAuditEvent } from "../security/audit.js";

const loginSchema = z.object({
  username: z.string().trim().min(1).max(100),
  password: z.string().min(1).max(1024),
  otp: z.string().regex(/^\d{6}$/u).optional(),
});
const passwordChangeSchema = z.object({
  currentPassword: z.string().min(1, "Enter the temporary password.").max(1024),
  newPassword: z.string()
    .min(6, "Use at least 6 characters for the new password.")
    .max(1024, "The new password is too long."),
}).refine((value) => value.currentPassword !== value.newPassword, {
  message: "The new password must be different from the temporary password.",
  path: ["newPassword"],
});
const dummyPasswordHash = argon2.hash(randomBytes(32).toString("hex"), { type: argon2.argon2id });

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: { code: "LOGIN_RATE_LIMITED", message: "Too many sign-in attempts. Try again later." } },
});

interface UserRow extends RowDataPacket {
  user_id: number;
  username: string;
  display_name: string;
  password_hash: string;
  status: string;
  mfa_required: number;
}

interface MfaCredentialRow extends RowDataPacket {
  secret_ciphertext: Buffer | null;
  confirmed_at: Date | null;
  last_verified_step: number | null;
}

interface UserDisplayRow extends RowDataPacket {
  username: string;
  display_name: string;
  must_change_password: number;
}

export const authRouter = Router();

authRouter.post("/login", loginLimiter, async (req, res, next) => {
  try {
    if (req.get("origin") !== config.WEB_ORIGIN) {
      res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed." } });
      return;
    }

    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: { code: "INVALID_REQUEST", message: "Enter a username and password." } });
      return;
    }

    const [users] = await pool.execute<UserRow[]>(
      `SELECT u.user_id, u.username, u.display_name, u.password_hash, u.status,
              COALESCE(MAX(r.mfa_required), 0) AS mfa_required
       FROM users u
       LEFT JOIN user_roles ur ON ur.user_id = u.user_id
       LEFT JOIN roles r ON r.role_id = ur.role_id AND r.status = 'active'
       WHERE u.username = ?
       GROUP BY u.user_id, u.username, u.display_name, u.password_hash, u.status
       LIMIT 1`,
      [parsed.data.username],
    );
    const user = users[0];
    const passwordHash = user?.password_hash ?? await dummyPasswordHash;
    const passwordValid = await argon2.verify(passwordHash, parsed.data.password);

    if (!user || user.status !== "active" || !passwordValid) {
      await pool.execute(
        `INSERT INTO audit_events
          (event_uuid, actor_user_id, action_code, resource_type, outcome, ip_address, user_agent, occurred_at)
         VALUES (?, NULL, 'auth.login', 'session', 'denied', ?, ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), req.ip ?? null, req.get("user-agent")?.slice(0, 255) ?? null],
      );
      res.status(401).json({ error: { code: "INVALID_CREDENTIALS", message: "The username or password is incorrect." } });
      return;
    }

    const token = createSessionToken();
    const absoluteExpiry = new Date(Date.now() + config.SESSION_ABSOLUTE_HOURS * 60 * 60 * 1000);
    const idleExpiry = new Date(Math.min(
      Date.now() + config.SESSION_IDLE_MINUTES * 60 * 1000,
      absoluteExpiry.getTime(),
    ));

    const connection = await pool.getConnection();
    let mfaVerified = false;
    try {
      await connection.beginTransaction();
      const [credentials] = await connection.execute<MfaCredentialRow[]>(
        `SELECT secret_ciphertext, confirmed_at, last_verified_step
         FROM user_mfa_credentials WHERE user_id = ? LIMIT 1 FOR UPDATE`,
        [user.user_id],
      );
      const credential = credentials[0];
      if (credential?.confirmed_at && credential.secret_ciphertext) {
        const secret = decryptData(credential.secret_ciphertext);
        const acceptedStep = parsed.data.otp
          ? verifyTotpCode(secret, parsed.data.otp, Date.now(), credential.last_verified_step ?? -1)
          : null;
        if (acceptedStep === null) {
          await connection.rollback();
          await pool.execute(
            `INSERT INTO audit_events
              (event_uuid, actor_user_id, action_code, resource_type, outcome, ip_address, user_agent, occurred_at)
             VALUES (?, ?, 'auth.login.mfa', 'session', 'denied', ?, ?, UTC_TIMESTAMP(6))`,
            [randomUUID(), user.user_id, req.ip ?? null, req.get("user-agent")?.slice(0, 255) ?? null],
          );
          res.status(401).json({
            error: { code: "MFA_INVALID", message: "The multi-factor code is invalid, expired, or already used." },
          });
          return;
        }
        await connection.execute(
          `UPDATE user_mfa_credentials SET last_verified_step = ?, updated_at = UTC_TIMESTAMP(6)
           WHERE user_id = ?`,
          [acceptedStep, user.user_id],
        );
        mfaVerified = true;
      } else if (user.mfa_required) {
        await connection.execute(
          `INSERT INTO user_mfa_credentials (user_id, created_at, updated_at)
           VALUES (?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6))
           ON DUPLICATE KEY UPDATE updated_at = UTC_TIMESTAMP(6)`,
          [user.user_id],
        );
      }
      await connection.execute(
        `INSERT INTO sessions
          (user_id, token_hash, created_at, last_seen_at, idle_expires_at, absolute_expires_at, mfa_verified_at)
         VALUES (?, ?, UTC_TIMESTAMP(6), UTC_TIMESTAMP(6), ?, ?, ?)`,
        [user.user_id, hashSessionToken(token), idleExpiry, absoluteExpiry, mfaVerified ? new Date() : null],
      );
      await connection.execute(
        `INSERT INTO audit_events
          (event_uuid, actor_user_id, action_code, resource_type, resource_id, outcome, ip_address, user_agent, occurred_at)
         VALUES (?, ?, 'auth.login', 'session', NULL, 'allowed', ?, ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), user.user_id, req.ip ?? null, req.get("user-agent")?.slice(0, 255) ?? null],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

    res.cookie(SESSION_COOKIE_NAME, token, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      path: "/",
      expires: absoluteExpiry,
    });
    res.status(200).json({
      user: { id: user.user_id, username: user.username, displayName: user.display_name, mfaRequired: Boolean(user.mfa_required) },
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/change-password", requireSession, async (req, res, next) => {
  const principal = req.principal;
  if (!principal) {
    res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
    return;
  }
  if (req.get("origin") !== config.WEB_ORIGIN) {
    res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed." } });
    return;
  }
  const parsed = passwordChangeSchema.safeParse(req.body);
  if (!parsed.success) {
    const fieldErrors = parsed.error.issues.map((issue) => ({
      field: issue.path[0] === "currentPassword" ? "temporary password" :
        issue.path[0] === "newPassword" ? "new password" : "request",
      message: issue.message,
    }));
    res.status(400).json({
      error: {
        code: "INVALID_REQUEST",
        message: fieldErrors.map((issue) => `${issue.field}: ${issue.message}`).join(" "),
        fields: fieldErrors,
      },
    });
    return;
  }

  try {
    const [users] = await pool.execute<(UserRow & { must_change_password: number })[]>(
      "SELECT user_id, username, display_name, password_hash, status, must_change_password FROM users WHERE user_id = ? LIMIT 1",
      [principal.userId],
    );
    const user = users[0];
    if (!user || !await argon2.verify(user.password_hash, parsed.data.currentPassword)) {
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "auth.password.change",
        resourceType: "user",
        resourceId: String(principal.userId),
        outcome: "denied",
        ipAddress: req.ip,
      });
      res.status(401).json({ error: { code: "CURRENT_PASSWORD_INVALID", message: "The current password is incorrect." } });
      return;
    }

    const newHash = await argon2.hash(parsed.data.newPassword, { type: argon2.argon2id });
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        "UPDATE users SET password_hash = ?, must_change_password = FALSE WHERE user_id = ?",
        [newHash, principal.userId],
      );
      await connection.execute(
        "UPDATE sessions SET revoked_at = UTC_TIMESTAMP(6) WHERE user_id = ? AND session_id <> ? AND revoked_at IS NULL",
        [principal.userId, principal.sessionId],
      );
      await writeAuditEvent({
        actorUserId: principal.userId,
        action: "auth.password.change",
        resourceType: "user",
        resourceId: String(principal.userId),
        outcome: "changed",
        ipAddress: req.ip,
      }, connection);
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    res.json({ changed: true, mfaRequired: principal.mfaRequired, mfaEnrolled: principal.mfaEnrolled });
  } catch (error) {
    next(error);
  }
});

authRouter.get("/me", requireSession, async (req, res, next) => {
  try {
    const principal = req.principal;
    if (!principal) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
      return;
    }
    const [rows] = await pool.execute<UserDisplayRow[]>(
      "SELECT username, display_name, must_change_password FROM users WHERE user_id = ?",
      [principal.userId],
    );
    const user = rows[0];
    if (!user) {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
      return;
    }
    res.json({
      user: {
        id: principal.userId,
        username: user.username,
        displayName: user.display_name,
        permissions: [...principal.permissions],
        mfaRequired: principal.mfaRequired,
        mfaVerified: principal.mfaVerified,
        mfaEnrolled: principal.mfaEnrolled,
        mustChangePassword: Boolean(user.must_change_password),
      },
    });
  } catch (error) {
    next(error);
  }
});

authRouter.post("/logout", requireSession, async (req, res, next) => {
  try {
    if (req.get("origin") !== config.WEB_ORIGIN) {
      res.status(403).json({ error: { code: "ORIGIN_NOT_ALLOWED", message: "Request origin is not allowed." } });
      return;
    }
    const principal = req.principal;
    const token = req.cookies?.[SESSION_COOKIE_NAME];
    if (!principal || typeof token !== "string") {
      res.status(401).json({ error: { code: "UNAUTHENTICATED", message: "Sign in is required." } });
      return;
    }
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      await connection.execute(
        "UPDATE sessions SET revoked_at = UTC_TIMESTAMP(6) WHERE token_hash = ? AND revoked_at IS NULL",
        [hashSessionToken(token)],
      );
      await connection.execute(
        `INSERT INTO audit_events
          (event_uuid, actor_user_id, action_code, resource_type, outcome, ip_address, occurred_at)
         VALUES (?, ?, 'auth.logout', 'session', 'allowed', ?, UTC_TIMESTAMP(6))`,
        [randomUUID(), principal.userId, req.ip ?? null],
      );
      await connection.commit();
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
    res.clearCookie(SESSION_COOKIE_NAME, {
      httpOnly: true,
      secure: config.cookieSecure,
      sameSite: "strict",
      path: "/",
    });
    res.status(204).end();
  } catch (error) {
    next(error);
  }
});
