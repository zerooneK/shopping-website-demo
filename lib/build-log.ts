/**
 * Parser ของ docs/BUILD_LOG.md สำหรับหน้า /about (pure function — ไม่อ่านไฟล์เอง)
 *
 * รูปแบบหัวข้อ (CLAUDE.md): `## <วันที่> · ขั้น <x> · <agent> (<model> · <effort>)`
 * แล้วตามด้วย bullet `- <หัวข้อ>: <ข้อความ>` (bullet ยาวอาจต่อบรรทัดถัดไปแบบ indent)
 * ยอมรับรูปแบบที่หลวมกว่านั้นได้ เช่น agent ที่ไม่มีวงเล็บ หรือมีหลายวงเล็บ (หลาย agent ในขั้นเดียว)
 */

export type BuildLogBullet = {
  /** เช่น "งาน", "ผล", "ปัญหาที่เจอ / การ escalate" (null = bullet ไม่มีหัวข้อ) */
  label: string | null;
  text: string;
};

export type BuildLogEntry = {
  date: string;
  step: string;
  /** ข้อความ agent ทั้งหมดตามที่เขียนในหัวข้อ */
  agent: string;
  /** ชื่อ agent ก่อนวงเล็บ (ถ้ามีวงเล็บเดียว) */
  agentName: string;
  model: string | null;
  effort: string | null;
  bullets: BuildLogBullet[];
};

const HEADING = /^##\s+(\S+)\s+·\s+ขั้น\s+(.+?)\s+·\s+(.+?)\s*$/;
const BULLET = /^-\s+(.*)$/;
const LABELLED = /^([^:：]{1,40})[:：]\s*(.*)$/;

function splitAgent(rest: string): Pick<BuildLogEntry, "agentName" | "model" | "effort"> {
  const single = rest.match(/^([^()]+?)\s*\(([^()]*)\)\s*$/);
  if (!single) return { agentName: rest, model: null, effort: null };
  const [model, ...effortParts] = single[2].split("·").map((s) => s.trim());
  return {
    agentName: single[1].trim(),
    model: model || null,
    effort: effortParts.length ? effortParts.join(" · ") : null,
  };
}

export function parseBuildLog(markdown: string): BuildLogEntry[] {
  const entries: BuildLogEntry[] = [];
  let current: BuildLogEntry | null = null;
  let lastBullet: BuildLogBullet | null = null;

  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();

    const heading = line.match(HEADING);
    if (heading) {
      const [, date, step, rest] = heading;
      current = { date, step, agent: rest, ...splitAgent(rest), bullets: [] };
      entries.push(current);
      lastBullet = null;
      continue;
    }
    // หัวข้อ ## อื่นที่ไม่ตรงรูปแบบ: ปิด entry ปัจจุบัน (ไม่เอา bullet ของส่วนอื่นมาปน)
    if (line.startsWith("#")) {
      current = null;
      lastBullet = null;
      continue;
    }
    if (!current) continue;

    const bullet = line.match(BULLET);
    if (bullet) {
      const labelled = bullet[1].match(LABELLED);
      lastBullet = labelled
        ? { label: labelled[1].trim(), text: labelled[2].trim() }
        : { label: null, text: bullet[1].trim() };
      current.bullets.push(lastBullet);
      continue;
    }
    // บรรทัดต่อของ bullet เดิม
    if (line.trim() && lastBullet && /^\s+/.test(rawLine)) {
      lastBullet.text = `${lastBullet.text} ${line.trim()}`.trim();
    }
  }
  return entries;
}

/** แยกข้อความที่มี `โค้ด` เป็นชิ้นๆ เพื่อเรนเดอร์เป็น <code> (ไม่ใช้ dangerouslySetInnerHTML) */
export function splitInlineCode(text: string): { code: boolean; text: string }[] {
  return text
    .split(/(`[^`]+`)/g)
    .filter((s) => s.length > 0)
    .map((s) =>
      s.startsWith("`") && s.endsWith("`") && s.length > 2
        ? { code: true, text: s.slice(1, -1) }
        : { code: false, text: s },
    );
}
