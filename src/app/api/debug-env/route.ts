/**
 * GET /api/debug-env — تشخيص مؤقت فقط (يُحذف بعد حل المشكلة):
 * يفحص قيمة TURSO_AUTH_TOKEN و TURSO_DATABASE_URL المخزنتين على Vercel
 * دون كشف الرمز كاملًا — يعرض الطول وأول/آخر 6 حروف وبصمة sha256 ومطابقتها للمطلوب.
 */
import { createHash } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EXPECTED_TOKEN_LENGTH = 348;
const EXPECTED_TOKEN_FIRST6 = "eyJhbG";
const EXPECTED_TOKEN_LAST6 = "bPRkBQ";
const EXPECTED_TOKEN_HASH12 = "49f6316181b7";
const EXPECTED_DB_URL = "libsql://workflow-workflow.aws-eu-west-1.turso.io";

export async function GET() {
  const tok = process.env.TURSO_AUTH_TOKEN ?? "";
  const url = process.env.TURSO_DATABASE_URL ?? "";
  const hash12 = createHash("sha256").update(tok).digest("hex").slice(0, 12);

  return Response.json({
    time: new Date().toISOString(),
    token: {
      present: tok.length > 0,
      length: tok.length,
      expectedLength: EXPECTED_TOKEN_LENGTH,
      lengthOk: tok.length === EXPECTED_TOKEN_LENGTH,
      first6: tok.slice(0, 6),
      last6: tok.slice(-6),
      hasWhitespace: /\s/.test(tok),
      hasNonAscii: /[^\x21-\x7e]/.test(tok),
      hash12,
      expectedHash12: EXPECTED_TOKEN_HASH12,
      tokenOk: hash12 === EXPECTED_TOKEN_HASH12,
    },
    databaseUrl: {
      value: url,
      expected: EXPECTED_DB_URL,
      urlOk: url === EXPECTED_DB_URL,
    },
  });
}
