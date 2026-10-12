"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState, type FormEvent } from "react";
import { formatPrice } from "@/lib/labels";
import { calcAmount, calcShippingFee, type CreateOrderInput } from "@/lib/validation";

type Method = CreateOrderInput["deliveryMethod"];
type FieldName = "customerName" | "phone" | "address" | "note";
type FieldErrors = Partial<Record<FieldName, string>>;

type Props = {
  code: string;
  price: number;
  demoMode: boolean;
};

const SAMPLE = {
  customerName: "ตัวอย่าง ทดสอบ",
  phone: "0812345678",
  address: "99/9 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพฯ 10000",
  note: "ข้อมูลตัวอย่างสำหรับเดโมเท่านั้น",
};

const FIELD_BASE =
  "tap w-full border border-rule bg-transparent px-3 py-2 text-base text-ink placeholder:text-muted focus:border-ink focus:outline-none";

export function CheckoutForm({ code, price, demoMode }: Props) {
  const router = useRouter();
  const uid = useId();
  const [customerName, setCustomerName] = useState("");
  const [phone, setPhone] = useState("");
  const [method, setMethod] = useState<Method>("pickup");
  const [address, setAddress] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [pending, setPending] = useState(false);

  // แสดงยอดให้ดูเฉยๆ — ราคาจริงคิดที่เซิร์ฟเวอร์จากราคาในฐานข้อมูล
  const shipping = calcShippingFee(method);
  const total = calcAmount(price, method);

  function fillSample() {
    setCustomerName(SAMPLE.customerName);
    setPhone(SAMPLE.phone);
    setAddress(SAMPLE.address);
    setNote(SAMPLE.note);
    setErrors({});
    setFormError(null);
  }

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    setPending(true);
    setErrors({});
    setFormError(null);
    setConflict(false);
    try {
      // ไม่ส่งราคา/ยอดรวมไปด้วย — server คำนวณเอง
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code,
          customerName,
          phone,
          deliveryMethod: method,
          address: method === "post" ? address : undefined,
          note: note.trim() ? note : undefined,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as {
        error?: string;
        fieldErrors?: Partial<Record<FieldName, string[]>>;
        redirectTo?: string;
      };

      if (res.status === 201 && data.redirectTo) {
        router.push(data.redirectTo);
        return;
      }
      if (res.status === 400 && data.fieldErrors) {
        const next: FieldErrors = {};
        for (const key of ["customerName", "phone", "address", "note"] as const) {
          const msg = data.fieldErrors[key]?.[0];
          if (msg) next[key] = msg;
        }
        setErrors(next);
        setFormError(data.error ?? "ข้อมูลไม่ถูกต้อง");
      } else if (res.status === 409) {
        setConflict(true);
        setFormError(data.error ?? "มีคนจองตัดหน้าไปแล้ว");
      } else {
        setFormError(data.error ?? "ส่งข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
      }
    } catch {
      setFormError("เชื่อมต่อไม่ได้ กรุณาตรวจอินเทอร์เน็ตแล้วลองใหม่");
    } finally {
      setPending(false);
    }
  }

  const id = (name: string) => `${uid}-${name}`;
  const err = (name: FieldName) =>
    errors[name] ? (
      <p id={id(`${name}-err`)} role="alert" className="mt-1 text-sm text-accent">
        {errors[name]}
      </p>
    ) : null;
  const aria = (name: FieldName) => ({
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] ? id(`${name}-err`) : undefined,
  });

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-6">
      {demoMode ? (
        <div className="border border-rule p-4">
          <p className="text-sm text-muted">
            อย่าใส่ข้อมูลจริง — นี่คือร้านเดโม กรอกข้อมูลสมมติได้เลย หรือกดปุ่มด้านล่างให้กรอกให้
          </p>
          <button
            type="button"
            onClick={fillSample}
            className="tap meta meta-th mt-3 inline-flex items-center border border-ink px-4 text-ink hover:bg-ink hover:text-paper"
          >
            กรอกข้อมูลตัวอย่าง
          </button>
        </div>
      ) : null}

      <div>
        <label htmlFor={id("name")} className="meta meta-th mb-2 block">
          ชื่อ
        </label>
        <input
          id={id("name")}
          name="customerName"
          autoComplete="name"
          maxLength={100}
          value={customerName}
          onChange={(e) => setCustomerName(e.target.value)}
          className={FIELD_BASE}
          {...aria("customerName")}
        />
        {err("customerName")}
      </div>

      <div>
        <label htmlFor={id("phone")} className="meta meta-th mb-2 block">
          เบอร์โทร
        </label>
        <input
          id={id("phone")}
          name="phone"
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          placeholder="08x-xxx-xxxx"
          value={phone}
          onChange={(e) => setPhone(e.target.value)}
          className={FIELD_BASE}
          {...aria("phone")}
        />
        {err("phone")}
      </div>

      <fieldset>
        <legend className="meta meta-th mb-2">วิธีรับของ</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          {(
            [
              { value: "pickup", title: "นัดรับ", sub: "ฟรี" },
              { value: "post", title: "ส่งไปรษณีย์", sub: `+${formatPrice(calcShippingFee("post"))}` },
            ] as const
          ).map((opt) => (
            <label
              key={opt.value}
              className={`tap flex cursor-pointer items-center justify-between gap-3 border px-4 py-3 ${
                method === opt.value ? "border-ink bg-ink text-paper" : "border-rule text-ink"
              } has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-ink`}
            >
              <span className="flex items-center gap-3">
                <input
                  type="radio"
                  name="deliveryMethod"
                  value={opt.value}
                  checked={method === opt.value}
                  onChange={() => setMethod(opt.value)}
                  className="sr-only"
                />
                <span
                  aria-hidden="true"
                  className={`block h-4 w-4 border ${
                    method === opt.value ? "border-paper bg-paper" : "border-ink"
                  }`}
                />
                <span className="font-medium">{opt.title}</span>
              </span>
              <span className="meta meta-th !text-current">{opt.sub}</span>
            </label>
          ))}
        </div>
      </fieldset>

      {method === "post" ? (
        <div>
          <label htmlFor={id("address")} className="meta meta-th mb-2 block">
            ที่อยู่จัดส่ง
          </label>
          <textarea
            id={id("address")}
            name="address"
            rows={3}
            maxLength={500}
            autoComplete="street-address"
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            className={FIELD_BASE}
            {...aria("address")}
          />
          {err("address")}
        </div>
      ) : null}

      <div>
        <label htmlFor={id("note")} className="meta meta-th mb-2 block">
          หมายเหตุ (ไม่บังคับ)
        </label>
        <textarea
          id={id("note")}
          name="note"
          rows={2}
          maxLength={500}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          className={FIELD_BASE}
          {...aria("note")}
        />
        {err("note")}
      </div>

      <div className="border-t border-rule pt-4">
        <dl className="space-y-1 text-base">
          <div className="flex justify-between">
            <dt className="text-muted">ราคาสินค้า</dt>
            <dd>{formatPrice(price)}</dd>
          </div>
          <div className="flex justify-between">
            <dt className="text-muted">ค่าส่ง</dt>
            <dd>{shipping === 0 ? "ฟรี" : formatPrice(shipping)}</dd>
          </div>
          <div className="flex items-baseline justify-between border-t border-rule pt-2">
            <dt className="meta meta-th text-ink">ยอดรวม</dt>
            <dd className="display text-4xl">{formatPrice(total)}</dd>
          </div>
        </dl>
        <p className="mt-2 text-sm text-muted">
          ยอดนี้แสดงให้ดูเฉยๆ ราคาจริงคิดที่เซิร์ฟเวอร์จากราคาสินค้าในระบบ
        </p>
      </div>

      {formError ? (
        <div role="alert" className="border border-accent p-4 text-accent">
          <p>{formError}</p>
          {conflict ? (
            <Link
              href="/"
              className="tap mt-2 inline-flex items-center text-ink underline underline-offset-4"
            >
              ← กลับไปเลือกชิ้นอื่น
            </Link>
          ) : null}
        </div>
      ) : null}

      <button
        type="submit"
        disabled={pending}
        className="tap flex w-full items-center justify-center bg-accent px-6 py-3 text-base font-medium text-paper hover:opacity-90 disabled:opacity-60"
      >
        {pending ? "กำลังจอง…" : `ยืนยันการจอง · ${formatPrice(total)}`}
      </button>
      <p className="text-center text-sm text-muted">
        กดแล้วระบบจะจองสินค้าไว้ให้ 15 นาที เพื่อให้ชำระเงินและส่งสลิป
      </p>
    </form>
  );
}
