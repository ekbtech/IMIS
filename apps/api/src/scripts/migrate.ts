import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RowDataPacket } from "mysql2";
import { pool } from "../db.js";

interface MigrationRow extends RowDataPacket {
  migration_name: string;
}

const migrationsDirectory = fileURLToPath(new URL("../../migrations/", import.meta.url));
const connection = await pool.getConnection();

try {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      migration_name VARCHAR(190) PRIMARY KEY,
      applied_at DATETIME(6) NOT NULL
    ) ENGINE=InnoDB
  `);

  const files = (await readdir(migrationsDirectory))
    .filter((name) => name.endsWith(".up.sql"))
    .sort();

  for (const filename of files) {
    const [rows] = await connection.execute<MigrationRow[]>(
      "SELECT migration_name FROM schema_migrations WHERE migration_name = ?",
      [filename],
    );
    if (rows.length > 0) continue;

    const sql = await readFile(join(migrationsDirectory, filename), "utf8");
    console.info(`Applying ${filename}`);
    for (const statement of sql.split(";").map((item) => item.trim()).filter(Boolean)) {
      await connection.query(statement);
    }
    await connection.execute(
      "INSERT INTO schema_migrations (migration_name, applied_at) VALUES (?, UTC_TIMESTAMP(6))",
      [filename],
    );
  }
} catch (error) {
  console.error("Migration failed. Inspect the database before retrying; MySQL DDL may have partially committed.", error);
  process.exitCode = 1;
} finally {
  connection.release();
  await pool.end();
}
