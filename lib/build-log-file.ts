import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { cacheLife } from "next/cache";
import { parseBuildLog, type BuildLogEntry } from "./build-log";

/**
 * อ่าน docs/BUILD_LOG.md ตอน build แล้ว cache ไว้ในผลลัพธ์ของหน้า (static shell)
 *
 * Vercel: ไฟล์นี้ไม่ได้ถูก import จึงต้อง trace เอง — next.config.ts ตั้ง
 * outputFileTracingIncludes["/about"] = ["./docs/BUILD_LOG.md"] (ตรวจแล้วด้วย next build + next start)
 * ถ้าอ่านไม่ได้ (เช่นไฟล์หาย) คืนรายการว่างแทนการทำให้หน้าพัง
 */
export async function getBuildLog(): Promise<BuildLogEntry[]> {
  "use cache";
  cacheLife({ stale: 3600, revalidate: 60 * 60 * 24 * 30, expire: 60 * 60 * 24 * 365 });

  try {
    const file = path.join(process.cwd(), "docs", "BUILD_LOG.md");
    return parseBuildLog(await readFile(file, "utf8"));
  } catch {
    return [];
  }
}
