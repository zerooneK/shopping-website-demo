/** state ที่ server action ของหลังบ้านคืนให้ useActionState (ข้อความไทย ไม่มีข้อมูลภายใน) */
export type ActionState = { ok?: boolean; error?: string; message?: string };
export const INITIAL_ACTION_STATE: ActionState = {};
