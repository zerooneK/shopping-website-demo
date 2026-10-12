// `server-only` ถูก resolve โดย Next.js (next/dist/compiled/server-only) ตอน bundle
// ไม่มีแพ็กเกจแยกใน node_modules จึงประกาศ module ให้ TypeScript
declare module "server-only";
