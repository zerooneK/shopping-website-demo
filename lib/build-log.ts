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

/**
 * ตัวเลขสรุปที่ "นับได้จริง" จากหัวข้อรายการใน BUILD_LOG (ใช้ในหน้า /about) — ไม่มีการประมาณ ไม่มีเงิน/เวลา
 * เพราะ BUILD_LOG ไม่ได้บันทึกต้นทุนโทเค็น ค่าใช้จ่าย หรือชั่วโมงทำงานไว้
 *
 * ข้อจำกัดที่ต้องบอกผู้อ่าน: นับเฉพาะสิ่งที่ปรากฏ "ในหัวข้อรายการ" (agent/โมเดล/effort/ชื่อขั้น) —
 * รอบรีวิวที่เล่าไว้เฉพาะในเนื้อของรายการอื่นไม่ถูกนับ ตัวเลขจึงเป็นค่าขั้นต่ำ
 */
export type BuildLogSummary = {
  /** จำนวนรายการในบันทึก */
  entryCount: number;
  /** จำนวนขั้นตาม SPEC §11 (2, 3a, 3b, 3c, 4, 5 — ขั้นย่อย 3b-1, 4b, 5-fix ฯลฯ นับรวมในขั้นแม่) */
  stageCount: number;
  firstDate: string | null;
  lastDate: string | null;
  /** จำนวนวันที่ต่างกันที่มีบันทึก (ไม่ใช่จำนวนชั่วโมง) */
  daysWithEntries: number;
  /** รายการแก้ไขหลังรีวิว (ชื่อขั้นลงท้าย -fix, -fix2 ฯลฯ) */
  fixEntryCount: number;
  /** รายการที่ Reviewer เป็นผู้ทำในหัวข้อ */
  reviewerEntryCount: number;
  /** จำนวนรอบรีวิวที่นับจาก effort ต่อรอบในหัวข้อ เช่น "medium → low → low" = 3 รอบ */
  reviewerRounds: number;
  /** รายการที่ effort ถูกขยับขึ้นเป็น high/xhigh ตามกฎของทีม */
  effortRaisedCount: number;
  /** รายการที่ส่งงานของ Builder ให้ Opus แทน (กฎข้อ 3) */
  opusBuilderCount: number;
};

/** รหัสขั้นตาม SPEC §11: "3b-2-fix2" → "3b", "4b" → "4", "5-fix (…)" → "5" */
export function stageKey(step: string): string | null {
  const m = step.trim().match(/^(3[a-z]|\d+)/i);
  return m ? m[1].toLowerCase() : null;
}

export function summarizeBuildLog(entries: BuildLogEntry[]): BuildLogSummary {
  const stages = new Set<string>();
  const days = new Set<string>();
  let fix = 0;
  let reviewerEntries = 0;
  let reviewerRounds = 0;
  let raised = 0;
  let opusBuilder = 0;

  for (const e of entries) {
    const key = stageKey(e.step);
    if (key) stages.add(key);
    days.add(e.date);
    if (/-fix\d*(\s|$)/i.test(e.step)) fix++;
    if (/reviewer/i.test(e.agent)) {
      reviewerEntries++;
      // วงเล็บของ reviewer: "(opus · medium → low → low)" → จำนวนรอบ = จำนวนค่า effort ที่คั่นด้วย →
      const paren = e.agent.match(/reviewer[^()]*\(([^()]*)\)/i);
      const effortPart = paren?.[1].split("·")[1];
      reviewerRounds += effortPart ? effortPart.split("→").filter((s) => s.trim()).length : 1;
    }
    if (/·\s*(?:[a-z]+\s*→\s*)*x?high\b/i.test(e.agent)) raised++;
    if (/shop-builder\s*\(\s*opus/i.test(e.agent)) opusBuilder++;
  }

  const sorted = [...days].sort();
  return {
    entryCount: entries.length,
    stageCount: stages.size,
    firstDate: sorted[0] ?? null,
    lastDate: sorted[sorted.length - 1] ?? null,
    daysWithEntries: days.size,
    fixEntryCount: fix,
    reviewerEntryCount: reviewerEntries,
    reviewerRounds,
    effortRaisedCount: raised,
    opusBuilderCount: opusBuilder,
  };
}
