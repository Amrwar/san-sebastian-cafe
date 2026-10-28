import { spawn, spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";

/*
 * Runs the PostgreSQL client tools (pg_dump, pg_restore). Uses them from the PATH when installed;
 * otherwise from the official postgres image through Docker, so nothing has to be installed on
 * the machine. The image's major version must be at least the server's (Neon and local: 17).
 */

const IMAGE = "postgres:17-alpine";

export type PgTool = "pg_dump" | "pg_restore";

function onPath(tool: PgTool): boolean {
  return spawnSync(tool, ["--version"], { stdio: "ignore" }).status === 0;
}

function dockerAvailable(): boolean {
  return (
    spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], { stdio: "ignore" })
      .status === 0
  );
}

/** How the tool will run here, or null when neither the tool nor Docker is available. */
export function pgToolRunner(tool: PgTool): "local" | "docker" | null {
  if (onPath(tool)) return "local";
  if (dockerAvailable()) return "docker";
  return null;
}

/** Inside a container, "localhost" is the container: reach the host's database instead. */
function forDocker(url: string): string {
  const u = new URL(url);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") u.hostname = "host.docker.internal";
  return u.toString();
}

/** A connection string fit for logs: no password. */
export function redact(url: string): string {
  const u = new URL(url);
  if (u.password) u.password = "***";
  return u.toString();
}

function command(tool: PgTool, args: string[], url: string): [string, string[]] {
  const runner = pgToolRunner(tool);
  if (runner === "local") return [tool, [...args, url]];
  if (runner === "docker")
    return [
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--add-host=host.docker.internal:host-gateway",
        IMAGE,
        tool,
        ...args,
        forDocker(url),
      ],
    ];
  throw new Error(`${tool} is not installed and Docker is not running: install either one`);
}

function finished(child: ReturnType<typeof spawn>, tool: PgTool): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      // The tools never print the password in their messages.
      else reject(new Error(`${tool} exited with ${code}: ${stderr.trim().slice(0, 2000)}`));
    });
  });
}

/**
 * Writes a custom-format dump of `url` to `file` (compressed, restorable table by table). With a
 * `snapshot` (from pg_export_snapshot), the dump reads exactly that moment of the database.
 */
export async function pgDump(url: string, file: string, snapshot?: string): Promise<void> {
  const [cmd, args] = command(
    "pg_dump",
    [
      "--format=custom",
      "--no-owner",
      "--no-privileges",
      "--compress=6",
      ...(snapshot ? [`--snapshot=${snapshot}`] : []),
    ],
    url,
  );
  const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
  const out = createWriteStream(file);
  child.stdout.pipe(out);
  await Promise.all([
    finished(child, "pg_dump"),
    new Promise<void>((resolve, reject) => {
      out.on("finish", resolve);
      out.on("error", reject);
    }),
  ]);
}

/** Restores a custom-format dump into `url` (an empty database), stopping at the first error. */
export async function pgRestore(file: string, url: string): Promise<void> {
  const [cmd, args] = command(
    "pg_restore",
    ["--no-owner", "--no-privileges", "--exit-on-error", "--single-transaction", "--dbname"],
    url,
  );
  const child = spawn(cmd, args, { stdio: ["pipe", "ignore", "pipe"] });
  createReadStream(file).pipe(child.stdin);
  await finished(child, "pg_restore");
}
