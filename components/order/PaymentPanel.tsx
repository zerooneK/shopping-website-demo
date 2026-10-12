/* eslint-disable @next/next/no-img-element -- QR เป็น data URL ที่สร้างฝั่ง server ใช้ next/image ไม่ได้ */
import { formatPrice } from "@/lib/labels";
import { buildDemoQrDataUrl } from "@/lib/promptpay";
import { slipPrefix } from "@/lib/slip";
import { CancelOrderButton } from "./CancelOrderButton";
import { OrderCountdown } from "./OrderCountdown";
import { SlipUploader } from "./SlipUploader";

type Props = {
  token: string;
  orderId: string;
  amount: number;
  expiresAt: Date;
  dbNow: Date;
  blobEnabled: boolean;
  demoMode: boolean;
};

/**
 * ส่วนชำระเงิน (เฉพาะ pending_payment): QR PromptPay เดโม + ยอด + นับถอยหลัง + อัปสลิป + ยกเลิก
 * QR สร้างที่ server เท่านั้น (buildDemoQrDataUrl เข้ารหัสเลขปลายทาง 0000000000 ที่โอนจริงไม่ได้)
 * และมีลายน้ำ DEMO ทับ
 */
export async function PaymentPanel({
  token,
  orderId,
  amount,
  expiresAt,
  dbNow,
  blobEnabled,
  demoMode,
}: Props) {
  const qr = await buildDemoQrDataUrl(amount);

  return (
    <div className="space-y-8">
      <section aria-labelledby="pay-heading" className="border border-ink p-5">
        <h2 id="pay-heading" className="meta meta-th text-ink">
          สแกนเพื่อชำระเงิน (เดโม)
        </h2>

        <div className="mt-4 grid items-center gap-6 sm:grid-cols-2">
          <div className="relative mx-auto w-full max-w-[16rem] bg-white p-2">
            <img
              src={qr}
              alt="QR PromptPay ตัวอย่างสำหรับเดโม ใช้ชำระเงินจริงไม่ได้"
              width={320}
              height={320}
              className="block h-auto w-full"
            />
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 flex items-center justify-center"
            >
              <span className="display -rotate-12 border-4 border-accent bg-white/60 px-3 text-6xl tracking-widest text-accent">
                DEMO
              </span>
            </div>
          </div>

          <div>
            <p className="meta meta-th">ยอดที่ต้องชำระ</p>
            <p className="display text-hero leading-none" data-testid="order-amount">
              {formatPrice(amount)}
            </p>
            <p className="meta meta-th mt-4">เหลือเวลา</p>
            <p className="display text-5xl leading-tight">
              <OrderCountdown expiresAt={expiresAt.toISOString()} serverNow={dbNow.toISOString()} />
            </p>
          </div>
        </div>

        <p
          role="note"
          className="mt-5 border-t border-rule pt-4 text-sm leading-7 text-ink"
        >
          นี่คือ QR ตัวอย่างของร้านเดโม <strong>สแกนจ่ายจริงไม่ได้</strong> และไม่มีการเรียกเก็บเงินจริงใดๆ
          {demoMode ? " ให้กด “ใช้สลิปตัวอย่าง” เพื่อลองขั้นตอนถัดไป" : null}
        </p>
      </section>

      <SlipUploader
        token={token}
        pathPrefix={slipPrefix(orderId)}
        blobEnabled={blobEnabled}
        demoMode={demoMode}
      />

      <div className="border-t border-rule pt-4">
        <CancelOrderButton token={token} />
      </div>
    </div>
  );
}
