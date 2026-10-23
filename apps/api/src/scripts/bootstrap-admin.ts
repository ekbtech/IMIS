import argon2 from "argon2";
import type { ResultSetHeader, RowDataPacket } from "mysql2";
import { createInterface } from "node:readline/promises";
import { pool } from "../db.js";

interface RoleRow extends RowDataPacket {
  role_id: number;
}

interface UserRow extends RowDataPacket {
  user_id: number;
}

async function readCredentials(): Promise<{ username: string; password: string }> {
  const interactive = process.stdin.isTTY && process.stdout.isTTY;
  let username: string;
  let password: string;

  if (interactive) {
    const terminal = createInterface({ input: process.stdin, output: process.stdout });
    try {
      username = (await terminal.question("Admin username: ")).trim();
    } finally {
      terminal.close();
    }

    password = await promptHidden("Admin password (minimum 6 characters): ");
    const confirmation = await promptHidden("Confirm admin password: ");
    if (password !== confirmation) {
      throw new Error("The passwords do not match.");
    }
  } else {
    username = process.env.BOOTSTRAP_ADMIN_USERNAME?.trim() ?? "";
    password = process.env.BOOTSTRAP_ADMIN_PASSWORD ?? "";
    if (!username || !password) {
      throw new Error("Run this command in an interactive terminal or set BOOTSTRAP_ADMIN_USERNAME and BOOTSTRAP_ADMIN_PASSWORD.");
    }
  }

  if (!username || username.length > 100 || !password || password.length < 6 || password.length > 1024) {
    throw new Error("Enter a username and a password between 6 and 1024 characters.");
  }
  return { username, password };
}

function promptHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    let value = "";

    const cleanup = () => {
      process.stdin.removeListener("data", onData);
      process.stdin.setRawMode(false);
      process.stdout.write("\n");
    };
    const onData = (chunk: Buffer) => {
      for (const character of chunk.toString("utf8")) {
        if (character === "\u0003") {
          cleanup();
          reject(new Error("Administrator setup cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          cleanup();
          resolve(value);
          return;
        }
        if (character === "\u007f" || character === "\b") {
          value = value.slice(0, -1);
        } else if (character >= " ") {
          value += character;
        }
      }
    };
    process.stdin.on("data", onData);
  });
}

const { username, password } = await readCredentials();
const connection = await pool.getConnection();
try {
  await connection.beginTransaction();
  const [roleRows] = await connection.execute<RoleRow[]>(
    "SELECT role_id FROM roles WHERE role_code = 'system_admin' AND status = 'active' LIMIT 1 FOR UPDATE",
  );
  const role = roleRows[0];
  if (!role) throw new Error("Migration must be applied before administrator bootstrap.");

  const [existing] = await connection.execute<UserRow[]>(
    `SELECT u.user_id FROM users u
     JOIN user_roles ur ON ur.user_id = u.user_id
     JOIN roles r ON r.role_id = ur.role_id
     WHERE r.role_code = 'system_admin' LIMIT 1 FOR UPDATE`,
  );
  if (existing.length > 0) {
    throw new Error("A system administrator already exists; bootstrap is one-time and will not reset credentials.");
  }

  const passwordHash = await argon2.hash(password, { type: argon2.argon2id });
  const [result] = await connection.execute(
    `INSERT INTO users (username, display_name, password_hash, status, created_at)
     VALUES (?, ?, ?, 'active', UTC_TIMESTAMP(6))`,
    [username, "System administrator", passwordHash],
  );
  const userId = (result as ResultSetHeader).insertId;
  await connection.execute("INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)", [userId, role.role_id]);
  await connection.execute(
    `INSERT INTO audit_events
      (event_uuid, actor_user_id, action_code, resource_type, resource_id, outcome, occurred_at)
     VALUES (UUID(), ?, 'auth.bootstrap', 'user', ?, 'changed', UTC_TIMESTAMP(6))`,
    [userId, String(userId)],
  );
  await connection.commit();
  console.info("Initial administrator account created. Remove bootstrap credentials from the environment if configured there.");
} catch (error) {
  await connection.rollback();
  throw error;
} finally {
  connection.release();
  await pool.end();
}
