/** state ที่ server action ของหลังบ้านคืนให้ useActionState (ข้อความไทย ไม่มีข้อมูลภายใน) */
export type ActionState = {
  ok?: boolean;
  error?: string;
  message?: string;
  /** ข้อความ error รายช่อง (ฟอร์มสินค้า) key = ชื่อช่อง */
  fieldErrors?: Record<string, string>;
};
export const INITIAL_ACTION_STATE: ActionState = {};
