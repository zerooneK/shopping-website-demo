/**
 * จำกัดการลองรหัสผ่าน owner (SPEC §9) — นับเฉพาะ "ลองผิด" ต่อคีย์ (ค่า normalize ของ IP)
 *
 * เกินกำหนดภายในช่วงเวลา → ล็อกคีย์นั้นชั่วคราว; ล็อกอินสำเร็จ → ล้างตัวนับของคีย์นั้น
 *
 * ข้อจำกัด (ต้องรู้): เก็บในหน่วยความจำของ instance เดียว ไม่แชร์ข้าม serverless instance และหายเมื่อ cold start
 * จึงเป็นการชะลอการเดารหัสแบบ best-effort ไม่ใช่ตัวป้องกันเดียว — ความแข็งแรงหลักมาจาก ADMIN_PASSWORD ที่ยาวและสุ่ม
 * (ไม่ใช้ตัวนับรวมทั้งระบบเพื่อ "ล็อก" เพราะผู้โจมตีจะล็อกเจ้าของร้านออกจากระบบได้ — บทเรียนจากเพดานรวมใน 3b-2)
 *
 * เพดานรวมแบบ "ชะลอ" (global backoff): ล้มเหลวรวมทุก IP เกิน freeFailures ภายในช่วงเวลา → ทุกความพยายามล็อกอิน
 * (รวมของเจ้าของร้านที่พิมพ์ถูก) ต้องรอ delay ก่อนตรวจรหัส โดย delay โตแบบ exponential แต่ `maxDelayMs` เป็นเพดานตายตัว
 * และ "ไม่เคยปฏิเสธ" คำขอเพราะตัวนับรวม จึงล็อกเจ้าของร้านถาวรไม่ได้ (รอไม่เกิน maxDelayMs ต่อครั้ง)
 * ข้อจำกัด: ชะลอต่อคำขอ ไม่จำกัดจำนวนคำขอที่ยิงขนานกัน (ไม่ทำคิวรวม เพราะคิวที่ยาวจะกลายเป็นการล็อกเจ้าของร้าน)
 */

export type LoginLimiterOptions = {
  maxFailures: number;
  windowMs: number;
  lockMs: number;
  /** จำนวนคีย์สูงสุดที่จำไว้ (กันหน่วยความจำบวมจากการสุ่ม IP) */
  maxKeys?: number;
  /** ชะลอรวมทั้งระบบ (ไม่ใส่ = ปิด) */
  globalBackoff?: GlobalBackoffOptions;
};

export type GlobalBackoffOptions = {
  /** ล้มเหลวรวมกี่ครั้งในช่วงเวลาก่อนเริ่มชะลอ */
  freeFailures: number;
  windowMs: number;
  /** delay ขั้นแรก; ทุกๆ `stepFailures` ครั้งที่ล้มเหลวเกิน freeFailures delay คูณสอง */
  baseDelayMs: number;
  stepFailures: number;
  /** เพดานของ delay ต่อหนึ่งความพยายาม (ตายตัว — เจ้าของร้านรอไม่เกินนี้) */
  maxDelayMs: number;
};

export type LoginCheck = { allowed: true } | { allowed: false; retryAfterSeconds: number };

type Entry = { failures: number[]; lockedUntil: number };

export function createLoginLimiter(opts: LoginLimiterOptions, now: () => number = Date.now) {
  const entries = new Map<string, Entry>();
  const maxKeys = opts.maxKeys ?? 5000;
  /** เวลาล้มเหลวทุก key รวมกัน (จำกัดความยาว กันหน่วยความจำบวม) */
  let globalFailures: number[] = [];
  const GLOBAL_MAX_TRACKED = 2000;

  function prune(t: number) {
    if (entries.size <= maxKeys) return;
    for (const [k, e] of entries) {
      if (e.lockedUntil <= t && e.failures.every((f) => f <= t - opts.windowMs)) entries.delete(k);
      if (entries.size <= maxKeys) break;
    }
  }

  return {
    check(key: string): LoginCheck {
      const t = now();
      const e = entries.get(key);
      if (e && e.lockedUntil > t) {
        return { allowed: false, retryAfterSeconds: Math.ceil((e.lockedUntil - t) / 1000) };
      }
      return { allowed: true };
    },
    recordFailure(key: string): void {
      const t = now();
      const e = entries.get(key) ?? { failures: [], lockedUntil: 0 };
      e.failures = e.failures.filter((f) => f > t - opts.windowMs);
      e.failures.push(t);
      if (e.failures.length >= opts.maxFailures) {
        e.lockedUntil = t + opts.lockMs;
        e.failures = [];
      }
      entries.set(key, e);
      prune(t);

      if (opts.globalBackoff) {
        globalFailures = globalFailures.filter((f) => f > t - opts.globalBackoff!.windowMs);
        globalFailures.push(t);
        if (globalFailures.length > GLOBAL_MAX_TRACKED) globalFailures.splice(0, globalFailures.length - GLOBAL_MAX_TRACKED);
      }
    },
    /**
     * ต้องรอกี่ ms ก่อนตรวจรหัสครั้งนี้ (0 = ไม่ต้องรอ) — ขึ้นกับจำนวนล้มเหลวรวมทุก IP ในช่วงเวลา
     * ไม่ใช่การปฏิเสธ: คืนค่าไม่เกิน maxDelayMs เสมอ
     */
    globalDelayMs(): number {
      const g = opts.globalBackoff;
      if (!g) return 0;
      const t = now();
      const n = globalFailures.filter((f) => f > t - g.windowMs).length;
      if (n <= g.freeFailures) return 0;
      const steps = Math.floor((n - g.freeFailures - 1) / g.stepFailures);
      return Math.min(g.maxDelayMs, g.baseDelayMs * 2 ** Math.min(steps, 20));
    },
    reset(key: string): void {
      entries.delete(key);
    },
    /** ล้างทุกอย่างรวมตัวนับรวม (ใช้ในเทสต์) */
    resetAll(): void {
      entries.clear();
      globalFailures = [];
    },
    size: () => entries.size,
  };
}

/**
 * ค่าที่ใช้จริง:
 *  - ต่อ IP: ผิด 5 ครั้งใน 15 นาที → ล็อก IP นั้น 15 นาที
 *  - รวมทุก IP: ผิดเกิน 10 ครั้งใน 15 นาที → ทุกความพยายามรอ 0.5s, 1s, 2s, 4s แล้วคงที่ที่ 5s (ไม่ล็อก)
 */
export const LOGIN_LIMIT: LoginLimiterOptions = {
  maxFailures: 5,
  windowMs: 15 * 60_000,
  lockMs: 15 * 60_000,
  globalBackoff: { freeFailures: 10, windowMs: 15 * 60_000, baseDelayMs: 500, stepFailures: 5, maxDelayMs: 5000 },
};

const globalForLimiter = globalThis as unknown as { __adminLoginLimiter?: ReturnType<typeof createLoginLimiter> };
export const loginLimiter = (globalForLimiter.__adminLoginLimiter ??= createLoginLimiter(LOGIN_LIMIT));
